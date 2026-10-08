import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { waManager } from "@/modules/whatsapp/manager";
import { syncGroup } from "./sync";
import { GroupError, dbSession, updateGroupInfo } from "./service";

/**
 * Smart group links (a.k.a. group redirector / "link rotativo").
 *
 * GET /g/{slug} picks the next group with room and redirects to its invite link. When every
 * group is full it can create the next one automatically ("Turma #4"). Clicks are recorded
 * with UTM parameters so traffic sources (ads, bio, e-mail) can be compared.
 */

export interface LinkInput {
    name: string;
    slug?: string;
    groupJids: string[];
    maxMembers?: number;
    strategy?: "fill" | "balance";
    autoCreate?: boolean;
    autoCreateName?: string;
    autoCreateTags?: string[];
    fallbackUrl?: string | null;
    active?: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

function makeSlug(name: string): string {
    const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "grupo";
    return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

export function publicLinkUrl(slug: string): string {
    const base = (process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    return `${base}/g/${slug}`;
}

function jids(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function createLink(sessionId: string, input: LinkInput) {
    const s = await dbSession(sessionId);
    const slug = (input.slug || makeSlug(input.name)).toLowerCase();
    if (!SLUG_RE.test(slug)) throw new GroupError("slug must be 2-49 chars: lowercase letters, numbers and dashes");
    if (await prisma.groupLink.findUnique({ where: { slug } })) throw new GroupError(`slug "${slug}" is already in use`, 409);
    const link = await prisma.groupLink.create({
        data: {
            sessionId: s.id, slug, name: input.name, groupJids: input.groupJids,
            maxMembers: Math.min(input.maxMembers ?? 1000, 1024), strategy: input.strategy ?? "fill",
            autoCreate: !!input.autoCreate, autoCreateName: input.autoCreateName ?? null,
            autoCreateTags: input.autoCreateTags ?? undefined, fallbackUrl: input.fallbackUrl ?? null,
            active: input.active ?? true,
        },
    });
    return { ...link, url: publicLinkUrl(link.slug) };
}

export async function updateLink(sessionId: string, id: string, input: Partial<LinkInput>) {
    const s = await dbSession(sessionId);
    const existing = await prisma.groupLink.findFirst({ where: { id, sessionId: s.id } });
    if (!existing) throw new GroupError("Link not found", 404);
    const link = await prisma.groupLink.update({
        where: { id },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.groupJids !== undefined ? { groupJids: input.groupJids } : {}),
            ...(input.maxMembers !== undefined ? { maxMembers: Math.min(input.maxMembers, 1024) } : {}),
            ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
            ...(input.autoCreate !== undefined ? { autoCreate: input.autoCreate } : {}),
            ...(input.autoCreateName !== undefined ? { autoCreateName: input.autoCreateName } : {}),
            ...(input.autoCreateTags !== undefined ? { autoCreateTags: input.autoCreateTags } : {}),
            ...(input.fallbackUrl !== undefined ? { fallbackUrl: input.fallbackUrl } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
        },
    });
    return { ...link, url: publicLinkUrl(link.slug) };
}

export async function deleteLink(sessionId: string, id: string) {
    const s = await dbSession(sessionId);
    const res = await prisma.groupLink.deleteMany({ where: { id, sessionId: s.id } });
    if (!res.count) throw new GroupError("Link not found", 404);
    await prisma.groupLinkClick.deleteMany({ where: { linkId: id } });
}

/** Links of a session with live status of each group and click stats */
export async function listLinks(sessionId: string) {
    const s = await dbSession(sessionId);
    const links = await prisma.groupLink.findMany({ where: { sessionId: s.id }, orderBy: { createdAt: "desc" } });
    const out = [];
    for (const l of links) {
        const groupJids = jids(l.groupJids);
        const groups = await prisma.group.findMany({ where: { sessionId: s.id, jid: { in: groupJids } }, select: { jid: true, subject: true, size: true, myRole: true } });
        const perGroup = await prisma.groupLinkClick.groupBy({ by: ["groupJid"], where: { linkId: l.id }, _count: { _all: true } });
        const bySource = await prisma.groupLinkClick.groupBy({ by: ["utmSource"], where: { linkId: l.id }, _count: { _all: true } });
        out.push({
            ...l,
            url: publicLinkUrl(l.slug),
            groups: groupJids.map(j => {
                const g = groups.find(x => x.jid === j);
                return {
                    jid: j, subject: g?.subject ?? null, size: g?.size ?? null,
                    full: (g?.size ?? 0) >= l.maxMembers, usable: !!g && (g.myRole === "admin" || g.myRole === "superadmin"),
                    clicks: perGroup.find(p => p.groupJid === j)?._count._all ?? 0,
                };
            }),
            clicksBySource: bySource.map(b => ({ source: b.utmSource ?? "(direct)", clicks: b._count._all })),
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Public redirect
// ---------------------------------------------------------------------------

async function inviteCodeFor(sessionId: string, dbSessionId: string, groupJid: string, cached: string | null): Promise<string | null> {
    if (cached) return cached;
    const sock = waManager.getInstance(sessionId)?.socket;
    if (!sock) return null;
    const code = await sock.groupInviteCode(groupJid).catch(() => undefined);
    if (code) await prisma.group.updateMany({ where: { sessionId: dbSessionId, jid: groupJid }, data: { inviteCode: code } });
    return code ?? null;
}

async function autoCreateGroup(link: { id: string; name: string; autoCreateName: string | null; autoCreateTags: unknown; groupJids: unknown }, sessionId: string) {
    const sock = waManager.getInstance(sessionId)?.socket;
    if (!sock) return null;
    const n = jids(link.groupJids).length + 1;
    const subject = (link.autoCreateName || "{{name}} #{{n}}").replace(/\{\{\s*name\s*\}\}/g, link.name).replace(/\{\{\s*n\s*\}\}/g, String(n)).slice(0, 100);
    const g = await sock.groupCreate(subject, []);
    await syncGroup(sock, sessionId, g.id, false).catch(() => {});
    const tags = jids(link.autoCreateTags);
    if (tags.length) await updateGroupInfo(sessionId, g.id, { tags }).catch(() => {});
    await prisma.groupLink.update({ where: { id: link.id }, data: { groupJids: [...jids(link.groupJids), g.id] } });
    logger.info("Groups", `Smart link "${link.name}": all groups full, created "${subject}" (${g.id})`);
    return g.id;
}

export interface ClickInfo { utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; utmContent?: string | null; referrer?: string | null }

/** Resolve a click to a WhatsApp invite URL (or the fallback). Returns null if the link doesn't exist. */
export async function resolveLinkClick(slug: string, click: ClickInfo): Promise<{ url: string; groupJid: string | null } | null> {
    const link = await prisma.groupLink.findUnique({ where: { slug } });
    if (!link || !link.active) return null;
    const session = await prisma.session.findUnique({ where: { id: link.sessionId }, select: { sessionId: true } });
    if (!session) return null;

    const order = jids(link.groupJids);
    const groups = await prisma.group.findMany({
        where: { sessionId: link.sessionId, jid: { in: order }, myRole: { in: ["admin", "superadmin"] } },
        select: { jid: true, size: true, inviteCode: true },
    });
    let candidates = order.map(j => groups.find(g => g.jid === j)).filter((g): g is NonNullable<typeof g> => !!g && (g.size ?? 0) < link.maxMembers);
    if (link.strategy === "balance") candidates = [...candidates].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));

    let target: { jid: string; code: string } | null = null;
    for (const g of candidates) {
        const code = await inviteCodeFor(session.sessionId, link.sessionId, g.jid, g.inviteCode);
        if (code) { target = { jid: g.jid, code }; break; }
    }

    if (!target && link.autoCreate) {
        try {
            const jid = await autoCreateGroup(link, session.sessionId);
            const code = jid ? await inviteCodeFor(session.sessionId, link.sessionId, jid, null) : null;
            if (jid && code) target = { jid, code };
        } catch (e) {
            logger.error("Groups", `Smart link "${link.name}": auto-create failed`, e);
        }
    }

    await prisma.groupLinkClick.create({
        data: {
            linkId: link.id, groupJid: target?.jid ?? null,
            utmSource: click.utmSource?.slice(0, 100) ?? null, utmMedium: click.utmMedium?.slice(0, 100) ?? null,
            utmCampaign: click.utmCampaign?.slice(0, 100) ?? null, utmContent: click.utmContent?.slice(0, 100) ?? null,
            referrer: click.referrer?.slice(0, 500) ?? null,
        },
    }).catch(e => logger.error("Groups", "Failed to record link click", e));
    await prisma.groupLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 } } }).catch(() => {});

    if (target) return { url: `https://chat.whatsapp.com/${target.code}`, groupJid: target.jid };
    if (link.fallbackUrl) return { url: link.fallbackUrl, groupJid: null };
    return { url: "", groupJid: null };
}
