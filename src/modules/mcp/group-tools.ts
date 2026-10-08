import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import * as G from "@/modules/groups/service";
import { groupAnalytics, groupsOverview } from "@/modules/groups/analytics";
import { createLink, listLinks } from "@/modules/groups/links";
import { AUTOMATION_TEMPLATES, invalidateAutomationCache } from "@/modules/groups/automations";
import { automationSchema, automationPatchSchema, validateAutomation } from "@/modules/groups/schemas";
import { createBroadcastCampaign } from "@/modules/whatsapp/broadcast-queue";
import { type Ctx, ToolError, tool, pickSession } from "./helpers";

/** MCP tools for the groups module: manage, message, broadcast, automate and analyze WhatsApp groups */

const sessionIdArg = z.string().optional().describe("WhatsApp number (session) id from list_numbers. Optional when only one is available.");
const groupArg = z.string().describe("Group JID (…@g.us) from list_groups");
const targetArg = z.object({
    all: z.boolean().optional().describe("Every group this number is in"),
    tags: z.array(z.string()).optional().describe("Groups with any of these tags"),
    jids: z.array(z.string()).optional().describe("Specific group JIDs"),
    adminOnly: z.boolean().optional().describe("Only groups where this number is admin"),
});
const mediaArg = z.object({ type: z.enum(["image", "video", "document", "audio"]), url: z.string().url(), fileName: z.string().optional() });

export const GROUP_INSTRUCTIONS = `
Groups:
- list_groups shows the groups (with tags and whether this number is admin); get_group gives details and members with activity.
- Post in one group with send_to_group (mentionAll=true notifies everyone, like @todos). For many groups use group_broadcast (queue with delays; supports scheduledAt and multi-step sequences).
- Admin actions (members, settings, join requests, invite link) only work in groups where this number is admin.
- Organize groups with tags (update_group) and target broadcasts by tag.
- Automations (welcome, anti-link, anti-flood, keyword replies, open/close by schedule) are created with create_group_automation; list templates first with list_group_automation_templates.
- Smart links (create_group_link) give one public URL that fills groups in order — ideal for launches.`;

