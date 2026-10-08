import { NextResponse, NextRequest } from "next/server";
import { ZodError } from "zod";
import { getAuthenticatedUser, canAccessSession } from "./api-auth";
import { GroupError } from "@/modules/groups/service";

type User = NonNullable<Awaited<ReturnType<typeof getAuthenticatedUser>>>;

/**
 * Auth + session access + uniform JSON errors for session-scoped routes.
 * The handler returns plain data (wrapped as { status: true, data }) or a NextResponse.
 */
export async function withSession(
    request: NextRequest,
    sessionId: string,
    handler: (user: User) => Promise<unknown>
): Promise<NextResponse> {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    if (!(await canAccessSession(user.id, user.role, sessionId))) {
        return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden" }, { status: 403 });
    }
    try {
        const result = await handler(user);
        if (result instanceof NextResponse) return result;
        return NextResponse.json({ status: true, message: "OK", data: result ?? null });
    } catch (e) {
        if (e instanceof GroupError) {
            return NextResponse.json({ status: false, message: e.message, error: e.message }, { status: e.status });
        }
        if (e instanceof ZodError) {
            return NextResponse.json({ status: false, message: "Invalid request body", error: e.flatten() }, { status: 400 });
        }
        console.error("Route error:", e);
        const message = e instanceof Error ? e.message : "Internal error";
        return NextResponse.json({ status: false, message, error: message }, { status: 500 });
    }
}

export async function readJson(request: NextRequest): Promise<unknown> {
    try { return await request.json(); } catch { return {}; }
}
