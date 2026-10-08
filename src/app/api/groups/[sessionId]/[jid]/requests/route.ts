import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { listJoinRequests, answerJoinRequests, assertGroupJid } from "@/modules/groups/service";

type P = { params: Promise<{ sessionId: string; jid: string }> };

/** GET /api/groups/{sessionId}/{jid}/requests — pending join requests */
export async function GET(request: NextRequest, { params }: P) {
    const { sessionId, jid } = await params;
    return withSession(request, sessionId, () => listJoinRequests(sessionId, assertGroupJid(jid)));
}

const schema = z.object({ action: z.enum(["approve", "reject"]), participants: z.array(z.string()).optional() });

/** POST /api/groups/{sessionId}/{jid}/requests — { "action": "approve" | "reject", "participants"?: [...] } (omit participants = all pending) */
export async function POST(request: NextRequest, { params }: P) {
    const { sessionId, jid } = await params;
    return withSession(request, sessionId, async () => {
        const body = schema.parse(await readJson(request));
        return answerJoinRequests(sessionId, assertGroupJid(jid), body.action, body.participants);
    });
}
