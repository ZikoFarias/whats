import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { findAccessibleWebhook } from "@/lib/webhook-access";

const STATUSES = ["pending", "delivering", "delivered", "failed"];

/**
 * GET /api/webhooks/{sessionId}/{id}/deliveries?status=failed&limit=50&offset=0
 * Outbox entries for this webhook, newest first, plus counts per status.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; id: string }> }
) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId, id } = await params;
    if (!(await canAccessSession(user.id, user.role, sessionId))) {
        return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden" }, { status: 403 });
    }

    const webhook = await findAccessibleWebhook(sessionId, id, user.id);
    if (!webhook) {
        return NextResponse.json({ status: false, message: "Webhook not found", error: "Webhook not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get("status");
    if (statusFilter && !STATUSES.includes(statusFilter)) {
        return NextResponse.json({ status: false, message: `status must be one of ${STATUSES.join(", ")}`, error: "Invalid status" }, { status: 400 });
    }
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50") || 50, 1), 200);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0") || 0, 0);
    const where = { webhookId: id, ...(statusFilter ? { status: statusFilter } : {}) };

    try {
        const [deliveries, total, grouped] = await Promise.all([
            prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
            prisma.webhookDelivery.count({ where }),
            prisma.webhookDelivery.groupBy({ by: ["status"], where: { webhookId: id }, _count: { _all: true } }),
        ]);
        const counts = Object.fromEntries(STATUSES.map(s => [s, grouped.find(g => g.status === s)?._count._all ?? 0]));

        return NextResponse.json({
            status: true,
            message: "Webhook deliveries retrieved successfully",
            data: { deliveries, counts, pagination: { total, limit, offset, hasMore: offset + limit < total } },
        });
    } catch (error) {
        console.error("Error fetching webhook deliveries:", error);
        return NextResponse.json({ status: false, message: "Failed to fetch webhook deliveries", error: "Failed to fetch webhook deliveries" }, { status: 500 });
    }
}
