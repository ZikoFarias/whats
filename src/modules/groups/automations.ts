import type { WAMessage, WASocket, proto } from "@whiskeysockets/baileys";
import { CronExpressionParser } from "cron-parser";
import type { GroupAutomation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { dispatchWebhook } from "@/lib/webhook";
import { waManager } from "@/modules/whatsapp/manager";
import { recordGroupEvent, bareJid, phoneFromJid } from "./sync";

/**
 * Group automations and moderation.
 *
 * Triggers
 *   member_join / member_leave  — someone entered or left a group
 *   message                     — triggerConfig.match: any | contains | exact | starts_with | regex
 *                                 | link | invite_link | flood, with keywords / pattern / limits
 *   schedule                    — triggerConfig.cron (e.g. "0 22 * * *"), in the system timezone
 *
 * Actions (run in order; { type: "stop" } ends the chain and skips lower-priority rules)
 *   send_message { text, mentionAll?, mentionMember?, media? }   reply { text }
 *   delete_message   warn { text?, max, then: "remove" | "none" }   remove_member
 *   set_announce { value }  (close/open the group)   notify (webhook "group.automation")   stop
 *
 * Text variables: {{nome}} {{name}} {{grupo}} {{group}} {{membros}} {{mencao}} {{mention}}
 *                 {{advertencias}} {{max}} {{data}} {{hora}}
 */

export type Scope = { all?: boolean; tags?: string[]; jids?: string[] };
export type Action =
    | { type: "send_message"; text?: string; mentionAll?: boolean; mentionMember?: boolean; media?: { type: "image" | "video" | "document" | "audio"; url: string; fileName?: string } }
    | { type: "reply"; text: string }
    | { type: "delete_message" }
    | { type: "warn"; text?: string; max?: number; then?: "remove" | "none" }
    | { type: "remove_member" }
    | { type: "set_announce"; value: boolean }
    | { type: "notify" }
    | { type: "stop" };

export interface TriggerConfig {
    match?: "any" | "contains" | "exact" | "starts_with" | "regex" | "link" | "invite_link" | "flood";
    keywords?: string[];
    pattern?: string;
    caseSensitive?: boolean;
    maxMessages?: number;   // flood
    perSeconds?: number;    // flood
    cron?: string;          // schedule
}

interface Ctx {
    sock: WASocket;
    sessionId: string;
    dbSessionId: string;
    groupJid: string;
    groupSubject: string;
    groupSize: number;
    iAmAdmin: boolean;
    memberJid?: string;
    memberName?: string | null;
    message?: WAMessage;
    text?: string;
    trigger: string;
}

// ---------------------------------------------------------------------------
// Rule cache (the hook runs on every group message)
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; rules: GroupAutomation[] }>();
const CACHE_MS = 15000;

