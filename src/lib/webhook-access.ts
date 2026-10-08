import { prisma } from "./prisma";

/** Webhook visible to this user under the given session (CUID or WhatsApp sessionId), or null */
export async function findAccessibleWebhook(sessionId: string, webhookId: string, userId: string) {
    const session = await prisma.session.findFirst({
        where: { OR: [{ id: sessionId }, { sessionId }] },
        select: { id: true },
    });
    if (!session) return null;
    return prisma.webhook.findFirst({
        where: {
            id: webhookId,
            OR: [{ sessionId: session.id }, { sessionId: null, userId }],
        },
    });
}
