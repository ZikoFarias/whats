import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { sendToGroup, assertGroupJid } from "@/modules/groups/service";

const schema = z.object({
    text: z.string().optional(),
    media: z.object({ type: z.enum(["image", "video", "document", "audio"]), url: z.string().url(), fileName: z.string().optional() }).optional(),
    mentionAll: z.boolean().optional(),
    mentions: z.array(z.string()).optional(),
    replyToMessageId: z.string().optional(),
});

/** POST /api/groups/{sessionId}/{jid}/send — text/media to the group, optionally mentioning everyone (@todos) */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string; jid: string }> }) {
    const { sessionId, jid } = await params;
    return withSession(request, sessionId, async () => sendToGroup(sessionId, assertGroupJid(jid), schema.parse(await readJson(request))));
}
