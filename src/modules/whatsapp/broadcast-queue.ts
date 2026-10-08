import { prisma } from "@/lib/prisma";
import type { BroadcastLog } from "@prisma/client";
import type { Server } from "socket.io";
import { logger } from "@/lib/logger";
import { resolveRecipientJid, normalizePhoneDigits } from "@/lib/jid-utils";
import { waManager } from "./manager";
import { ChatService } from "./chat.service";
import { activeMemberJids } from "@/modules/groups/service";
import { bareJid } from "@/modules/groups/sync";

/**
 * Persistent broadcast queue.
 *
 * Campaigns (BroadcastLog) and their recipients live in the database, so they
 * survive restarts. API routes only create campaigns and flip their status
 * (running / paused / cancelled); this worker, running inside the custom
 * server process, does all the sending.
 *
 * Safety rules, applied per WhatsApp number (session), across all campaigns:
 *  - one message at a time, with a randomized delay between messages
 *  - only inside the allowed hours window (system timezone)
 *  - a daily cap on total messages and a lower daily cap on *new chats*
 *    (people who never wrote to us), which are what trigger WhatsApp restrictions
 *  - recipients who already talked to us are sent first
 *  - campaigns are paused automatically when WhatsApp reports error 463
 */

export type BroadcastMedia = { type: "image" | "video" | "document"; url: string; fileName?: string };
export type BroadcastRecipientInput = string | { jid?: string; phone?: string; number?: string; variables?: Record<string, string> };

export interface BroadcastLimits {
    dailyLimit: number;
    newChatDailyLimit: number;
    hoursStart: number; // inclusive, 0-23
    hoursEnd: number;   // exclusive, 1-24
}

const TICK_MS = 1000;
const MIN_DELAY_MS = 5000;
const DEFAULT_DELAY_MS = 12000;

const nextAllowedAt = new Map<string, number>();
const busySessions = new Set<string>();
const lastNote = new Map<string, string>();
let ticking = false;
let started = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
    const v = parseInt(process.env[name] || "", 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function parseHours(value: string | undefined): [number, number] {
    const m = (value || "").match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) return [8, 20];
    const start = Math.min(23, parseInt(m[1], 10));
    const end = Math.min(24, parseInt(m[2], 10));
    return end > start ? [start, end] : [8, 20];
}

/** Limits from env, overridable per session via Session.config.broadcast */
export async function getBroadcastLimits(sessionId: string): Promise<BroadcastLimits> {
    const [envStart, envEnd] = parseHours(process.env.BROADCAST_HOURS);
    const limits: BroadcastLimits = {
        dailyLimit: envInt("BROADCAST_DAILY_LIMIT", 500),
        newChatDailyLimit: envInt("BROADCAST_NEW_CHAT_DAILY_LIMIT", 30),
        hoursStart: envStart,
        hoursEnd: envEnd,
    };

    const session = await prisma.session.findUnique({ where: { sessionId }, select: { config: true } });
    const cfg = (session?.config as { broadcast?: { dailyLimit?: number; newChatDailyLimit?: number; hours?: string } } | null)?.broadcast;
    if (cfg && typeof cfg === "object") {
        if (typeof cfg.dailyLimit === "number" && Number.isFinite(cfg.dailyLimit)) limits.dailyLimit = cfg.dailyLimit;
        if (typeof cfg.newChatDailyLimit === "number" && Number.isFinite(cfg.newChatDailyLimit)) limits.newChatDailyLimit = cfg.newChatDailyLimit;
        if (typeof cfg.hours === "string") [limits.hoursStart, limits.hoursEnd] = parseHours(cfg.hours);
    }
    return limits;
}

let tzCache: { tz: string; at: number } | null = null;
async function getTimezone(): Promise<string> {
    if (tzCache && Date.now() - tzCache.at < 60_000) return tzCache.tz;
    const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { timezone: true } }).catch(() => null);
    const tz = cfg?.timezone || process.env.TZ || "America/Sao_Paulo";
    tzCache = { tz, at: Date.now() };
    return tz;
}

/** Current hour and the UTC instant of local midnight in the given timezone */
function localClock(tz: string): { hour: number; startOfDay: Date } {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value || "0", 10);
    const hour = get("hour") % 24;
    const secondsSinceMidnight = hour * 3600 + get("minute") * 60 + get("second");
    return { hour, startOfDay: new Date(now.getTime() - secondsSinceMidnight * 1000 - now.getMilliseconds()) };
}

