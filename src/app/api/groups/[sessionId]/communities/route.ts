import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { createCommunity, linkToCommunity, assertGroupJid } from "@/modules/groups/service";

const schema = z.union([
    z.object({ action: z.literal("create"), subject: z.string().min(1).max(100), description: z.string().max(2048).default("") }),
    z.object({ action: z.enum(["link", "unlink"]), communityJid: z.string(), groupJid: z.string() }),
]);

/**
 * POST /api/groups/{sessionId}/communities
 * { "action": "create", "subject": "...", "description": "..." }
 * { "action": "link" | "unlink", "communityJid": "...@g.us", "groupJid": "...@g.us" }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => {
        const body = schema.parse(await readJson(request));
        if (body.action === "create") return createCommunity(sessionId, body.subject, body.description);
        await linkToCommunity(sessionId, assertGroupJid(body.communityJid), assertGroupJid(body.groupJid), body.action === "unlink");
        return { done: true };
    });
}
