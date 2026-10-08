import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { createBroadcastCampaign } from "@/modules/whatsapp/broadcast-queue";
import { z } from "zod";

const recipientSchema = z.union([
    z.string().min(1),
    z.object({
        jid: z.string().optional(),
        phone: z.string().optional(),
        number: z.string().optional(),
        variables: z.record(z.string(), z.string()).optional()
    }).refine(r => !!(r.jid || r.phone || r.number), { message: "recipient needs jid, phone or number" })
]);

const broadcastBodySchema = z.object({
    recipients: z.array(recipientSchema).min(1),
    message: z.string().default(""),
    media: z.object({
        type: z.enum(["image", "video", "document"]),
        url: z.string().url(),
        fileName: z.string().optional()
    }).optional(),
    delay: z.number().int().positive().optional(),
    name: z.string().max(100).optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    mentionAll: z.boolean().optional(),
    respectHours: z.boolean().optional()
}).refine(b => b.message.trim().length > 0 || !!b.media, { message: "message or media is required" });

/**
 * Queue a broadcast campaign. Sending happens in the background worker, which
 * survives restarts and applies per-number rate limits. Track progress via the
 * "broadcast.progress" socket event or GET .../broadcast/history/{broadcastId}.
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;
        const body = await request.json();

        const parseResult = broadcastBodySchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json({ status: false, message: "Invalid request body", error: parseResult.error.flatten() }, { status: 400 });
        }

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
        }

        const { recipients, message, media, delay, name, scheduledAt, mentionAll, respectHours } = parseResult.data;
        const result = await createBroadcastCampaign({
            sessionId, recipients, message, media, delay, name, mentionAll, respectHours,
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        });

        return NextResponse.json({
            status: true,
            message: "Broadcast queued",
            data: result
        });
    } catch (e) {
        console.error("Broadcast error", e);
        return NextResponse.json({ status: false, message: "Failed to start broadcast", error: "Failed to start broadcast" }, { status: 500 });
    }
}
