import { NextRequest } from "next/server";
import { withSession, readJson } from "@/lib/route-helpers";
import { createLink, listLinks } from "@/modules/groups/links";
import { linkSchema } from "@/modules/groups/schemas";


type P = { params: Promise<{ sessionId: string }> };

/** GET /api/groups/{sessionId}/links — smart links with group fill status and clicks per group/source */
export async function GET(request: NextRequest, { params }: P) {
    const { sessionId } = await params;
    return withSession(request, sessionId, () => listLinks(sessionId));
}

/** POST /api/groups/{sessionId}/links — create; the public URL is BASE_URL/g/{slug} */
export async function POST(request: NextRequest, { params }: P) {
    const { sessionId } = await params;
    return withSession(request, sessionId, async () => createLink(sessionId, linkSchema.parse(await readJson(request))));
}
