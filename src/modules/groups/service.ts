import type { WASocket } from "@whiskeysockets/baileys";
import { prisma } from "@/lib/prisma";
import { resolveRecipientJid } from "@/lib/jid-utils";
import { waManager } from "@/modules/whatsapp/manager";
import { ChatService } from "@/modules/whatsapp/chat.service";
import { syncAllGroups, syncGroup, recordGroupEvent, bareJid } from "./sync";

/**
 * Group operations shared by the REST API, the MCP server and automations.
 * Throws GroupError with an HTTP-ish status for expected failures.
 */

export class GroupError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

export function connectedSocket(sessionId: string): WASocket {
    const instance = waManager.getInstance(sessionId);
    if (!instance?.socket || instance.status !== "CONNECTED") {
        throw new GroupError(`WhatsApp number "${sessionId}" is not connected`, 503);
    }
    return instance.socket;
}

export async function dbSession(sessionId: string) {
    const s = await prisma.session.findFirst({ where: { OR: [{ sessionId }, { id: sessionId }] }, select: { id: true, sessionId: true } });
    if (!s) throw new GroupError("Session not found", 404);
    return s;
}

export function assertGroupJid(jid: string): string {
    const j = decodeURIComponent(jid);
    if (!j.endsWith("@g.us")) throw new GroupError(`"${j}" is not a group JID (…@g.us)`);
    return j;
}

/** Turn phones / JIDs into participant JIDs WhatsApp accepts */
async function toParticipantJids(sock: WASocket, inputs: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const i of inputs) {
        if (/@(s\.whatsapp\.net|lid)$/.test(i)) out.push(i);
        else out.push(await resolveRecipientJid(sock, i));
    }
    return out;
}

async function requireAdmin(dbSessionId: string, groupJid: string) {
    const g = await prisma.group.findUnique({ where: { sessionId_jid: { sessionId: dbSessionId, jid: groupJid } }, select: { myRole: true } });
    if (!g) throw new GroupError("Group not found for this number (try a sync)", 404);
    if (g.myRole !== "admin" && g.myRole !== "superadmin") {
        throw new GroupError("This number is not an admin of the group", 403);
    }
}

function parseTags(tags: unknown): string[] {
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface GroupListFilter {
    search?: string;
    tag?: string;
    adminOnly?: boolean;
    includeLeft?: boolean;
    communities?: "only" | "exclude";
    sort?: "name" | "size" | "activity";
}

export async function listGroups(sessionId: string, f: GroupListFilter = {}) {
    const s = await dbSession(sessionId);
    const where: Record<string, unknown> = { sessionId: s.id };
    if (!f.includeLeft) where.myRole = { not: null };
    if (f.adminOnly) where.myRole = { in: ["admin", "superadmin"] };
    if (f.search) where.subject = { contains: f.search };
    if (f.communities === "only") where.isCommunity = true;
    if (f.communities === "exclude") where.isCommunity = false;

    const orderBy = f.sort === "size" ? { size: "desc" as const }
        : f.sort === "activity" ? { lastActivityAt: "desc" as const }
        : { subject: "asc" as const };

    const groups = await prisma.group.findMany({
        where, orderBy,
        select: {
            jid: true, subject: true, description: true, size: true, myRole: true, tags: true, notes: true,
            announce: true, restrict: true, memberAddMode: true, joinApprovalMode: true, ephemeralDuration: true,
            isCommunity: true, linkedParentJid: true, lastActivityAt: true, creation: true, inviteCode: true,
        },
    });

    return groups
        .map(g => ({ ...g, tags: parseTags(g.tags), isAdmin: g.myRole === "admin" || g.myRole === "superadmin", inGroup: g.myRole !== null }))
        .filter(g => !f.tag || g.tags.includes(f.tag));
}

/** Distinct tags in use, with counts */
export async function listGroupTags(sessionId: string) {
    const groups = await listGroups(sessionId);
    const counts = new Map<string, number>();
    for (const g of groups) for (const t of g.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Resolve a target selection to group JIDs this number is in */
export async function resolveGroupTargets(sessionId: string, target: { all?: boolean; tags?: string[]; jids?: string[]; adminOnly?: boolean }) {
    const groups = await listGroups(sessionId, { adminOnly: target.adminOnly });
    const selected = new Set<string>();
    for (const g of groups) {
        if (target.all) selected.add(g.jid);
        if (target.tags?.some(t => g.tags.includes(t))) selected.add(g.jid);
        if (target.jids?.includes(g.jid)) selected.add(g.jid);
    }
    return groups.filter(g => selected.has(g.jid));
}

export async function listMembers(sessionId: string, groupJid: string, f: { status?: "active" | "left" | "all"; role?: string; search?: string; inactiveDays?: number; sort?: "activity" | "messages" | "joined" | "name" } = {}) {
    const s = await dbSession(sessionId);
    const where: Record<string, unknown> = { sessionId: s.id, groupJid };
    if ((f.status ?? "active") === "active") where.isActive = true;
    if (f.status === "left") where.isActive = false;
    if (f.role) where.role = f.role;
    if (f.search) where.OR = [{ name: { contains: f.search } }, { phone: { contains: f.search.replace(/\D/g, "") || f.search } }];
    if (f.inactiveDays) {
        const cutoff = new Date(Date.now() - f.inactiveDays * 86400000);
        where.AND = [{ OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: cutoff } }] }];
    }
    const orderBy = f.sort === "messages" ? { messageCount: "desc" as const }
        : f.sort === "joined" ? { joinedAt: "desc" as const }
        : f.sort === "name" ? { name: "asc" as const }
        : { lastMessageAt: "desc" as const };
    return prisma.groupMember.findMany({
        where, orderBy,
        select: { memberJid: true, phone: true, name: true, role: true, isActive: true, joinedAt: true, leftAt: true, messageCount: true, lastMessageAt: true, warnings: true },
    });
}