// ---------------------------------------------------------------------------
// Campaign creation
// ---------------------------------------------------------------------------

function recipientToEntry(r: BroadcastRecipientInput): { jid: string; variables?: Record<string, string> } | null {
    if (typeof r === "string") return r.trim() ? { jid: r.trim() } : null;
    const jid = (r.jid || r.phone || r.number || "").toString().trim();
    if (!jid) return null;
    return { jid, variables: r.variables };
}

/** Phone-number JID variants (with/without Brazilian 9th digit) used to look up chat history */
export function phoneJidVariants(input: string): string[] {
    if (/@(g\.us|lid|broadcast|newsletter)$/.test(input)) return [input];
    const digits = normalizePhoneDigits(input);
    if (!digits) return [];
    const out = new Set([digits]);
    if (digits.startsWith("55")) {
        const ddd = digits.slice(2, 4);
        const local = digits.slice(4);
        if (local.length === 9 && local.startsWith("9")) out.add(`55${ddd}${local.slice(1)}`);
        if (local.length === 8) out.add(`55${ddd}9${local}`);
    }
    return [...out].map(d => `${d}@s.whatsapp.net`);
}

/** Which of the given recipients have ever written to this session (they are safe to message) */
async function findRecipientsWithChat(sessionId: string, jids: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    const dbSession = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
    if (!dbSession) return result;

    const variantToInput = new Map<string, string>();
    for (const jid of jids) for (const v of phoneJidVariants(jid)) variantToInput.set(v, jid);
    const variants = [...variantToInput.keys()];

    for (let i = 0; i < variants.length; i += 500) {
        const chunk = variants.slice(i, i + 500);
        const rows = await prisma.message.findMany({
            where: { sessionId: dbSession.id, fromMe: false, remoteJid: { in: chunk } },
            select: { remoteJid: true },
            distinct: ["remoteJid"],
        });
        for (const row of rows) {
            const input = variantToInput.get(row.remoteJid);
            if (input) result.add(input);
        }
    }
    return result;
}

