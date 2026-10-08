import { NextRequest } from "next/server";
import { withSession } from "@/lib/route-helpers";
import { listGroupTags } from "@/modules/groups/service";

/** GET /api/groups/{sessionId}/tags — tags in use and how many groups have each */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, () => listGroupTags(sessionId));
}
