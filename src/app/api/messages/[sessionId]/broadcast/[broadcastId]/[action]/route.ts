import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { pauseCampaign, resumeCampaign, cancelCampaign } from "@/modules/whatsapp/broadcast-queue";

/** POST /api/messages/{sessionId}/broadcast/{broadcastId}/{pause|resume|cancel} */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; broadcastId: string; action: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId, broadcastId, action } = await params;

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
        }

        const log = await prisma.broadcastLog.findFirst({ where: { id: broadcastId, sessionId }, select: { id: true, status: true } });
        if (!log) {
            return NextResponse.json({ status: false, message: "Broadcast not found", error: "Broadcast not found" }, { status: 404 });
        }

        let changed: boolean;
        if (action === "pause") changed = await pauseCampaign(broadcastId);
        else if (action === "resume") changed = await resumeCampaign(broadcastId);
        else if (action === "cancel") changed = await cancelCampaign(broadcastId);
        else {
            return NextResponse.json({ status: false, message: "Unknown action. Use pause, resume or cancel", error: "Unknown action" }, { status: 400 });
        }

        if (!changed) {
            return NextResponse.json({ status: false, message: `Cannot ${action} a broadcast that is ${log.status}`, error: "Invalid state" }, { status: 409 });
        }

        const updated = await prisma.broadcastLog.findUnique({ where: { id: broadcastId } });
        return NextResponse.json({ status: true, message: `Broadcast ${action}d`, data: updated });
    } catch (e) {
        console.error("Broadcast action error", e);
        return NextResponse.json({ status: false, message: "Failed to update broadcast", error: "Failed to update broadcast" }, { status: 500 });
    }
}