export function registerGroupTools(server: McpServer, ctx: Ctx) {
    const sid = async (sessionId?: string) => (await pickSession(ctx, sessionId)).sessionId;

    server.registerTool("list_groups", {
        title: "List groups",
        description: "Groups of a number with size, tags, this number's role and last activity. Filter by search text, tag or admin-only.",
        inputSchema: {
            sessionId: sessionIdArg,
            search: z.string().optional(), tag: z.string().optional(),
            adminOnly: z.boolean().optional(),
            sort: z.enum(["name", "size", "activity"]).optional(),
        },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (a: { sessionId?: string; search?: string; tag?: string; adminOnly?: boolean; sort?: "name" | "size" | "activity" }) => {
        const groups = await G.listGroups(await sid(a.sessionId), a);
        return groups.map(g => ({ jid: g.jid, subject: g.subject, size: g.size, myRole: g.myRole, isAdmin: g.isAdmin, tags: g.tags, announce: g.announce, joinApprovalMode: g.joinApprovalMode, lastActivityAt: g.lastActivityAt, isCommunity: g.isCommunity }));
    }));

    server.registerTool("get_group", {
        title: "Group details and members",
        description: "Settings, tags, notes and members (role, joined, messages, last message, warnings). Filter members by status, role, search or inactivity.",
        inputSchema: {
            sessionId: sessionIdArg, groupJid: groupArg,
            members: z.enum(["active", "left", "all"]).optional(),
            role: z.enum(["member", "admin", "superadmin"]).optional(),
            search: z.string().optional(),
            inactiveDays: z.number().int().min(1).optional().describe("Only members with no message in N days"),
            sort: z.enum(["activity", "messages", "joined", "name"]).optional(),
            limit: z.number().int().min(1).max(1024).optional().describe("Max members (default 100)"),
        },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (a: { sessionId?: string; groupJid: string; members?: "active" | "left" | "all"; role?: string; search?: string; inactiveDays?: number; sort?: "activity" | "messages" | "joined" | "name"; limit?: number }) => {
        const s = await sid(a.sessionId);
        const jid = G.assertGroupJid(a.groupJid);
        const group = await G.getGroup(s, jid);
        const members = await G.listMembers(s, jid, { status: a.members, role: a.role, search: a.search, inactiveDays: a.inactiveDays, sort: a.sort });
        return { ...group, members: members.slice(0, a.limit ?? 100), membersTotal: members.length };
    }));

    server.registerTool("send_to_group", {
        title: "Send to a group",
        description: "Post text or media in one group. mentionAll notifies every member (like @todos) without cluttering the text.",
        inputSchema: {
            sessionId: sessionIdArg, groupJid: groupArg,
            text: z.string().optional(), media: mediaArg.optional(),
            mentionAll: z.boolean().optional(),
            replyToMessageId: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool(ctx, "send", async (a: { sessionId?: string; groupJid: string; text?: string; media?: { type: "image" | "video" | "document" | "audio"; url: string; fileName?: string }; mentionAll?: boolean; replyToMessageId?: string }) => {
        return G.sendToGroup(await sid(a.sessionId), G.assertGroupJid(a.groupJid), a);
    }));

    server.registerTool("group_broadcast", {
        title: "Broadcast to many groups",
        description: "Queue a message (or a scheduled sequence of messages) to many groups: all, by tag or by JID. Uses the broadcast queue (delays, pause/cancel via control_broadcast).",
        inputSchema: {
            sessionId: sessionIdArg,
            target: targetArg,
            message: z.string().optional(), media: mediaArg.extend({ type: z.enum(["image", "video", "document"]) }).optional(),
            mentionAll: z.boolean().optional(),
            scheduledAt: z.string().optional().describe("ISO date-time with offset, e.g. 2026-10-10T19:55:00-03:00"),
            sequence: z.array(z.object({
                sendAt: z.string().optional(), message: z.string().default(""),
                media: mediaArg.extend({ type: z.enum(["image", "video", "document"]) }).optional(), mentionAll: z.boolean().optional(),
            })).optional().describe("Several messages, each with its own sendAt"),
            delaySeconds: z.number().int().min(5).max(600).optional(),
            name: z.string().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool(ctx, "broadcast", async (a: { sessionId?: string; target: { all?: boolean; tags?: string[]; jids?: string[]; adminOnly?: boolean }; message?: string; media?: { type: "image" | "video" | "document"; url: string; fileName?: string }; mentionAll?: boolean; scheduledAt?: string; sequence?: { sendAt?: string; message: string; media?: { type: "image" | "video" | "document"; url: string; fileName?: string }; mentionAll?: boolean }[]; delaySeconds?: number; name?: string }) => {
        const s = await sid(a.sessionId);
        const groups = await G.resolveGroupTargets(s, a.target);
        if (!groups.length) throw new ToolError("No groups match the target");
        const steps = a.sequence ?? [{ sendAt: a.scheduledAt, message: a.message ?? "", media: a.media, mentionAll: a.mentionAll }];
        for (const st of steps) {
            if (!st.message.trim() && !st.media) throw new ToolError("Each message needs text or media");
            if (st.sendAt && isNaN(Date.parse(st.sendAt))) throw new ToolError(`Invalid date "${st.sendAt}"`);
        }
        const sequenceId = a.sequence ? randomUUID() : undefined;
        const campaigns = [];
        for (const [i, st] of steps.entries()) {
            campaigns.push(await createBroadcastCampaign({
                sessionId: s, recipients: groups.map(g => g.jid), message: st.message, media: st.media,
                mentionAll: st.mentionAll, scheduledAt: st.sendAt ? new Date(st.sendAt) : null,
                delay: a.delaySeconds ? a.delaySeconds * 1000 : undefined, respectHours: false,
                name: a.sequence ? `${a.name ?? "Sequência"} #${i + 1}` : a.name, sequenceId,
            }));
        }
        return { groups: groups.map(g => g.subject), campaigns };
    }));

    server.registerTool("manage_group_members", {
        title: "Add, remove, promote or demote members",
        description: "Member action in one group (groupJid) or in many groups at once (target), e.g. remove a spammer from every group. Accepts phone numbers or JIDs. Requires admin.",
        inputSchema: {
            sessionId: sessionIdArg,
            action: z.enum(["add", "remove", "promote", "demote"]),
            participants: z.array(z.string()).min(1).max(200),
            groupJid: z.string().optional(), target: targetArg.optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, tool(ctx, "manage", async (a: { sessionId?: string; action: G.MemberAction; participants: string[]; groupJid?: string; target?: { all?: boolean; tags?: string[]; jids?: string[] } }) => {
        const s = await sid(a.sessionId);
        if (a.groupJid) return G.updateMembers(s, G.assertGroupJid(a.groupJid), a.action, a.participants);
        if (!a.target) throw new ToolError("Pass groupJid or target");
        const groups = await G.resolveGroupTargets(s, { ...a.target, adminOnly: true });
        return G.updateMembersInGroups(s, groups.map(g => g.jid), a.action, a.participants);
    }));

    server.registerTool("update_group", {
        title: "Update group settings and organization",
        description: "WhatsApp settings (subject, description, only-admins-send, only-admins-edit, who can add, join approval, disappearing messages) and local tags/notes. Settings require admin; tags/notes don't.",
        inputSchema: {
            sessionId: sessionIdArg, groupJid: groupArg,
            subject: z.string().max(100).optional(), description: z.string().max(2048).optional(),
            announce: z.boolean().optional().describe("true = only admins can send messages (group closed)"),
            restrict: z.boolean().optional().describe("true = only admins can edit group info"),
            memberAddMode: z.enum(["admin_add", "all_member_add"]).optional(),
            joinApprovalMode: z.boolean().optional(),
            ephemeralSeconds: z.number().int().min(0).optional().describe("0 off, 86400, 604800, 7776000"),
            tags: z.array(z.string()).optional().describe("Replaces the group's tags"),
            notes: z.string().optional(),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, tool(ctx, "manage", async (a: { sessionId?: string; groupJid: string; tags?: string[]; notes?: string } & Parameters<typeof G.updateGroupSettings>[2]) => {
        const s = await sid(a.sessionId);
        const jid = G.assertGroupJid(a.groupJid);
        const { sessionId: _s, groupJid: _g, tags, notes, ...settings } = a;
        if (tags !== undefined || notes !== undefined) await G.updateGroupInfo(s, jid, { tags, notes });
        if (Object.values(settings).some(v => v !== undefined)) await G.updateGroupSettings(s, jid, settings);
        return G.getGroup(s, jid);
    }));

    server.registerTool("group_join_requests", {
        title: "Join requests",
        description: "List pending join requests of a group, or approve/reject them (all pending when participants is omitted).",
        inputSchema: { sessionId: sessionIdArg, groupJid: groupArg, action: z.enum(["list", "approve", "reject"]), participants: z.array(z.string()).optional() },
        annotations: { readOnlyHint: false },
    }, tool(ctx, "manage", async (a: { sessionId?: string; groupJid: string; action: "list" | "approve" | "reject"; participants?: string[] }) => {
        const s = await sid(a.sessionId);
        const jid = G.assertGroupJid(a.groupJid);
        if (a.action === "list") return G.listJoinRequests(s, jid);
        return G.answerJoinRequests(s, jid, a.action, a.participants);
    }));

    server.registerTool("group_invite_link", {
        title: "Group invite link",
        description: "Get the group's invite link, or revoke it and get a new one.",
        inputSchema: { sessionId: sessionIdArg, groupJid: groupArg, revoke: z.boolean().optional() },
        annotations: { readOnlyHint: false },
    }, tool(ctx, "manage", async (a: { sessionId?: string; groupJid: string; revoke?: boolean }) => G.getInviteLink(await sid(a.sessionId), G.assertGroupJid(a.groupJid), a.revoke)));

    server.registerTool("create_group", {
        title: "Create a group",
        description: "Create a WhatsApp group with initial participants (phones or JIDs), optional description, tags and closed mode.",
        inputSchema: {
            sessionId: sessionIdArg, subject: z.string().min(1).max(100), participants: z.array(z.string()).min(1).max(200),
            description: z.string().optional(), tags: z.array(z.string()).optional(), announce: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
    }, tool(ctx, "manage", async (a: { sessionId?: string; subject: string; participants: string[]; description?: string; tags?: string[]; announce?: boolean }) => {
        return G.createGroup(await sid(a.sessionId), a.subject, a.participants, a);
    }));

    server.registerTool("group_analytics", {
        title: "Group analytics",
        description: "With groupJid: growth (joins/leaves), messages per day/hour, best hours to post, top and inactive members. Without: all groups compared.",
        inputSchema: { sessionId: sessionIdArg, groupJid: z.string().optional(), days: z.number().int().min(1).max(90).optional() },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (a: { sessionId?: string; groupJid?: string; days?: number }) => {
        const s = await sid(a.sessionId);
        return a.groupJid ? groupAnalytics(s, G.assertGroupJid(a.groupJid), a.days ?? 30) : groupsOverview(s, a.days ?? 7);
    }));

    server.registerTool("list_group_automation_templates", {
        title: "Automation templates",
        description: "Ready-made automation rules (welcome, goodbye, anti-link, anti-flood, !regras, open/close by schedule, lead alert) to adapt.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async () => Object.entries(AUTOMATION_TEMPLATES).map(([key, t]) => ({ key, ...t }))));

    server.registerTool("list_group_automations", {
        title: "List group automations",
        description: "Automation rules of a number with trigger, actions, scope, runs and last run.",
        inputSchema: { sessionId: sessionIdArg },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (a: { sessionId?: string }) => {
        const s = await G.dbSession(await sid(a.sessionId));
        return prisma.groupAutomation.findMany({ where: { sessionId: s.id }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    }));

    server.registerTool("create_group_automation", {
        title: "Create a group automation",
        description: "Create a rule. Either pass template (key from list_group_automation_templates) with optional overrides, or a full rule: trigger member_join|member_leave|message|schedule, triggerConfig, actions, scope {all|tags|jids}.",
        inputSchema: {
            sessionId: sessionIdArg,
            template: z.string().optional(),
            rule: z.record(z.string(), z.unknown()).optional().describe("Fields: name, scope, trigger, triggerConfig, actions, ignoreAdmins, cooldownSec, priority, active"),
        },
        annotations: { readOnlyHint: false },
    }, tool(ctx, "manage", async (a: { sessionId?: string; template?: string; rule?: Record<string, unknown> }) => {
        const s = await G.dbSession(await sid(a.sessionId));
        const base = a.template ? AUTOMATION_TEMPLATES[a.template] : undefined;
        if (a.template && !base) throw new ToolError(`Unknown template "${a.template}"`);
        const { description: _d, ...tpl } = base ?? ({} as Record<string, unknown>);
        const merged = { scope: { all: true }, ...tpl, ...(a.rule ?? {}) };
        const parsed = automationSchema.safeParse(merged);
        if (!parsed.success) throw new ToolError(`Invalid rule: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
        validateAutomation(parsed.data);
        const created = await prisma.groupAutomation.create({ data: { sessionId: s.id, ...parsed.data } });
        invalidateAutomationCache(s.id);
        return created;
    }));

    server.registerTool("update_group_automation", {
        title: "Update, enable, disable or delete an automation",
        description: "Change fields of a rule (e.g. { active: false }) or delete it.",
        inputSchema: { sessionId: sessionIdArg, automationId: z.string(), changes: z.record(z.string(), z.unknown()).optional(), delete: z.boolean().optional() },
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, tool(ctx, "manage", async (a: { sessionId?: string; automationId: string; changes?: Record<string, unknown>; delete?: boolean }) => {
        const s = await G.dbSession(await sid(a.sessionId));
        const rule = await prisma.groupAutomation.findFirst({ where: { id: a.automationId, sessionId: s.id } });
        if (!rule) throw new ToolError("Automation not found");
        if (a.delete) { await prisma.groupAutomation.delete({ where: { id: rule.id } }); invalidateAutomationCache(s.id); return { deleted: true }; }
        const parsed = automationPatchSchema.safeParse(a.changes ?? {});
        if (!parsed.success) throw new ToolError(`Invalid changes: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
        validateAutomation({ trigger: parsed.data.trigger ?? rule.trigger, triggerConfig: (parsed.data.triggerConfig ?? rule.triggerConfig) as { cron?: string } });
        const updated = await prisma.groupAutomation.update({ where: { id: rule.id }, data: parsed.data });
        invalidateAutomationCache(s.id);
        return updated;
    }));

    server.registerTool("list_group_links", {
        title: "List smart group links",
        description: "Smart links with their public URL, fill status of each group and clicks per group and traffic source.",
        inputSchema: { sessionId: sessionIdArg },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (a: { sessionId?: string }) => listLinks(await sid(a.sessionId))));

    server.registerTool("create_group_link", {
        title: "Create a smart group link",
        description: "One public URL that sends each visitor to the next group with room (fill or balance), optionally creating new groups when all are full.",
        inputSchema: {
            sessionId: sessionIdArg, name: z.string().min(1).max(100), groupJids: z.array(z.string()).default([]),
            slug: z.string().optional(), maxMembers: z.number().int().min(2).max(1024).optional(),
            strategy: z.enum(["fill", "balance"]).optional(), autoCreate: z.boolean().optional(),
            autoCreateName: z.string().optional(), autoCreateTags: z.array(z.string()).optional(), fallbackUrl: z.string().url().optional(),
        },
        annotations: { readOnlyHint: false },
    }, tool(ctx, "manage", async (a: { sessionId?: string } & Parameters<typeof createLink>[1]) => {
        const { sessionId, ...input } = a;
        return createLink(await sid(sessionId), input);
    }));
}
