import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { createGroup } from "@/modules/groups/service";

const schema = z.object({
    subject: z.string().min(1).max(100),
    participants: z.array(z.string().min(3)).min(1).max(200), // phones (any format) or JIDs
    description: z.string().max(2048).optional(),
    tags: z.array(z.string()).optional(),
    announce: z.boolean().optional(), // start closed (only admins send)
});

/** POST /api/groups/{sessionId}/create — create a group; response keeps the { group } shape */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => {
        const body = schema.parse(await readJson(request));
        const group = await createGroup(sessionId, body.subject, body.participants, body);
        return { group: { id: group.jid, subject: group.subject } };
    });
}
