import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { GroupError } from "./service";

/** Body of POST/PATCH /api/groups/{sessionId}/links */
export const linkSchema = z.object({
    name: z.string().min(1).max(100),
    slug: z.string().optional(),
    groupJids: z.array(z.string().regex(/@g\.us$/)).default([]),
    maxMembers: z.number().int().min(2).max(1024).optional(),
    strategy: z.enum(["fill", "balance"]).optional(),
    autoCreate: z.boolean().optional(),
    autoCreateName: z.string().max(100).optional(),
    autoCreateTags: z.array(z.string()).optional(),
    fallbackUrl: z.string().url().nullable().optional(),
    active: z.boolean().optional(),
});

const mediaSchema = z.object({ type: z.enum(["image", "video", "document", "audio"]), url: z.string().url(), fileName: z.string().optional() });

export const actionSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("send_message"), text: z.string().max(4096).optional(), mentionAll: z.boolean().optional(), mentionMember: z.boolean().optional(), media: mediaSchema.optional() }),
    z.object({ type: z.literal("reply"), text: z.string().min(1).max(4096) }),
    z.object({ type: z.literal("delete_message") }),
    z.object({ type: z.literal("warn"), text: z.string().max(1000).optional(), max: z.number().int().min(1).max(20).optional(), then: z.enum(["remove", "none"]).optional() }),
    z.object({ type: z.literal("remove_member") }),
    z.object({ type: z.literal("set_announce"), value: z.boolean() }),
    z.object({ type: z.literal("notify") }),
    z.object({ type: z.literal("stop") }),
]);

const triggerConfigSchema = z.object({
        match: z.enum(["any", "contains", "exact", "starts_with", "regex", "link", "invite_link", "flood"]).optional(),
        keywords: z.array(z.string().min(1)).max(500).optional(),
        pattern: z.string().max(500).optional(),
        caseSensitive: z.boolean().optional(),
        maxMessages: z.number().int().min(2).max(100).optional(),
        perSeconds: z.number().int().min(1).max(3600).optional(),
        cron: z.string().max(100).optional(),
    });

/** Body of POST /api/groups/{sessionId}/automations */
export const automationSchema = z.object({
    name: z.string().min(1).max(100),
    active: z.boolean().optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    scope: z.object({ all: z.boolean().optional(), tags: z.array(z.string()).optional(), jids: z.array(z.string()).optional() }),
    trigger: z.enum(["member_join", "member_leave", "message", "schedule"]),
    triggerConfig: triggerConfigSchema.default({}),
    actions: z.array(actionSchema).min(1).max(20),
    ignoreAdmins: z.boolean().optional(),
    cooldownSec: z.number().int().min(0).max(86400).optional(),
});

/** Body of PATCH: every field optional, and no defaults (a missing triggerConfig must not wipe the stored one) */
export const automationPatchSchema = automationSchema.extend({ triggerConfig: triggerConfigSchema.optional() }).partial();

/** Semantic checks zod can't express */
export function validateAutomation(body: { trigger: string; triggerConfig: { cron?: string; match?: string; pattern?: string; keywords?: string[] } }) {
    if (body.trigger === "schedule") {
        if (!body.triggerConfig.cron) throw new GroupError("schedule automations need triggerConfig.cron, e.g. \"0 22 * * *\"");
        try { CronExpressionParser.parse(body.triggerConfig.cron); } catch { throw new GroupError(`Invalid cron expression "${body.triggerConfig.cron}"`); }
    }
    if (body.trigger === "message") {
        const m = body.triggerConfig.match ?? "contains";
        if (["contains", "exact", "starts_with"].includes(m) && !body.triggerConfig.keywords?.length) throw new GroupError(`match "${m}" needs keywords`);
        if (m === "regex") {
            try { new RegExp(body.triggerConfig.pattern || ""); } catch { throw new GroupError("Invalid regex pattern"); }
            if (!body.triggerConfig.pattern) throw new GroupError("match \"regex\" needs pattern");
        }
    }
}
