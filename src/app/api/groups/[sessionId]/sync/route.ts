import { NextRequest } from "next/server";
import { withSession } from "@/lib/route-helpers";
import { resync } from "@/modules/groups/service";

/** POST /api/groups/{sessionId}/sync — re-read every group (members, roles, settings) from WhatsApp */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, () => resync(sessionId));
}
