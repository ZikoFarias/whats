import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/api-auth";
import { serializeApiKey } from "@/lib/api-keys";

/** DELETE /api/api-keys/{id} — revoke a key (kept for audit, stops working immediately) */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const key = await prisma.apiKey.findFirst({ where: { id, userId: user.id } });
    if (!key) {
        return NextResponse.json({ status: false, message: "API key not found", error: "Not found" }, { status: 404 });
    }
    if (key.revokedAt) {
        return NextResponse.json({ status: true, message: "API key already revoked", data: serializeApiKey(key) });
    }

    const updated = await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return NextResponse.json({ status: true, message: "API key revoked", data: serializeApiKey(updated) });
}
