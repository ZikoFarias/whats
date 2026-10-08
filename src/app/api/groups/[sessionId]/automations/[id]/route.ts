import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withSession, readJson } from "@/lib/route-helpers";
import { dbSession, GroupError } from "@/modules/groups/service";
import { automationPatchSchema, validateAutomation } from "@/modules/groups/schemas";

type P = { params: Promise<{ sessionId: string; id: string }> };

async function find(sessionId: string, id: string) {
    const s = await dbSession(sessionId);
    const rule = await prisma.groupAutomation.findFirst({ where: { id, sessionId: s.id } });
    if (!rule) throw new GroupError("Automation not found", 404);
    return rule;
}

/** PATCH /api/groups/{sessionId}/automations/{id} — partial update (e.g. { "active": false }) */
export async function PATCH(request: NextRequest, { params }: P) {
    const { sessionId, id } = await params;
    return withSession(request, sessionId, async () => {
        const current = await find(sessionId, id);
        const body = automationPatchSchema.parse(await readJson(request));
        validateAutomation({
            trigger: body.trigger ?? current.trigger,
            triggerConfig: (body.triggerConfig ?? current.triggerConfig) as { cron?: string; match?: string; pattern?: string; keywords?: string[] },
        });
        return prisma.groupAutomation.update({ where: { id }, data: body });
    });
}

/** DELETE /api/groups/{sessionId}/automations/{id} */
export async function DELETE(request: NextRequest, { params }: P) {
    const { sessionId, id } = await params;
    return withSession(request, sessionId, async () => {
        await find(sessionId, id);
        await prisma.groupAutomation.delete({ where: { id } });
        return { deleted: true };
    });
}
