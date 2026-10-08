import type { GroupMetadata, GroupParticipant, WASocket } from "@whiskeysockets/baileys";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Keeps Group, GroupMember and GroupEvent in sync with WhatsApp.
 *
 * - Full metadata (initial sync, groups.upsert, manual resync) reconciles members:
 *   current participants become active with their role, missing ones become inactive.
 * - Participant events record joins/leaves/promotions with a timestamp (GroupEvent),
 *   which is what powers growth analytics.
 * - Group messages update each member's activity counters.
 */

/** "5561999@s.whatsapp.net", "5561999:12@s.whatsapp.net" -> "5561999@s.whatsapp.net" */
export function bareJid(jid: string | null | undefined): string {
    if (!jid) return "";
    const [user, server] = jid.split("@");
    return `${user.split(":")[0]}@${server ?? ""}`;
}

export function phoneFromJid(jid: string | null | undefined): string | null {
    if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
    return jid.split("@")[0].split(":")[0];
}

/** This number's own JIDs (phone and LID), without device suffix */
export function selfJids(sock: Pick<WASocket, "user">): Set<string> {
    const out = new Set<string>();
    if (sock.user?.id) out.add(bareJid(sock.user.id));
    const lid = (sock.user as { lid?: string } | undefined)?.lid;
    if (lid) out.add(bareJid(lid));
    return out;
}

function roleOf(p: GroupParticipant): string {
    if (p.admin === "superadmin" || p.isSuperAdmin) return "superadmin";
    if (p.admin === "admin" || p.isAdmin) return "admin";
    return "member";
}

/** Phone number of a participant: from the PN JID, or the phoneNumber field when addressed by LID */
function participantPhone(p: GroupParticipant): string | null {
    const pn = (p as { phoneNumber?: string }).phoneNumber;
    return phoneFromJid(p.id) || phoneFromJid(pn) || null;
}

async function dbSessionIdOf(sessionId: string): Promise<string | null> {
    const s = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
    return s?.id ?? null;
}

/**
 * Upsert a group from full metadata and reconcile its member list.
 * `recordEvents` adds join/leave events for differences (off for the very first sync,
 * when every member would otherwise look like a new join).
 */
export async function upsertGroupFromMetadata(
    dbSessionId: string,
    g: GroupMetadata,
    self: Set<string>,
    recordEvents = false
) {
    const participants = g.participants || [];
    const me = participants.find(p => self.has(bareJid(p.id)) || self.has(bareJid((p as { phoneNumber?: string }).phoneNumber)) || self.has(bareJid((p as { lid?: string }).lid)));

    const fields = {
        subject: g.subject,
        description: g.desc ?? null,
        ownerJid: g.owner ?? null,
        restrict: g.restrict ?? null,
        announce: g.announce ?? null,
        participants: participants as unknown as object,
        metadata: g as unknown as object,
        isCommunity: g.isCommunity || false,
        linkedParentJid: g.linkedParent || null,
        size: g.size ?? participants.length,
        myRole: me ? roleOf(me) : null,
        memberAddMode: g.memberAddMode ?? null,
        joinApprovalMode: g.joinApprovalMode ?? null,
        ephemeralDuration: g.ephemeralDuration ?? null,
    };

    const existing = await prisma.group.findUnique({ where: { sessionId_jid: { sessionId: dbSessionId, jid: g.id } }, select: { id: true } });
    await prisma.group.upsert({
        where: { sessionId_jid: { sessionId: dbSessionId, jid: g.id } },
        create: { sessionId: dbSessionId, jid: g.id, creation: g.creation ? new Date(g.creation * 1000) : undefined, ...fields },
        update: fields,
    });

    // Reconcile members
    const current = new Map(participants.map(p => [p.id, p]));
    const stored = await prisma.groupMember.findMany({
        where: { sessionId: dbSessionId, groupJid: g.id },
        select: { memberJid: true, isActive: true },
    });
    const storedActive = new Set(stored.filter(m => m.isActive).map(m => m.memberJid));
    const now = new Date();
    const firstSeen = !existing; // brand-new group row: don't fake join events

    for (const p of participants) {
        const wasActive = storedActive.has(p.id);
        await prisma.groupMember.upsert({
            where: { sessionId_groupJid_memberJid: { sessionId: dbSessionId, groupJid: g.id, memberJid: p.id } },
            create: {
                sessionId: dbSessionId, groupJid: g.id, memberJid: p.id, phone: participantPhone(p),
                name: p.notify || p.name || null, role: roleOf(p), isActive: true,
                joinedAt: recordEvents && !firstSeen ? now : null,
            },
            update: {
                role: roleOf(p), isActive: true, leftAt: null,
                ...(participantPhone(p) ? { phone: participantPhone(p) } : {}),
                ...(wasActive ? {} : { joinedAt: now }),
            },
        });
        if (recordEvents && !firstSeen && !wasActive) {
            await recordGroupEvent(dbSessionId, g.id, "join", p.id);
        }
    }

    const gone = [...storedActive].filter(j => !current.has(j));
    if (gone.length) {
        await prisma.groupMember.updateMany({
            where: { sessionId: dbSessionId, groupJid: g.id, memberJid: { in: gone } },
            data: { isActive: false, leftAt: now },
        });
        if (recordEvents) {
            for (const j of gone) await recordGroupEvent(dbSessionId, g.id, "leave", j);
        }
    }
}

export async function recordGroupEvent(
    dbSessionId: string, groupJid: string, type: string,
    memberJid?: string | null, actorJid?: string | null, details?: Record<string, unknown>
) {
    await prisma.groupEvent.create({
        data: { sessionId: dbSessionId, groupJid, type, memberJid: memberJid ?? null, actorJid: actorJid ?? null, details: details as object | undefined },
    }).catch(e => logger.error("Groups", "Failed to record group event", e));
}

