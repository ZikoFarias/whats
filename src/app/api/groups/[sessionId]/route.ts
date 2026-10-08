import { prisma } from "@/lib/prisma";
import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { listGroups } from "@/modules/groups/service";

// GET: List groups for a session
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;

        // Verify access
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        // Get internal ID
        const session = await prisma.session.findUnique({
            where: { sessionId: sessionId },
            select: { id: true }
        });

        if (!session) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        // ?view=summary returns the groups module listing (filters, tags, roles) instead of raw rows
        const q = new URL(request.url).searchParams;
        if (q.get("view") === "summary") {
            const data = await listGroups(sessionId, {
                search: q.get("search") ?? undefined,
                tag: q.get("tag") ?? undefined,
                adminOnly: q.get("adminOnly") === "true",
                includeLeft: q.get("includeLeft") === "true",
                communities: (q.get("communities") as "only" | "exclude" | null) ?? undefined,
                sort: (q.get("sort") as "name" | "size" | "activity" | null) ?? undefined,
            });
            return NextResponse.json({ status: true, message: "Groups retrieved successfully", data });
        }

        const groups = await prisma.group.findMany({
            where: { sessionId: session.id },
            orderBy: { subject: 'asc' }
        });

        return NextResponse.json({ status: true, message: "Groups retrieved successfully", data: groups });
    } catch (error) {
        console.error("Get groups error:", error);
        return NextResponse.json({ status: false, message: "Failed to fetch groups", error: "Failed to fetch groups" }, { status: 500 });
    }
}
