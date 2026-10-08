import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { resolveGroupTargets, updateMembersInGroups } from "@/modules/groups/service";

const schema = z.object({
    action: z.enum(["add", "remove", "promote", "demote"]),
    participants: z.array(z.string().min(3)).min(1).max(200),
    target: z.object({ all: z.boolean().optional(), tags: z.array(z.string()).optional(), jids: z.array(z.string()).optional() }),
});

/**
 * POST /api/groups/{sessionId}/bulk-members
 * Same member action in many groups, e.g. remove a spammer from every group:
 * { "action": "remove", "participants": ["5561999998888"], "target": { "all": true } }
 * Only groups where this number is admin are touched.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => {
        const body = schema.parse(await readJson(request));
        const groups = await resolveGroupTargets(sessionId, { ...body.target, adminOnly: true });
        return updateMembersInGroups(sessionId, groups.map(g => g.jid), body.action, body.participants);
    });
}