export async function createBroadcastCampaign(params: {
    sessionId: string;
    recipients: BroadcastRecipientInput[];
    message: string;
    media?: BroadcastMedia;
    delay?: number;
    name?: string;
    scheduledAt?: Date | null;
    mentionAll?: boolean;
    respectHours?: boolean;
    sequenceId?: string;
}) {
    const entries = params.recipients.map(recipientToEntry).filter((e): e is NonNullable<typeof e> => !!e);
    const isGroupCampaign = entries.length > 0 && entries.every(e => e.jid.endsWith("@g.us"));

    // De-duplicate by normalized number
    const seen = new Set<string>();
    const unique = entries.filter(e => {
        const key = phoneJidVariants(e.jid)[0] || e.jid;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Groups we are in are never "new chats"
    const withChat = await findRecipientsWithChat(params.sessionId, unique.map(e => e.jid));
    for (const e of unique) if (e.jid.endsWith("@g.us")) withChat.add(e.jid);
    const delay = Math.max(MIN_DELAY_MS, params.delay ?? DEFAULT_DELAY_MS);
    const respectHours = params.respectHours ?? !isGroupCampaign;

    const log = await prisma.broadcastLog.create({
        data: {
            sessionId: params.sessionId,
            message: params.message,
            mediaUrl: params.media?.url,
            mediaType: params.media?.type,
            fileName: params.media?.fileName,
            total: unique.length,
            delay,
            status: "running",
            name: params.name,
            kind: isGroupCampaign ? "groups" : "contacts",
            scheduledAt: params.scheduledAt ?? null,
            mentionAll: !!params.mentionAll,
            respectHours,
            sequenceId: params.sequenceId,
        },
    });

    for (let i = 0; i < unique.length; i += 1000) {
        await prisma.broadcastRecipient.createMany({
            data: unique.slice(i, i + 1000).map(e => ({
                broadcastLogId: log.id,
                jid: e.jid,
                variables: e.variables ?? undefined,
                hasChat: withChat.has(e.jid),
                status: "pending",
            })),
        });
    }

    logger.info("Broadcast", `Campaign ${log.id} queued: ${unique.length} recipients (${withChat.size} with existing chat), delay ${delay}ms`);

    // Tell the caller up front if the campaign cannot start right away
    const [limits, tz] = await Promise.all([getBroadcastLimits(params.sessionId), getTimezone()]);
    const { hour } = localClock(tz);
    let notice: string | undefined;
    if (params.scheduledAt && params.scheduledAt > new Date()) {
        notice = `Scheduled for ${params.scheduledAt.toISOString()}`;
    } else if (respectHours && (hour < limits.hoursStart || hour >= limits.hoursEnd)) {
        notice = `Outside sending hours (${limits.hoursStart}h-${limits.hoursEnd}h ${tz}); sending starts at ${limits.hoursStart}h`;
    } else if (limits.newChatDailyLimit === 0 && withChat.size === 0) {
        notice = "New-chat limit is 0 and no recipient has written to this number before; nothing will be sent";
    }
    if (notice) {
        await prisma.broadcastLog.update({ where: { id: log.id }, data: { waitingReason: notice } });
        lastNote.set(log.id, notice);
    }

    await emitProgress(log.id);
    return { broadcastId: log.id, total: unique.length, withExistingChat: withChat.size, notice };
}

// ---------------------------------------------------------------------------
// Status changes (called from API routes and the message store)
// ---------------------------------------------------------------------------

export async function pauseCampaign(broadcastId: string, reason = "Paused by user") {
    const res = await prisma.broadcastLog.updateMany({
        where: { id: broadcastId, status: "running" },
        data: { status: "paused", pauseReason: reason },
    });
    if (res.count) await emitProgress(broadcastId);
    return res.count > 0;
}

export async function resumeCampaign(broadcastId: string) {
    const res = await prisma.broadcastLog.updateMany({
        where: { id: broadcastId, status: "paused" },
        data: { status: "running", pauseReason: null },
    });
    if (res.count) await emitProgress(broadcastId);
    return res.count > 0;
}

export async function cancelCampaign(broadcastId: string) {
    const res = await prisma.broadcastLog.updateMany({
        where: { id: broadcastId, status: { in: ["running", "paused"] } },
        data: { status: "cancelled", completedAt: new Date() },
    });
    if (!res.count) return false;
    await prisma.broadcastRecipient.updateMany({
        where: { broadcastLogId: broadcastId, status: "pending" },
        data: { status: "cancelled" },
    });
    await syncCounters(broadcastId);
    await emitProgress(broadcastId);
    return true;
}

/** WhatsApp blocked the number from starting chats: stop every running campaign of that session */
export async function pauseSessionCampaigns(sessionId: string, reason: string) {
    const running = await prisma.broadcastLog.findMany({ where: { sessionId, status: "running" }, select: { id: true } });
    for (const c of running) await pauseCampaign(c.id, reason);
    if (running.length) logger.warn("Broadcast", `Paused ${running.length} campaign(s) on ${sessionId}: ${reason}`);
}

// ---------------------------------------------------------------------------
// Counters & progress
// ---------------------------------------------------------------------------

export async function syncCounters(broadcastLogId: string) {
    const [sent, failed] = await Promise.all([
        prisma.broadcastRecipient.count({ where: { broadcastLogId, status: "sent" } }),
        prisma.broadcastRecipient.count({ where: { broadcastLogId, status: "failed" } }),
    ]);
    await prisma.broadcastLog.update({ where: { id: broadcastLogId }, data: { sent, failed } });
    return { sent, failed };
}

async function emitProgress(broadcastId: string, extra: Record<string, unknown> = {}) {
    const io = (global as unknown as { io?: Server }).io;
    if (!io) return;
    const log = await prisma.broadcastLog.findUnique({ where: { id: broadcastId } });
    if (!log) return;
    const [pending, cancelled] = await Promise.all([
        prisma.broadcastRecipient.count({ where: { broadcastLogId: broadcastId, status: { in: ["pending", "sending"] } } }),
        prisma.broadcastRecipient.count({ where: { broadcastLogId: broadcastId, status: "cancelled" } }),
    ]);
    const done = log.sent + log.failed + cancelled;
    io.to(log.sessionId).emit("broadcast.progress", {
        broadcastId,
        sessionId: log.sessionId,
        status: log.status,
        total: log.total,
        sent: log.sent,
        failed: log.failed,
        cancelled,
        pending,
        progress: log.total ? Math.round((done / log.total) * 100) : 100,
        pauseReason: log.pauseReason,
        note: log.status === "running" ? (log.waitingReason ?? undefined) : undefined,
        startedAt: log.startedAt.toISOString(),
        completedAt: log.completedAt?.toISOString(),
        ...extra,
    });
}

/** Emit a "waiting" note only when it changes, to avoid flooding the socket every tick */
async function noteWaiting(broadcastId: string, note: string) {
    if (lastNote.get(broadcastId) === note) return;
    lastNote.set(broadcastId, note);
    logger.info("Broadcast", `Campaign ${broadcastId} waiting: ${note}`);
    await prisma.broadcastLog.update({ where: { id: broadcastId }, data: { waitingReason: note } }).catch(() => {});
    await emitProgress(broadcastId, { note });
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function renderTemplate(template: string, variables: Record<string, unknown> | null | undefined): string {
    if (!variables) return template;
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) =>
        variables[key] !== undefined && variables[key] !== null ? String(variables[key]) : match
    );
}

function guessMimetype(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
        pdf: "application/pdf", doc: "application/msword", xls: "application/vnd.ms-excel",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        csv: "text/csv", txt: "text/plain", zip: "application/zip",
    };
    return (ext && map[ext]) || "application/octet-stream";
}

