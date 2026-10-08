import { NextResponse, NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { API_KEY_SCOPES, createApiKey, isValidScope, serializeApiKey, type ApiKeyScope } from "@/lib/api-keys";

const createSchema = z.object({
    name: z.string().trim().min(1).max(60),
    scopes: z.array(z.string()).min(1).refine(s => s.every(isValidScope), { message: `scopes must be "*" or any of: ${Object.keys(API_KEY_SCOPES).join(", ")}` }),
    sessionIds: z.array(z.string().min(1)).optional(),
    expiresInDays: z.number().int().positive().max(3650).optional(),
});

/** GET /api/api-keys — the current user's keys (never the key itself) plus available scopes */
export async function GET(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }

    const keys = await prisma.apiKey.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    return NextResponse.json({
        status: true,
        message: "API keys retrieved",
        data: { keys: keys.map(serializeApiKey), scopes: API_KEY_SCOPES },
    });
}

/** POST /api/api-keys — create a key; the full key is returned only in this response */
export async function POST(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ status: false, message: "Invalid request body", error: parsed.error.flatten() }, { status: 400 });
    }
    const { name, scopes, sessionIds, expiresInDays } = parsed.data;

    // A key can only be limited to sessions its owner can use
    for (const sid of sessionIds ?? []) {
        if (!(await canAccessSession(user.id, user.role, sid))) {
            return NextResponse.json({ status: false, message: `Cannot access session "${sid}"`, error: "Forbidden" }, { status: 403 });
        }
    }

    const { key, record } = await createApiKey({
        userId: user.id,
        name,
        scopes: [...new Set(scopes)] as ApiKeyScope[],
        sessionIds: sessionIds ? [...new Set(sessionIds)] : null,
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null,
    });

    return NextResponse.json({
        status: true,
        message: "API key created. Store it now: it will not be shown again.",
        data: { ...serializeApiKey(record), key },
    }, { status: 201 });
}
