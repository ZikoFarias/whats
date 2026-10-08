import { NextRequest } from "next/server";
import { withSession } from "@/lib/route-helpers";
import { groupsOverview } from "@/modules/groups/analytics";

/** GET /api/groups/{sessionId}/analytics?days=7 — every group side by side (members, joins, leaves, messages) */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    const days = Number(new URL(request.url).searchParams.get("days") || 7);
    return withSession(request, sessionId, () => groupsOverview(sessionId, days));
}