function buildPayload(log: { message: string; mediaUrl: string | null; mediaType: string | null; fileName: string | null }, variables: unknown) {
    const text = renderTemplate(log.message, variables as Record<string, unknown> | null);
    if (!log.mediaUrl) return { text };
    if (log.mediaType === "document") {
        const fileName = log.fileName || log.mediaUrl.split("?")[0].split("/").pop() || "file";
        return { document: { url: log.mediaUrl }, fileName, mimetype: guessMimetype(fileName), caption: text || undefined };
    }
    const type = log.mediaType === "video" ? "video" : "image";
    return { [type]: { url: log.mediaUrl }, caption: text || undefined };
}

async function sendOne(sessionId: string, log: BroadcastLog, recipientId: string) {
    // Atomically claim the recipient so it can never be sent twice
    const claimed = await prisma.broadcastRecipient.updateMany({
        where: { id: recipientId, status: "pending" },
        data: { status: "sending", attempts: { increment: 1 } },
    });
    if (!claimed.count) return;

    const recipient = await prisma.broadcastRecipient.findUnique({ where: { id: recipientId } });
    if (!recipient) return;

    const instance = waManager.getInstance(sessionId);
    try {
        const jid = await resolveRecipientJid(instance!.socket!, recipient.jid);
        const payload: Record<string, unknown> = buildPayload(log, recipient.variables);
        let mentions: string[] | undefined;
        if (log.mentionAll && jid.endsWith("@g.us")) {
            const self = new Set([bareJid(instance!.socket!.user?.id), bareJid((instance!.socket!.user as { lid?: string } | undefined)?.lid)]);
            mentions = (await activeMemberJids(sessionId, jid)).filter(m => !self.has(bareJid(m)));
            payload.mentions = mentions;
        }
        const result = await ChatService.sendTextMessage(sessionId, jid, payload, mentions);
        await prisma.broadcastRecipient.update({
            where: { id: recipientId },
            data: { status: "sent", sentAt: new Date(), messageId: result?.key?.id ?? null, error: null },
        });
    } catch (e) {
        await prisma.broadcastRecipient.update({
            where: { id: recipientId },
            data: { status: "failed", error: e instanceof Error ? e.message : "Unknown error" },
        });
    }

    await syncCounters(log.id);
    await emitProgress(log.id, { current: recipient.jid });
}

async function completeIfDone(logId: string): Promise<boolean> {
    const remaining = await prisma.broadcastRecipient.count({
        where: { broadcastLogId: logId, status: { in: ["pending", "sending"] } },
    });
    if (remaining > 0) return false;
    const res = await prisma.broadcastLog.updateMany({
        where: { id: logId, status: "running" },
        data: { status: "completed", completedAt: new Date(), waitingReason: null },
    });
    if (res.count) {
        const { sent, failed } = await syncCounters(logId);
        lastNote.delete(logId);
        logger.info("Broadcast", `Campaign ${logId} completed: ${sent} sent, ${failed} failed`);
        await emitProgress(logId);
    }
    return true;
}

