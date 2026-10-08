import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { findAccessibleWebhook } from "@/lib/webhook-access";
import { retryDeliveryNow } from "@/lib/webhook-delivery";

/**
 * POST /api/webhooks/{sessionId}/{id}/deliveries/{deliveryId}/retry
 * Re-queue a failed (or pending) delivery with a fresh set of attempts and try it now.
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; id: string; deliveryId: string }> }
) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId, id, deliveryId } = await params;
    if (!(await canAccessSession(user.id, user.role, sessionId))) {
        return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden" }, { status: 403 });
    }

    const webhook = await findAccessibleWebhook(sessionId, id, user.id);
    if (!webhook) {
        return NextResponse.json({ status: false, message: "Webhook not found", error: "Webhook not found" }, { status: 404 });
    }

    const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, webhookId: id }, select: { status: true } });
    if (!delivery) {
        return NextResponse.json({ status: false, message: "Delivery not found", error: "Delivery not found" }, { status: 404 });
    }

    try {
        const queued = await retryDeliveryNow(deliveryId);
        if (!queued) {
            return NextResponse.json({ status: false, message: `Cannot retry a delivery that is ${delivery.status}`, error: "Invalid state" }, { status: 409 });
        }
        const updated = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
        return NextResponse.json({ status: true, message: "Delivery retried", data: updated });
    } catch (error) {
        console.error("Error retrying webhook delivery:", error);
        return NextResponse.json({ status: false, message: "Failed to retry delivery", error: "Failed to retry delivery" }, { status: 500 });
    }
}