export async function getGroup(sessionId: string, groupJid: string) {
    const s = await dbSession(sessionId);
    const g = await prisma.group.findUnique({ where: { sessionId_jid: { sessionId: s.id, jid: groupJid } } });
    if (!g) throw new GroupError("Group not found for this number (try a sync)", 404);
    const [active, admins] = await Promise.all([
        prisma.groupMember.count({ where: { sessionId: s.id, groupJid, isActive: true } }),
        prisma.groupMember.count({ where: { sessionId: s.id, groupJid, isActive: true, role: { in: ["admin", "superadmin"] } } }),
    ]);
    const { metadata: _m, participants: _p, ...rest } = g;
    return { ...rest, tags: parseTags(g.tags), counts: { active, admins } };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function resync(sessionId: string, groupJid?: string) {
    const sock = connectedSocket(sessionId);
    if (groupJid) {
        await syncGroup(sock, sessionId, groupJid, true);
        return { synced: 1 };
    }
    return syncAllGroups(sock, sessionId, true);
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

export async function createGroup(sessionId: string, subject: string, participants: string[], opts: { description?: string; tags?: string[]; announce?: boolean } = {}) {
    const sock = connectedSocket(sessionId);
    const jids = await toParticipantJids(sock, participants);
    const g = await sock.groupCreate(subject, jids);
    if (opts.description) await sock.groupUpdateDescription(g.id, opts.description);
    if (opts.announce) await sock.groupSettingUpdate(g.id, "announcement");
    await syncGroup(sock, sessionId, g.id, false);
    if (opts.tags?.length) await updateGroupInfo(sessionId, g.id, { tags: opts.tags });
    return { jid: g.id, subject: g.subject };
}

/** Local organization fields (not sent to WhatsApp) */
export async function updateGroupInfo(sessionId: string, groupJid: string, data: { tags?: string[]; notes?: string | null }) {
    const s = await dbSession(sessionId);
    const tags = data.tags?.map(t => t.trim().toLowerCase()).filter(Boolean);
    const res = await prisma.group.updateMany({
        where: { sessionId: s.id, jid: groupJid },
        data: { ...(tags ? { tags: [...new Set(tags)] } : {}), ...(data.notes !== undefined ? { notes: data.notes } : {}) },
    });
    if (!res.count) throw new GroupError("Group not found for this number", 404);
}

export async function updateGroupSettings(sessionId: string, groupJid: string, data: {
    subject?: string; description?: string; announce?: boolean; restrict?: boolean;
    memberAddMode?: "admin_add" | "all_member_add"; joinApprovalMode?: boolean; ephemeralSeconds?: number;
}) {
    const sock = connectedSocket(sessionId);
    const s = await dbSession(sessionId);
    await requireAdmin(s.id, groupJid);
    if (data.subject !== undefined) await sock.groupUpdateSubject(groupJid, data.subject);
    if (data.description !== undefined) await sock.groupUpdateDescription(groupJid, data.description || undefined);
    if (data.announce !== undefined) await sock.groupSettingUpdate(groupJid, data.announce ? "announcement" : "not_announcement");
    if (data.restrict !== undefined) await sock.groupSettingUpdate(groupJid, data.restrict ? "locked" : "unlocked");
    if (data.memberAddMode !== undefined) await sock.groupMemberAddMode(groupJid, data.memberAddMode);
    if (data.joinApprovalMode !== undefined) await sock.groupJoinApprovalMode(groupJid, data.joinApprovalMode ? "on" : "off");
    if (data.ephemeralSeconds !== undefined) await sock.groupToggleEphemeral(groupJid, data.ephemeralSeconds);
    await syncGroup(sock, sessionId, groupJid, false);
}

export type MemberAction = "add" | "remove" | "promote" | "demote";

export async function updateMembers(sessionId: string, groupJid: string, action: MemberAction, participants: string[]) {
    const sock = connectedSocket(sessionId);
    const s = await dbSession(sessionId);
    await requireAdmin(s.id, groupJid);
    const jids = await toParticipantJids(sock, participants);
    const result = await sock.groupParticipantsUpdate(groupJid, jids, action);
    return result.map(r => ({ jid: r.jid, status: r.status, ok: String(r.status) === "200" }));
}

/** Apply a member action across many groups (e.g. ban someone from every group) */
export async function updateMembersInGroups(sessionId: string, groupJids: string[], action: MemberAction, participants: string[]) {
    const results = [];
    for (const g of groupJids) {
        try {
            results.push({ group: g, results: await updateMembers(sessionId, g, action, participants) });
        } catch (e) {
            results.push({ group: g, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return results;
}

export async function getInviteLink(sessionId: string, groupJid: string, revoke = false) {
    const sock = connectedSocket(sessionId);
    const code = revoke ? await sock.groupRevokeInvite(groupJid) : await sock.groupInviteCode(groupJid);
    const s = await dbSession(sessionId);
    await prisma.group.updateMany({ where: { sessionId: s.id, jid: groupJid }, data: { inviteCode: code ?? null } });
    return { code, link: code ? `https://chat.whatsapp.com/${code}` : null };
}

export async function listJoinRequests(sessionId: string, groupJid: string) {
    const sock = connectedSocket(sessionId);
    const list = await sock.groupRequestParticipantsList(groupJid);
    return list.map(r => ({ jid: String(r.jid ?? ""), phone: (r as { phone_number?: string }).phone_number ?? null, requestedAt: r.request_time ? new Date(Number(r.request_time) * 1000) : null, method: r.request_method ?? null }));
}

export async function answerJoinRequests(sessionId: string, groupJid: string, action: "approve" | "reject", participants?: string[]) {
    const sock = connectedSocket(sessionId);
    const s = await dbSession(sessionId);
    await requireAdmin(s.id, groupJid);
    const targets = participants?.length ? participants : (await listJoinRequests(sessionId, groupJid)).map(r => r.jid);
    if (!targets.length) return [];
    const res = await sock.groupRequestParticipantsUpdate(groupJid, targets, action);
    for (const t of targets) await recordGroupEvent(s.id, groupJid, `join_request_${action}d`, t);
    return res;
}

export async function leaveGroup(sessionId: string, groupJid: string) {
    const sock = connectedSocket(sessionId);
    await sock.groupLeave(groupJid);
    const s = await dbSession(sessionId);
    await prisma.group.updateMany({ where: { sessionId: s.id, jid: groupJid }, data: { myRole: null } });
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** JIDs of the active members, to mention everyone */
export async function activeMemberJids(sessionId: string, groupJid: string): Promise<string[]> {
    const s = await dbSession(sessionId);
    const members = await prisma.groupMember.findMany({ where: { sessionId: s.id, groupJid, isActive: true }, select: { memberJid: true } });
    if (members.length) return members.map(m => m.memberJid);
    const sock = connectedSocket(sessionId);
    const meta = await sock.groupMetadata(groupJid);
    return meta.participants.map(p => p.id);
}

/**
 * Send to a group. mentionAll notifies every member; "hidden" mentions (default) don't
 * add @names to the text, which is how most group tools do "@todos".
 */
export async function sendToGroup(sessionId: string, groupJid: string, content: {
    text?: string; media?: { type: "image" | "video" | "document" | "audio"; url: string; fileName?: string };
    mentionAll?: boolean; mentions?: string[]; replyToMessageId?: string;
}) {
    connectedSocket(sessionId);
    const payload: Record<string, unknown> = {};
    if (content.media) {
        payload[content.media.type] = { url: content.media.url };
        if (content.text && content.media.type !== "audio") payload.caption = content.text;
        if (content.media.type === "document") {
            payload.fileName = content.media.fileName || content.media.url.split("?")[0].split("/").pop() || "file";
            payload.mimetype = "application/octet-stream";
        }
        if (content.media.type === "audio") payload.mimetype = "audio/mp4";
    } else {
        if (!content.text?.trim()) throw new GroupError("text or media is required");
        payload.text = content.text;
    }

    let mentions = content.mentions ?? [];
    if (content.mentionAll) {
        const sock = connectedSocket(sessionId);
        const self = new Set([bareJid(sock.user?.id), bareJid((sock.user as { lid?: string } | undefined)?.lid)]);
        mentions = (await activeMemberJids(sessionId, groupJid)).filter(j => !self.has(bareJid(j)));
    }
    if (mentions.length) payload.mentions = mentions;

    const result = await ChatService.sendTextMessage(sessionId, groupJid, payload, mentions.length ? mentions : undefined, content.replyToMessageId);
    return { sent: true, messageId: result?.key?.id ?? null, mentioned: mentions.length };
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

export async function createCommunity(sessionId: string, subject: string, description: string) {
    const sock = connectedSocket(sessionId);
    const c = await sock.communityCreate(subject, description);
    if (!c) throw new GroupError("WhatsApp did not create the community", 502);
    await syncGroup(sock, sessionId, c.id, false).catch(() => {});
    return { jid: c.id, subject: c.subject };
}

export async function linkToCommunity(sessionId: string, communityJid: string, groupJid: string, unlink = false) {
    const sock = connectedSocket(sessionId);
    if (unlink) await sock.communityUnlinkGroup(groupJid, communityJid);
    else await sock.communityLinkGroup(groupJid, communityJid);
    await syncGroup(sock, sessionId, groupJid, false).catch(() => {});
}