async function processSession(sessionId: string, campaigns: BroadcastLog[]) {
    const instance = waManager.getInstance(sessionId);
    if (!instance?.socket || instance.status !== "CONNECTED") {
        for (const c of campaigns) await noteWaiting(c.id, "WhatsApp session is not connected");
        return;
    }

    // Scheduled campaigns wait for their time
    const now = new Date();
    const due: BroadcastLog[] = [];
    for (const c of campaigns) {
        if (c.scheduledAt && c.scheduledAt > now) await noteWaiting(c.id, `Scheduled for ${c.scheduledAt.toISOString()}`);
        else due.push(c);
    }
    if (!due.length) return;

    const [limits, tz] = await Promise.all([getBroadcastLimits(sessionId), getTimezone()]);
    const { hour, startOfDay } = localClock(tz);
    const inHours = hour >= limits.hoursStart && hour < limits.hoursEnd;
    if (!inHours) {
        for (const c of due) {
            if (c.respectHours) await noteWaiting(c.id, `Outside sending hours (${limits.hoursStart}h-${limits.hoursEnd}h ${tz})`);
        }
        campaigns = due.filter(c => !c.respectHours);
        if (!campaigns.length) return;
    } else {
        campaigns = due;
    }

    const sentTodayWhere = {
        broadcastLog: { sessionId },
        status: { in: ["sent", "sending"] },
        sentAt: { gte: startOfDay },
    };
    const [sentToday, newChatsToday] = await Promise.all([
        prisma.broadcastRecipient.count({ where: sentTodayWhere }),
        prisma.broadcastRecipient.count({ where: { ...sentTodayWhere, hasChat: false } }),
    ]);
    if (sentToday >= limits.dailyLimit) {
        for (const c of campaigns) await noteWaiting(c.id, `Daily limit reached (${limits.dailyLimit} messages)`);
        return;
    }
    const allowNewChats = newChatsToday < limits.newChatDailyLimit;

    for (const campaign of campaigns) {
        const next = await prisma.broadcastRecipient.findFirst({
            where: { broadcastLogId: campaign.id, status: "pending", ...(allowNewChats ? {} : { hasChat: true }) },
            orderBy: [{ hasChat: "desc" }, { id: "asc" }],
            select: { id: true },
        });

        if (!next) {
            const done = await completeIfDone(campaign.id);
            if (!done && !allowNewChats) {
                await noteWaiting(campaign.id, `Daily new-chat limit reached (${limits.newChatDailyLimit}); resuming tomorrow`);
            }
            continue;
        }

        lastNote.delete(campaign.id);
        if (campaign.waitingReason) {
            await prisma.broadcastLog.update({ where: { id: campaign.id }, data: { waitingReason: null } });
        }
        await sendOne(sessionId, campaign, next.id);

        const base = campaign.delay || DEFAULT_DELAY_MS;
        nextAllowedAt.set(sessionId, Date.now() + base + Math.floor(Math.random() * base));
        return; // one message per session per slot, across all campaigns
    }
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const running = await prisma.broadcastLog.findMany({
            where: { status: "running" },
            orderBy: { startedAt: "asc" },
        });

        const bySession = new Map<string, BroadcastLog[]>();
        for (const c of running) {
            if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, []);
            bySession.get(c.sessionId)!.push(c);
        }

        const now = Date.now();
        for (const [sessionId, campaigns] of bySession) {
            if (busySessions.has(sessionId) || (nextAllowedAt.get(sessionId) || 0) > now) continue;
            busySessions.add(sessionId);
            processSession(sessionId, campaigns)
                .catch(e => logger.error("Broadcast", `Worker error on ${sessionId}:`, e))
                .finally(() => busySessions.delete(sessionId));
        }
    } catch (e) {
        logger.error("Broadcast", "Worker tick failed:", e);
    } finally {
        ticking = false;
    }
}

export async function startBroadcastWorker() {
    if (started) return;
    started = true;

    // A recipient left in "sending" means we crashed mid-send. We can't know whether
    // WhatsApp got it, so mark it failed instead of risking a duplicate message.
    try {
        const stuck = await prisma.broadcastRecipient.findMany({
            where: { status: "sending" },
            select: { broadcastLogId: true },
            distinct: ["broadcastLogId"],
        });
        const interrupted = await prisma.broadcastRecipient.updateMany({
            where: { status: "sending" },
            data: { status: "failed", error: "Interrupted while sending (not retried to avoid a duplicate message)" },
        });
        for (const s of stuck) await syncCounters(s.broadcastLogId);
        if (interrupted.count) logger.warn("Broadcast", `${interrupted.count} recipient(s) interrupted by a restart were marked as failed`);
    } catch (e) {
        logger.error("Broadcast", "Failed to recover interrupted recipients:", e);
    }

    setInterval(tick, TICK_MS);
    logger.info("Broadcast", "Broadcast queue worker started");
}
