import { prisma } from "@/lib/prisma";
import { dbSession } from "./service";

/**
 * Group analytics from GroupEvent (membership), Message (activity) and GroupMember.
 * Days are bucketed in the system timezone.
 */

async function timezone(): Promise<string> {
    const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { timezone: true } }).catch(() => null);
    return cfg?.timezone || "America/Sao_Paulo";
}

function dayKey(d: Date, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function hourOf(d: Date, tz: string): number {
    return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d), 10) % 24;
}

function weekdayOf(d: Date, tz: string): number {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

function emptyDays(days: number, tz: string): Map<string, { date: string; joins: number; leaves: number; messages: number }> {
    const m = new Map();
    for (let i = days - 1; i >= 0; i--) {
        const date = dayKey(new Date(Date.now() - i * 86400000), tz);
        m.set(date, { date, joins: 0, leaves: 0, messages: 0 });
    }
    return m;
}

export async function groupAnalytics(sessionId: string, groupJid: string, days = 30, inactiveDays = 30) {
    days = Math.min(Math.max(days, 1), 90);
    const s = await dbSession(sessionId);
    const tz = await timezone();
    const since = new Date(Date.now() - days * 86400000);

    const [group, events, messages, activeMembers, inactive, admins] = await Promise.all([
        prisma.group.findUnique({ where: { sessionId_jid: { sessionId: s.id, jid: groupJid } }, select: { subject: true, size: true, lastActivityAt: true } }),
        prisma.groupEvent.findMany({ where: { sessionId: s.id, groupJid, createdAt: { gte: since }, type: { in: ["join", "leave", "removed"] } }, select: { type: true, createdAt: true } }),
        prisma.message.findMany({ where: { sessionId: s.id, remoteJid: groupJid, timestamp: { gte: since } }, select: { timestamp: true, fromMe: true, senderJid: true, pushName: true } }),
        prisma.groupMember.count({ where: { sessionId: s.id, groupJid, isActive: true } }),
        prisma.groupMember.count({ where: { sessionId: s.id, groupJid, isActive: true, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: new Date(Date.now() - inactiveDays * 86400000) } }] } }),
        prisma.groupMember.count({ where: { sessionId: s.id, groupJid, isActive: true, role: { in: ["admin", "superadmin"] } } }),
    ]);

    const daily = emptyDays(days, tz);
    for (const e of events) {
        const d = daily.get(dayKey(e.createdAt, tz));
        if (!d) continue;
        if (e.type === "join") d.joins++; else d.leaves++;
    }
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: 0 }));
    const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({ weekday, messages: 0 }));
    const senders = new Map<string, { jid: string; name: string | null; messages: number }>();
    let fromMembers = 0;
    for (const m of messages) {
        const d = daily.get(dayKey(m.timestamp, tz));
        if (d) d.messages++;
        if (m.fromMe) continue;
        fromMembers++;
        byHour[hourOf(m.timestamp, tz)].messages++;
        byWeekday[weekdayOf(m.timestamp, tz)].messages++;
        if (m.senderJid) {
            const s0 = senders.get(m.senderJid) || { jid: m.senderJid, name: null, messages: 0 };
            s0.messages++;
            if (m.pushName) s0.name = m.pushName;
            senders.set(m.senderJid, s0);
        }
    }

    const joins = events.filter(e => e.type === "join").length;
    const leaves = events.length - joins;
    const peakHours = [...byHour].sort((a, b) => b.messages - a.messages).filter(h => h.messages > 0).slice(0, 3).map(h => h.hour);

    return {
        group: { jid: groupJid, subject: group?.subject ?? null, size: group?.size ?? activeMembers, lastActivityAt: group?.lastActivityAt ?? null },
        period: { days, since, timezone: tz },
        members: { active: activeMembers, admins, inactive, inactiveDays, activeRate: activeMembers ? Math.round(((activeMembers - inactive) / activeMembers) * 100) : 0 },
        growth: { joins, leaves, net: joins - leaves, churnRate: activeMembers ? Math.round((leaves / Math.max(activeMembers, 1)) * 1000) / 10 : 0 },
        messages: { total: messages.length, fromMembers, fromMe: messages.length - fromMembers, uniqueSenders: senders.size, perDay: Math.round((messages.length / days) * 10) / 10 },
        daily: [...daily.values()],
        byHour,
        byWeekday,
        bestHoursToPost: peakHours,
        topMembers: [...senders.values()].sort((a, b) => b.messages - a.messages).slice(0, 10),
    };
}

/** One line per group for comparison, plus totals */
export async function groupsOverview(sessionId: string, days = 7) {
    days = Math.min(Math.max(days, 1), 90);
    const s = await dbSession(sessionId);
    const since = new Date(Date.now() - days * 86400000);
    const groups = await prisma.group.findMany({ where: { sessionId: s.id, myRole: { not: null } }, select: { jid: true, subject: true, size: true, myRole: true, tags: true, lastActivityAt: true } });
    const jids = groups.map(g => g.jid);

    const [events, msgs] = await Promise.all([
        prisma.groupEvent.groupBy({ by: ["groupJid", "type"], where: { sessionId: s.id, groupJid: { in: jids }, createdAt: { gte: since }, type: { in: ["join", "leave", "removed"] } }, _count: { _all: true } }),
        prisma.message.groupBy({ by: ["remoteJid"], where: { sessionId: s.id, remoteJid: { in: jids }, timestamp: { gte: since } }, _count: { _all: true } }),
    ]);

    const rows = groups.map(g => {
        const joins = events.filter(e => e.groupJid === g.jid && e.type === "join").reduce((a, e) => a + e._count._all, 0);
        const leaves = events.filter(e => e.groupJid === g.jid && e.type !== "join").reduce((a, e) => a + e._count._all, 0);
        const messages = msgs.find(m => m.remoteJid === g.jid)?._count._all ?? 0;
        return {
            jid: g.jid, subject: g.subject, size: g.size ?? 0, myRole: g.myRole,
            tags: Array.isArray(g.tags) ? g.tags : [], lastActivityAt: g.lastActivityAt,
            joins, leaves, net: joins - leaves, messages,
        };
    }).sort((a, b) => b.messages - a.messages);

    return {
        period: { days, since },
        totals: {
            groups: rows.length,
            members: rows.reduce((a, r) => a + r.size, 0),
            adminIn: rows.filter(r => r.myRole === "admin" || r.myRole === "superadmin").length,
            joins: rows.reduce((a, r) => a + r.joins, 0),
            leaves: rows.reduce((a, r) => a + r.leaves, 0),
            messages: rows.reduce((a, r) => a + r.messages, 0),
        },
        groups: rows,
    };
}
