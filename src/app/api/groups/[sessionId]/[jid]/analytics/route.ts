import { NextRequest } from "next/server";
import { withSession } from "@/lib/route-helpers";
import { groupAnalytics } from "@/modules/groups/analytics";
import { assertGroupJid } from "@/modules/groups/service";

/**
 * GET /api/groups/{sessionId}/{jid}/analytics?days=30&inactiveDays=30
 * Growth (joins/leaves per day), activity per day/hour/weekday, best hours to post,
 * top members and inactive members.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string; jid: string }> }) {
    const { sessionId, jid } = await params;
    const q = new URL(request.url).searchParams;
    return withSession(request, sessionId, () => groupAnalytics(sessionId, assertGroupJid(jid), Number(q.get("days") || 30), Number(q.get("inactiveDays") || 30)));
}
