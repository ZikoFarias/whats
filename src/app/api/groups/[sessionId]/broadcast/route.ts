import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { GroupError, resolveGroupTargets } from "@/modules/groups/service";
import { createBroadcastCampaign } from "@/modules/whatsapp/broadcast-queue";

const media = z.object({ type: z.enum(["image", "video", "document"]), url: z.string().url(), fileName: z.string().optional() });
const step = z.object({
    sendAt: z.string().datetime({ offset: true }).optional(), // ISO; omitted = now
    message: z.string().default(""),
    media: media.optional(),
    mentionAll: z.boolean().optional(),
    name: z.string().max(100).optional(),
});

const schema = z.object({
    target: z.object({
        all: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        jids: z.array(z.string()).optional(),
        adminOnly: z.boolean().optional(), // only groups where this number is admin
    }),
    delaySeconds: z.number().int().min(5).max(600).optional(),
    respectHours: z.boolean().optional(), // default false for groups
    // Either a single message...
    message: z.string().optional(),
    media: media.optional(),
    mentionAll: z.boolean().optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    name: z.string().max(100).optional(),
    // ...or a sequence (e.g. launch: "tomorrow 9h warm-up", "20h live starting", "20h05 link")
    sequence: z.array(step).min(1).max(50).optional(),
});

/**
 * POST /api/groups/{sessionId}/broadcast
 * Send to many groups through the broadcast queue (delays, retries on restart, pause/cancel).
 *
 * { "target": { "tags": ["lancamento"] }, "message": "Começa às 20h!", "mentionAll": true, "scheduledAt": "2026-10-10T19:55:00-03:00" }
 * { "target": { "all": true }, "sequence": [ { "sendAt": "...", "message": "..." }, { "sendAt": "...", "message": "...", "mentionAll": true } ] }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => {
        const body = schema.parse(await readJson(request));
        const groups = await resolveGroupTargets(sessionId, body.target);
        if (!groups.length) throw new GroupError("No groups match the target (check tags/jids, and that this number is in them)");

        const steps = body.sequence ?? [{ sendAt: body.scheduledAt, message: body.message ?? "", media: body.media, mentionAll: body.mentionAll, name: body.name }];
        for (const s of steps) if (!s.message.trim() && !s.media) throw new GroupError("Each message needs text or media");

        const sequenceId = body.sequence ? randomUUID() : undefined;
        const campaigns = [];
        for (const [i, s] of steps.entries()) {
            campaigns.push(await createBroadcastCampaign({
                sessionId,
                recipients: groups.map(g => g.jid),
                message: s.message,
                media: s.media,
                mentionAll: s.mentionAll,
                scheduledAt: s.sendAt ? new Date(s.sendAt) : null,
                delay: body.delaySeconds ? body.delaySeconds * 1000 : undefined,
                respectHours: body.respectHours ?? false,
                name: s.name ?? (body.sequence ? `${body.name ?? "Sequência"} #${i + 1}` : body.name),
                sequenceId,
            }));
        }
        return { groups: groups.map(g => ({ jid: g.jid, subject: g.subject })), sequenceId: sequenceId ?? null, campaigns };
    });
}