/** Full sync of all groups the number participates in */
export async function syncAllGroups(sock: WASocket, sessionId: string, recordEvents = false) {
    const dbSessionId = await dbSessionIdOf(sessionId);
    if (!dbSessionId) return { synced: 0 };

    const groups = Object.values(await sock.groupFetchAllParticipating());
    const self = selfJids(sock);
    let synced = 0;
    for (const g of groups) {
        try {
            await upsertGroupFromMetadata(dbSessionId, g, self, recordEvents);
            synced++;
        } catch (e) {
            logger.error("Groups", `Failed to sync group ${g.id}`, e);
        }
    }

    // Groups we are no longer part of
    const ids = new Set(groups.map(g => g.id));
    const stale = await prisma.group.findMany({ where: { sessionId: dbSessionId, myRole: { not: null } }, select: { jid: true } });
    const left = stale.filter(s => !ids.has(s.jid)).map(s => s.jid);
    if (left.length) {
        await prisma.group.updateMany({ where: { sessionId: dbSessionId, jid: { in: left } }, data: { myRole: null } });
    }

    logger.success("Groups", `Synced ${synced} groups for session ${sessionId}`);
    return { synced, left: left.length };
}

/** Refresh one group from WhatsApp */
export async function syncGroup(sock: WASocket, sessionId: string, groupJid: string, recordEvents = true) {
    const dbSessionId = await dbSessionIdOf(sessionId);
    if (!dbSessionId) return null;
    const g = await sock.groupMetadata(groupJid);
    await upsertGroupFromMetadata(dbSessionId, g, selfJids(sock), recordEvents);
    return g;
}

/** group-participants.update */
export async function handleParticipantsUpdate(
    sock: WASocket, sessionId: string,
    update: { id: string; author?: string; participants: (GroupParticipant | string)[]; action: string }
) {
    const dbSessionId = await dbSessionIdOf(sessionId);
    if (!dbSessionId) return;
    const now = new Date();
    const actor = update.author || null;

    for (const raw of update.participants) {
        const p: GroupParticipant = typeof raw === "string" ? ({ id: raw } as GroupParticipant) : raw;
        const memberJid = p.id;
        const key = { sessionId_groupJid_memberJid: { sessionId: dbSessionId, groupJid: update.id, memberJid } };

        if (update.action === "add") {
            await prisma.groupMember.upsert({
                where: key,
                create: { sessionId: dbSessionId, groupJid: update.id, memberJid, phone: participantPhone(p), name: p.notify || null, role: "member", isActive: true, joinedAt: now },
                update: { isActive: true, leftAt: null, joinedAt: now },
            });
            await recordGroupEvent(dbSessionId, update.id, "join", memberJid, actor);
        } else if (update.action === "remove") {
            await prisma.groupMember.updateMany({ where: { sessionId: dbSessionId, groupJid: update.id, memberJid }, data: { isActive: false, leftAt: now } });
            const selfLeft = !actor || bareJid(actor) === bareJid(memberJid);
            await recordGroupEvent(dbSessionId, update.id, selfLeft ? "leave" : "removed", memberJid, actor);
        } else if (update.action === "promote" || update.action === "demote") {
            await prisma.groupMember.updateMany({
                where: { sessionId: dbSessionId, groupJid: update.id, memberJid },
                data: { role: update.action === "promote" ? "admin" : "member" },
            });
            await recordGroupEvent(dbSessionId, update.id, update.action, memberJid, actor);
        }
    }

    // Our own role, size and the participants JSON come from fresh metadata
    syncGroup(sock, sessionId, update.id, false).catch(e => logger.debug("Groups", "Metadata refresh after participants update failed", e));
}

/** groups.upsert: this number joined (or created) a group */
export async function handleGroupsUpsert(sock: WASocket, sessionId: string, groups: GroupMetadata[]) {
    const dbSessionId = await dbSessionIdOf(sessionId);
    if (!dbSessionId) return;
    const self = selfJids(sock);
    for (const g of groups) {
        try {
            await upsertGroupFromMetadata(dbSessionId, g, self, false);
        } catch (e) {
            logger.error("Groups", `Failed to store new group ${g.id}`, e);
        }
    }
}

/** group.join-request */
export async function handleJoinRequest(
    sessionId: string,
    req: { id: string; author?: string; participant: string; participantPn?: string; action: string; method?: string }
) {
    const dbSessionId = await dbSessionIdOf(sessionId);
    if (!dbSessionId) return;
    await recordGroupEvent(dbSessionId, req.id, "join_request", req.participant, req.author, {
        action: req.action, method: req.method ?? null, participantPn: req.participantPn ?? null,
    });
}

/** Count a group message towards the sender's activity */
export async function recordGroupMessage(dbSessionId: string, groupJid: string, senderJid: string | null | undefined, pushName: string | null | undefined, at: Date) {
    await prisma.group.updateMany({ where: { sessionId: dbSessionId, jid: groupJid }, data: { lastActivityAt: at } });
    if (!senderJid) return;
    const memberJid = senderJid;
    await prisma.groupMember.upsert({
        where: { sessionId_groupJid_memberJid: { sessionId: dbSessionId, groupJid, memberJid } },
        create: { sessionId: dbSessionId, groupJid, memberJid, phone: phoneFromJid(memberJid), name: pushName || null, isActive: true, messageCount: 1, lastMessageAt: at },
        update: { messageCount: { increment: 1 }, lastMessageAt: at, ...(pushName ? { name: pushName } : {}) },
    });
}