async function rulesFor(dbSessionId: string): Promise<GroupAutomation[]> {
    const hit = cache.get(dbSessionId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
    const rules = await prisma.groupAutomation.findMany({ where: { sessionId: dbSessionId, active: true }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    cache.set(dbSessionId, { at: Date.now(), rules });
    return rules;
}

export function invalidateAutomationCache(dbSessionId?: string) {
    if (dbSessionId) cache.delete(dbSessionId); else cache.clear();
}

function asScope(v: unknown): Scope { return (v && typeof v === "object" ? v : {}) as Scope; }
function asConfig(v: unknown): TriggerConfig { return (v && typeof v === "object" ? v : {}) as TriggerConfig; }
function asActions(v: unknown): Action[] { return Array.isArray(v) ? (v as Action[]) : []; }

function inScope(scope: Scope, groupJid: string, tags: string[]): boolean {
    if (scope.all) return true;
    if (scope.jids?.includes(groupJid)) return true;
    return !!scope.tags?.some(t => tags.includes(t));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|com\.br|net|org|io|me|ly|link|app|xyz|info|site|store|shop)(\/\S*)?\b/i;
const INVITE_RE = /chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i;

const floodWindows = new Map<string, number[]>();

export function messageText(msg: WAMessage): string {
    const m = msg.message as proto.IMessage | null | undefined;
    if (!m) return "";
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m;
    return inner.conversation
        || inner.extendedTextMessage?.text
        || inner.imageMessage?.caption
        || inner.videoMessage?.caption
        || inner.documentMessage?.caption
        || "";
}

export function matches(cfg: TriggerConfig, text: string, floodKey?: string): boolean {
    const norm = (s: string) => (cfg.caseSensitive ? s : s.toLowerCase());
    const t = norm(text);
    const kws = (cfg.keywords || []).map(norm).filter(Boolean);
    switch (cfg.match ?? "contains") {
        case "any": return true;
        case "contains": return kws.some(k => t.includes(k));
        case "exact": return kws.some(k => t.trim() === k);
        case "starts_with": return kws.some(k => t.trimStart().startsWith(k));
        case "regex":
            try { return !!cfg.pattern && new RegExp(cfg.pattern, cfg.caseSensitive ? "" : "i").test(text); } catch { return false; }
        case "invite_link": return INVITE_RE.test(text);
        case "link": return URL_RE.test(text) || INVITE_RE.test(text);
        case "flood": {
            if (!floodKey) return false;
            const max = Math.max(2, cfg.maxMessages ?? 5);
            const windowMs = Math.max(1, cfg.perSeconds ?? 10) * 1000;
            const now = Date.now();
            const hits = (floodWindows.get(floodKey) || []).filter(ts => now - ts < windowMs);
            hits.push(now);
            floodWindows.set(floodKey, hits);
            return hits.length > max;
        }
        default: return false;
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const cooldowns = new Map<string, number>();

function render(text: string, ctx: Ctx, extra: Record<string, string | number> = {}): { text: string; mentions: string[] } {
    const mentions: string[] = [];
    const now = new Date();
    const mentionTag = ctx.memberJid ? `@${ctx.memberJid.split("@")[0]}` : "";
    const vars: Record<string, string> = {
        nome: ctx.memberName || (ctx.memberJid ? phoneFromJid(ctx.memberJid) || "" : ""),
        grupo: ctx.groupSubject, membros: String(ctx.groupSize),
        mencao: mentionTag, data: now.toLocaleDateString("pt-BR"), hora: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
        ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
    };
    vars.name = vars.nome; vars.group = vars.grupo; vars.mention = vars.mencao; vars.members = vars.membros;
    const out = text.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (m, k) => {
        const key = k.toLowerCase();
        if ((key === "mencao" || key === "mention") && ctx.memberJid) mentions.push(ctx.memberJid);
        return key in vars ? vars[key] : m;
    });
    return { text: out, mentions };
}

async function send(ctx: Ctx, content: Record<string, unknown>) {
    return ctx.sock.sendMessage(ctx.groupJid, content as never);
}

async function allMemberJids(ctx: Ctx): Promise<string[]> {
    const self = new Set([bareJid(ctx.sock.user?.id), bareJid((ctx.sock.user as { lid?: string } | undefined)?.lid)]);
    const members = await prisma.groupMember.findMany({ where: { sessionId: ctx.dbSessionId, groupJid: ctx.groupJid, isActive: true }, select: { memberJid: true } });
    return members.map(m => m.memberJid).filter(j => !self.has(bareJid(j)));
}

/** Returns false when the chain should stop */
async function runAction(rule: GroupAutomation, action: Action, ctx: Ctx): Promise<boolean> {
    switch (action.type) {
        case "stop":
            return false;

        case "send_message": {
            const { text, mentions } = render(action.text || "", ctx);
            let allMentions = [...mentions];
            if (action.mentionMember && ctx.memberJid) allMentions.push(ctx.memberJid);
            if (action.mentionAll) allMentions = [...new Set([...allMentions, ...(await allMemberJids(ctx))])];
            const content: Record<string, unknown> = action.media
                ? { [action.media.type]: { url: action.media.url }, ...(action.media.type !== "audio" && text ? { caption: text } : {}), ...(action.media.type === "document" ? { fileName: action.media.fileName || "arquivo", mimetype: "application/octet-stream" } : {}), ...(action.media.type === "audio" ? { mimetype: "audio/mp4" } : {}) }
                : { text };
            if (!action.media && !text.trim()) return true;
            if (allMentions.length) content.mentions = allMentions;
            await send(ctx, content);
            return true;
        }

        case "reply": {
            if (!ctx.message) return true;
            const { text, mentions } = render(action.text, ctx);
            await ctx.sock.sendMessage(ctx.groupJid, { text, ...(mentions.length ? { mentions } : {}) }, { quoted: ctx.message });
            return true;
        }

        case "delete_message": {
            if (!ctx.message) return true;
            if (!ctx.iAmAdmin) { logger.warn("Groups", `Automation "${rule.name}": cannot delete in ${ctx.groupJid}, this number is not admin`); return true; }
            await send(ctx, { delete: ctx.message.key });
            return true;
        }

        case "warn": {
            if (!ctx.memberJid) return true;
            const max = Math.max(1, action.max ?? 3);
            const member = await prisma.groupMember.upsert({
                where: { sessionId_groupJid_memberJid: { sessionId: ctx.dbSessionId, groupJid: ctx.groupJid, memberJid: ctx.memberJid } },
                create: { sessionId: ctx.dbSessionId, groupJid: ctx.groupJid, memberJid: ctx.memberJid, warnings: 1 },
                update: { warnings: { increment: 1 } },
            });
            await recordGroupEvent(ctx.dbSessionId, ctx.groupJid, "moderation", ctx.memberJid, null, { rule: rule.name, action: "warn", warnings: member.warnings });
            if (member.warnings >= max && (action.then ?? "remove") === "remove") {
                await prisma.groupMember.update({ where: { id: member.id }, data: { warnings: 0 } });
                return runAction(rule, { type: "remove_member" }, ctx);
            }
            const text = action.text ?? "⚠️ {{mencao}}, isso não é permitido aqui. Advertência {{advertencias}}/{{max}}.";
            const r = render(text, ctx, { advertencias: member.warnings, max });
            await send(ctx, { text: r.text, mentions: [...new Set([...r.mentions, ctx.memberJid])] });
            return true;
        }

        case "remove_member": {
            if (!ctx.memberJid) return true;
            if (!ctx.iAmAdmin) { logger.warn("Groups", `Automation "${rule.name}": cannot remove in ${ctx.groupJid}, this number is not admin`); return true; }
            await ctx.sock.groupParticipantsUpdate(ctx.groupJid, [ctx.memberJid], "remove");
            await recordGroupEvent(ctx.dbSessionId, ctx.groupJid, "moderation", ctx.memberJid, null, { rule: rule.name, action: "remove" });
            return true;
        }

        case "set_announce": {
            if (!ctx.iAmAdmin) { logger.warn("Groups", `Automation "${rule.name}": cannot change settings of ${ctx.groupJid}, this number is not admin`); return true; }
            await ctx.sock.groupSettingUpdate(ctx.groupJid, action.value ? "announcement" : "not_announcement");
            await prisma.group.updateMany({ where: { sessionId: ctx.dbSessionId, jid: ctx.groupJid }, data: { announce: action.value } });
            return true;
        }

        case "notify":
            dispatchWebhook(ctx.sessionId, "group.automation", {
                automation: rule.name, trigger: ctx.trigger, groupJid: ctx.groupJid, group: ctx.groupSubject,
                memberJid: ctx.memberJid ?? null, memberName: ctx.memberName ?? null, text: ctx.text ?? null,
                messageId: ctx.message?.key.id ?? null,
            });
            return true;
    }
}

async function runRule(rule: GroupAutomation, ctx: Ctx): Promise<boolean> {
    if (rule.cooldownSec > 0) {
        const key = `${rule.id}|${ctx.groupJid}|${ctx.memberJid ?? ""}`;
        const last = cooldowns.get(key) || 0;
        if (Date.now() - last < rule.cooldownSec * 1000) return true;
        cooldowns.set(key, Date.now());
    }
    let keepGoing = true;
    for (const action of asActions(rule.actions)) {
        try {
            if (!(await runAction(rule, action, ctx))) { keepGoing = false; break; }
        } catch (e) {
            logger.error("Groups", `Automation "${rule.name}" action ${action.type} failed in ${ctx.groupJid}`, e);
        }
    }
    await prisma.groupAutomation.update({ where: { id: rule.id }, data: { runs: { increment: 1 }, lastRunAt: new Date() } }).catch(() => {});
    return keepGoing;
}

async function groupContext(sock: WASocket, sessionId: string, dbSessionId: string, groupJid: string) {
    const g = await prisma.group.findUnique({ where: { sessionId_jid: { sessionId: dbSessionId, jid: groupJid } }, select: { subject: true, size: true, myRole: true, tags: true } });
    if (!g || g.myRole === null) return null;
    return {
        sock, sessionId, dbSessionId, groupJid,
        groupSubject: g.subject || "", groupSize: g.size ?? 0,
        iAmAdmin: g.myRole === "admin" || g.myRole === "superadmin",
        tags: Array.isArray(g.tags) ? (g.tags as string[]) : [],
    };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function runMessageAutomations(sock: WASocket, sessionId: string, dbSessionId: string, msg: WAMessage) {
    if (msg.key.fromMe) return;
    const rules = (await rulesFor(dbSessionId)).filter(r => r.trigger === "message");
    if (!rules.length) return;
    const groupJid = msg.key.remoteJid!;
    const base = await groupContext(sock, sessionId, dbSessionId, groupJid);
    if (!base) return;
    const memberJid = msg.key.participant || msg.participant || undefined;
    const text = messageText(msg);
    const member = memberJid
        ? await prisma.groupMember.findUnique({ where: { sessionId_groupJid_memberJid: { sessionId: dbSessionId, groupJid, memberJid } }, select: { role: true, name: true } })
        : null;
    const isAdmin = member?.role === "admin" || member?.role === "superadmin";
    const ctx: Ctx = { ...base, memberJid, memberName: msg.pushName || member?.name, message: msg, text, trigger: "message" };

    for (const rule of rules) {
        if (!inScope(asScope(rule.scope), groupJid, base.tags)) continue;
        if (rule.ignoreAdmins && isAdmin) continue;
        if (!matches(asConfig(rule.triggerConfig), text, `${rule.id}|${groupJid}|${memberJid}`)) continue;
        if (!(await runRule(rule, ctx))) break;
    }
}

export async function runMemberAutomations(sock: WASocket, sessionId: string, groupJid: string, action: "add" | "remove", participants: { id: string; notify?: string }[]) {
    const s = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
    if (!s) return;
    const trigger = action === "add" ? "member_join" : "member_leave";
    const rules = (await rulesFor(s.id)).filter(r => r.trigger === trigger);
    if (!rules.length) return;
    const base = await groupContext(sock, sessionId, s.id, groupJid);
    if (!base) return;
    const self = new Set([bareJid(sock.user?.id), bareJid((sock.user as { lid?: string } | undefined)?.lid)]);

    for (const p of participants) {
        if (self.has(bareJid(p.id))) continue;
        const ctx: Ctx = { ...base, memberJid: p.id, memberName: p.notify || null, trigger };
        for (const rule of rules) {
            if (!inScope(asScope(rule.scope), groupJid, base.tags)) continue;
            if (!(await runRule(rule, ctx))) break;
        }
    }
}

// Schedules ------------------------------------------------------------------

let scheduleStarted = false;
let lastScheduleCheck = new Date();

async function timezone(): Promise<string> {
    const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { timezone: true } }).catch(() => null);
    return cfg?.timezone || "America/Sao_Paulo";
}

/** Did the cron fire in (from, to]? */
export function cronFiredBetween(expr: string, from: Date, to: Date, tz: string): boolean {
    try {
        const next = CronExpressionParser.parse(expr, { currentDate: from, tz }).next().toDate();
        return next > from && next <= to;
    } catch {
        return false;
    }
}

async function checkSchedules() {
    const from = lastScheduleCheck;
    const to = new Date();
    lastScheduleCheck = to;
    const tz = await timezone();
    const rules = await prisma.groupAutomation.findMany({ where: { active: true, trigger: "schedule" }, orderBy: { priority: "asc" } });
    for (const rule of rules) {
        const cron = asConfig(rule.triggerConfig).cron;
        if (!cron || !cronFiredBetween(cron, from, to, tz)) continue;
        const session = await prisma.session.findUnique({ where: { id: rule.sessionId }, select: { sessionId: true } });
        const sock = session ? waManager.getInstance(session.sessionId)?.socket : null;
        if (!session || !sock) { logger.warn("Groups", `Scheduled automation "${rule.name}" skipped: number not connected`); continue; }
        const groups = await prisma.group.findMany({ where: { sessionId: rule.sessionId, myRole: { not: null } }, select: { jid: true, tags: true } });
        for (const g of groups) {
            if (!inScope(asScope(rule.scope), g.jid, Array.isArray(g.tags) ? (g.tags as string[]) : [])) continue;
            const base = await groupContext(sock, session.sessionId, rule.sessionId, g.jid);
            if (base) await runRule(rule, { ...base, trigger: "schedule" });
        }
    }
}

export function startAutomationScheduler() {
    if (scheduleStarted) return;
    scheduleStarted = true;
    lastScheduleCheck = new Date();
    setInterval(() => { checkSchedules().catch(e => logger.error("Groups", "Schedule check failed", e)); }, 30000);
    logger.info("Groups", "Group automation scheduler started");
}

// ---------------------------------------------------------------------------
// Ready-made rules
// ---------------------------------------------------------------------------

export const AUTOMATION_TEMPLATES: Record<string, { name: string; description: string; trigger: string; triggerConfig: TriggerConfig; actions: Action[]; ignoreAdmins?: boolean; cooldownSec?: number }> = {
    welcome: {
        name: "Boas-vindas", description: "Mensagem para cada pessoa que entra, mencionando-a",
        trigger: "member_join", triggerConfig: {},
        actions: [{ type: "send_message", text: "Seja bem-vindo(a), {{mencao}}! 🎉\nVocê está no grupo *{{grupo}}*. Leia as regras na descrição." }],
    },
    goodbye: {
        name: "Despedida", description: "Mensagem quando alguém sai",
        trigger: "member_leave", triggerConfig: {},
        actions: [{ type: "send_message", text: "{{nome}} saiu do grupo. Até mais! 👋" }],
    },
    anti_link: {
        name: "Anti-link", description: "Apaga links de não-admins e adverte; remove na 3ª vez",
        trigger: "message", triggerConfig: { match: "link" },
        actions: [{ type: "delete_message" }, { type: "warn", max: 3, then: "remove", text: "🚫 {{mencao}}, links não são permitidos aqui. Advertência {{advertencias}}/{{max}}." }, { type: "stop" }],
    },
    anti_invite: {
        name: "Anti-convite de outros grupos", description: "Apaga convites de outros grupos e remove o autor",
        trigger: "message", triggerConfig: { match: "invite_link" },
        actions: [{ type: "delete_message" }, { type: "remove_member" }, { type: "stop" }],
    },
    banned_words: {
        name: "Palavras proibidas", description: "Apaga mensagens com palavras da lista e adverte",
        trigger: "message", triggerConfig: { match: "contains", keywords: ["palavrão1", "palavrão2"] },
        actions: [{ type: "delete_message" }, { type: "warn", max: 3, then: "remove" }, { type: "stop" }],
    },
    anti_flood: {
        name: "Anti-flood", description: "Mais de 6 mensagens em 10s: apaga e adverte",
        trigger: "message", triggerConfig: { match: "flood", maxMessages: 6, perSeconds: 10 },
        actions: [{ type: "delete_message" }, { type: "warn", max: 3, then: "remove", text: "⏳ {{mencao}}, calma! Evite mandar muitas mensagens seguidas. Advertência {{advertencias}}/{{max}}." }],
    },
    rules_command: {
        name: "Comando !regras", description: "Responde quem digita !regras",
        trigger: "message", triggerConfig: { match: "exact", keywords: ["!regras"] }, ignoreAdmins: false, cooldownSec: 60,
        actions: [{ type: "reply", text: "📌 Regras do *{{grupo}}*:\n1. Respeito sempre\n2. Sem links e propagandas\n3. Sem spam" }],
    },
    close_at_night: {
        name: "Fechar o grupo às 22h", description: "Só admins falam depois das 22h",
        trigger: "schedule", triggerConfig: { cron: "0 22 * * *" },
        actions: [{ type: "set_announce", value: true }, { type: "send_message", text: "🌙 Grupo fechado. Voltamos às 8h!" }],
    },
    open_in_morning: {
        name: "Abrir o grupo às 8h", description: "Libera mensagens de todos às 8h",
        trigger: "schedule", triggerConfig: { cron: "0 8 * * *" },
        actions: [{ type: "set_announce", value: false }, { type: "send_message", text: "☀️ Bom dia! Grupo aberto." }],
    },
    lead_alert: {
        name: "Alerta de interesse", description: "Avisa seu sistema (webhook) quando alguém fala em comprar/preço",
        trigger: "message", triggerConfig: { match: "contains", keywords: ["preço", "valor", "quanto custa", "comprar", "link de pagamento"] }, ignoreAdmins: true,
        actions: [{ type: "notify" }],
    },
};
