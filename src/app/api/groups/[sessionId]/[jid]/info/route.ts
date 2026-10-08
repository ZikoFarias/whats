import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { getGroup, updateGroupInfo, listMembers, assertGroupJid } from "@/modules/groups/service";

type P = { params: Promise<{ sessionId: string; jid: string }> };

/**
 * GET /api/groups/{sessionId}/{jid}/info?members=active|left|all&role=admin&search=&inactiveDays=30&sort=activity|messages|joined|name
 * Group details from the local database plus its member list with activity.
 */
export async function GET(request: NextRequest, { params }: P) {
    const { sessionId, jid } = await params;
    const q = new URL(request.url).searchParams;
    return withSession(request, sessionId, async () => {
        const groupJid = assertGroupJid(jid);
        const group = await getGroup(sessionId, groupJid);
        const members = await listMembers(sessionId, groupJid, {
            status: (q.get("members") as "active" | "left" | "all" | null) ?? "active",
            role: q.get("role") ?? undefined,
            search: q.get("search") ?? undefined,
            inactiveDays: q.get("inactiveDays") ? Number(q.get("inactiveDays")) : undefined,
            sort: (q.get("sort") as "activity" | "messages" | "joined" | "name" | null) ?? undefined,
        });
        return { ...group, members };
    });
}

const schema = z.object({ tags: z.array(z.string().max(40)).max(30).optional(), notes: z.string().max(5000).nullable().optional() });

/** PATCH /api/groups/{sessionId}/{jid}/info — local organization: { "tags": [...], "notes": "..." } */
export async function PATCH(request: NextRequest, { params }: P) {
    const { sessionId, jid } = await params;
    return withSession(request, sessionId, async () => {
        await updateGroupInfo(sessionId, assertGroupJid(jid), schema.parse(await readJson(request)));
        return getGroup(sessionId, assertGroupJid(jid));
    });
}
