import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withSession, readJson } from "@/lib/route-helpers";
import { dbSession } from "@/modules/groups/service";
import { automationSchema, validateAutomation } from "@/modules/groups/schemas";

type P = { params: Promise<{ sessionId: string }> };


/** GET /api/groups/{sessionId}/automations */
export async function GET(request: NextRequest, { params }: P) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => {
        const s = await dbSession(sessionId);
        return prisma.groupAutomation.findMany({ where: { sessionId: s.id }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    });
}

/** POST /api/groups/{sessionId}/automations — create a rule (see GET .../automations/templates for examples) */
export async function POST(request: NextRequest, { params }: P) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => {
        const body = automationSchema.parse(await readJson(request));
        validateAutomation(body);
        const s = await dbSession(sessionId);
        return prisma.groupAutomation.create({ data: { sessionId: s.id, ...body } });
    });
}
