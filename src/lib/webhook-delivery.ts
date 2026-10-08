import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * Webhook outbox.
 *
 * Every event for every subscribed webhook becomes a WebhookDelivery row, so a
 * receiver that is down, slow or erroring does not lose events. Delivery is
 * attempted right away; failures are retried with exponential backoff by a
 * worker in the server process, also across restarts.
 *
 * Retried: network errors, timeouts, 408, 429 and 5xx. Other 4xx responses are
 * treated as permanent (the receiver rejected the payload) and fail at once.
 * Delivery is at-least-once: receivers should dedupe on the X-Webhook-Delivery header.
 */

export interface WebhookPayload {
    event: string;
    sessionId: string;
    timestamp: string;
    data: unknown;
}

type WebhookTarget = { id: string; url: string; secret: string | null };

// Delay before retry N (1-based count of failed attempts); last value repeats
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600, 7200, 14400];
const WORKER_INTERVAL_MS = 5000;
const WORKER_BATCH = 20;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
    const v = parseInt(process.env[name] || "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

const maxAttempts = () => envInt("WEBHOOK_MAX_ATTEMPTS", 10);
const timeoutMs = () => envInt("WEBHOOK_TIMEOUT_MS", 10000);

function jsonReplacer(_key: string, value: unknown) {
    return typeof value === "bigint" ? value.toString() : value;
}

/** Backoff with ±20% jitter so many failed deliveries don't retry in lockstep */
export function retryDelayMs(failedAttempts: number): number {
    const base = BACKOFF_SECONDS[Math.min(Math.max(failedAttempts, 1), BACKOFF_SECONDS.length) - 1] * 1000;
    return Math.round(base * (0.8 + Math.random() * 0.4));
}

export function isRetryableStatus(status: number | null): boolean {
    if (status === null) return true; // network error / timeout
    return status === 408 || status === 429 || status >= 500;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface SendResult {
    ok: boolean;
    statusCode: number | null;
    responseBody: string | null;
    responseTimeMs: number;
    error: string | null;
    headers: Record<string, string>;
}

async function sendSigned(
    url: string,
    payload: unknown,
    secret: string | null,
    meta: { deliveryId: string; attempt: number; event: string }
): Promise<SendResult> {
    const body = JSON.stringify(payload, jsonReplacer);
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "WA-AKG-Webhook/1.0",
        "X-Webhook-Delivery": meta.deliveryId,
        "X-Webhook-Event": meta.event,
        "X-Webhook-Attempt": String(meta.attempt),
    };
    if (secret) {
        headers["X-Webhook-Signature"] = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    }

    const startedAt = Date.now();
    try {
        const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs()) });
        let responseBody = await response.text().catch(() => null);
        if (responseBody && responseBody.length > 1024) responseBody = responseBody.substring(0, 1024);
        return {
            ok: response.ok,
            statusCode: response.status,
            responseBody,
            responseTimeMs: Date.now() - startedAt,
            error: response.ok ? null : `Webhook returned ${response.status}: ${response.statusText}`,
            headers,
        };
    } catch (err) {
        return {
            ok: false,
            statusCode: null,
            responseBody: null,
            responseTimeMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : "Webhook request failed",
            headers,
        };
    }
}

// ---------------------------------------------------------------------------
// Delivery log (one row per HTTP attempt, kept for the dashboard)
// ---------------------------------------------------------------------------

async function recordAttemptLog(data: {
    webhookId: string;
    deliveryId: string;
    attempt: number;
    event: string;
    url: string;
    payload: unknown;
    result: SendResult;
}) {
    await prisma.webhookLog.create({
        data: {
            webhookId: data.webhookId,
            deliveryId: data.deliveryId,
            attempt: data.attempt,
            event: data.event,
            status: data.result.ok ? "SUCCESS" : "FAILED",
            requestUrl: data.url,
            requestHeaders: data.result.headers,
            requestBody: (data.payload ?? undefined) as Prisma.InputJsonValue | undefined,
            responseStatusCode: data.result.statusCode,
            responseBody: data.result.responseBody,
            responseTimeMs: data.result.responseTimeMs,
            errorMessage: data.result.error,
        },
    });
    cleanupOldLogs(data.webhookId).catch(err => logger.error("Webhook", "Failed to cleanup old logs:", err));
}

