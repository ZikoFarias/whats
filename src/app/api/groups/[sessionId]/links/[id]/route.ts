import { NextRequest } from "next/server";
import { withSession, readJson } from "@/lib/route-helpers";
import { updateLink, deleteLink } from "@/modules/groups/links";
import { linkSchema } from "@/modules/groups/schemas";

type P = { params: Promise<{ sessionId: string; id: string }> };

/** PATCH /api/groups/{sessionId}/links/{id} — change groups, limit, strategy, auto-create, active... */
export async function PATCH(request: NextRequest, { params }: P) {
    const { sessionId, id } = await params;
    return withSession(request, sessionId, async () => updateLink(sessionId, id, linkSchema.partial().parse(await readJson(request))));
}

/** DELETE /api/groups/{sessionId}/links/{id} */
export async function DELETE(request: NextRequest, { params }: P) {
    const { sessionId, id } = await params;
    return withSession(request, sessionId, async () => { await deleteLink(sessionId, id); return { deleted: true }; });
}
