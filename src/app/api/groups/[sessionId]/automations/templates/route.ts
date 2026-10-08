import { NextRequest } from "next/server";
import { withSession } from "@/lib/route-helpers";
import { AUTOMATION_TEMPLATES } from "@/modules/groups/automations";

/** GET /api/groups/{sessionId}/automations/templates — ready-made rules to start from */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => Object.entries(AUTOMATION_TEMPLATES).map(([key, t]) => ({ key, ...t })));
}