async function cleanupOldLogs(webhookId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.webhookLog.deleteMany({ where: { webhookId, createdAt: { lt: thirtyDaysAgo } } });

    const logs = await prisma.webhookLog.findMany({
        where: { webhookId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
        skip: 500,
    });
    if (logs.length) {
        await prisma.webhookLog.deleteMany({ where: { id: { in: logs.map(l => l.id) } } });
    }
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/** Store the event for this webhook and try to deliver it immediately */
export async function enqueueWebhookDelivery(webhook: WebhookTarget, payload: WebhookPayload) {
    const json = JSON.parse(JSON.stringify(payload, jsonReplacer)) as Prisma.InputJsonValue;
    const delivery = await prisma.webhookDelivery.create({
        data: { webhookId: webhook.id, event: payload.event, payload: json, status: "pending", nextAttemptAt: new Date() },
        select: { id: true },
    });
    attemptDelivery(delivery.id).catch(err => logger.error("Webhook", `Delivery ${delivery.id} attempt crashed:`, err));
    return delivery.id;
}

/** One delivery attempt; safe to call concurrently (the row is claimed atomically) */
export async function attemptDelivery(deliveryId: string) {
    const claimed = await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId, status: "pending" },
        data: { status: "delivering", attempts: { increment: 1 } },
    });
    if (!claimed.count) return;

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { webhook: true } });
    if (!delivery) return;

    if (!delivery.webhook.isActive) {
        await prisma.webhookDelivery.update({
            where: { id: deliveryId },
            data: { status: "failed", lastError: "Webhook is disabled" },
        });
        return;
    }

    const result = await sendSigned(delivery.webhook.url, delivery.payload, delivery.webhook.secret, {
        deliveryId,
        attempt: delivery.attempts,
        event: delivery.event,
    });

    await recordAttemptLog({
        webhookId: delivery.webhookId,
        deliveryId,
        attempt: delivery.attempts,
        event: delivery.event,
        url: delivery.webhook.url,
        payload: delivery.payload,
        result,
    }).catch(err => logger.error("Webhook", "Failed to save webhook log:", err));

    if (result.ok) {
        await prisma.webhookDelivery.update({
            where: { id: deliveryId },
            data: { status: "delivered", deliveredAt: new Date(), lastStatusCode: result.statusCode, lastError: null },
        });
        return;
    }

    const retryable = isRetryableStatus(result.statusCode);
    if (!retryable || delivery.attempts >= maxAttempts()) {
        await prisma.webhookDelivery.update({
            where: { id: deliveryId },
            data: { status: "failed", lastStatusCode: result.statusCode, lastError: result.error },
        });
        logger.warn("Webhook", `Delivery ${deliveryId} (${delivery.event} -> ${delivery.webhook.url}) failed permanently after ${delivery.attempts} attempt(s): ${result.error}`);
        return;
    }

    const delay = retryDelayMs(delivery.attempts);
    await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
            status: "pending",
            nextAttemptAt: new Date(Date.now() + delay),
            lastStatusCode: result.statusCode,
            lastError: result.error,
        },
    });
    logger.warn("Webhook", `Delivery ${deliveryId} attempt ${delivery.attempts} failed (${result.error}); retrying in ${Math.round(delay / 1000)}s`);
}

/** Put a failed (or pending) delivery back in the queue with a fresh set of attempts */
export async function retryDeliveryNow(deliveryId: string): Promise<boolean> {
    const res = await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId, status: { in: ["failed", "pending"] } },
        data: { status: "pending", attempts: 0, nextAttemptAt: new Date() },
    });
    if (!res.count) return false;
    await attemptDelivery(deliveryId);
    return true;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

let workerStarted = false;
let workerBusy = false;

async function processDue() {
    if (workerBusy) return;
    workerBusy = true;
    try {
        const due = await prisma.webhookDelivery.findMany({
            where: { status: "pending", nextAttemptAt: { lte: new Date() } },
            orderBy: { nextAttemptAt: "asc" },
            take: WORKER_BATCH,
            select: { id: true },
        });
        await Promise.all(due.map(d => attemptDelivery(d.id).catch(err =>
            logger.error("Webhook", `Delivery ${d.id} attempt crashed:`, err))));
    } catch (e) {
        logger.error("Webhook", "Delivery worker tick failed:", e);
    } finally {
        workerBusy = false;
    }
}

async function cleanupDeliveries() {
    const now = Date.now();
    await prisma.webhookDelivery.deleteMany({
        where: { status: "delivered", createdAt: { lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
    });
    await prisma.webhookDelivery.deleteMany({
        where: { status: "failed", createdAt: { lt: new Date(now - 30 * 24 * 60 * 60 * 1000) } },
    });
}

export async function startWebhookWorker() {
    if (workerStarted) return;
    workerStarted = true;

    // Attempts interrupted by a restart: send again (receivers dedupe on X-Webhook-Delivery)
    const recovered = await prisma.webhookDelivery.updateMany({
        where: { status: "delivering" },
        data: { status: "pending", nextAttemptAt: new Date() },
    }).catch(() => ({ count: 0 }));
    if (recovered.count) logger.warn("Webhook", `Re-queued ${recovered.count} delivery(ies) interrupted by a restart`);

    setInterval(processDue, WORKER_INTERVAL_MS);
    setInterval(() => cleanupDeliveries().catch(err => logger.error("Webhook", "Delivery cleanup failed:", err)), CLEANUP_INTERVAL_MS);
    logger.info("Webhook", "Webhook delivery worker started");
}
