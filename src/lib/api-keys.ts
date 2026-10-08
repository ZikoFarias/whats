import crypto from "crypto";
import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * Per-integration API keys.
 *
 * Keys look like "wak_<43 base64url chars>" and are shown once at creation;
 * only their SHA-256 hash is stored. Each key has scopes and, optionally, a
 * list of WhatsApp sessions it may use. Scope and session checks run in the
 * custom server before any route (see checkApiKeyRequest), so every API route
 * is covered without per-route changes.
 */

export const API_KEY_PREFIX = "wak_";

export const API_KEY_SCOPES = {
    read: "Read data: messages, chats, contacts, groups, sessions, broadcast history",
    send: "Send messages and media, chat actions (read, presence...), scheduled messages",
    broadcast: "Create and control broadcast campaigns",
    webhooks: "Manage webhooks and their deliveries",
    manage: "Manage contacts, groups, labels, profile, auto-replies, bot settings",
    admin: "Sessions (create, delete, connect, logout), users, settings, API keys, system",
} as const;

export type ApiKeyScope = keyof typeof API_KEY_SCOPES | "*";

export function isValidScope(scope: string): scope is ApiKeyScope {
    return scope === "*" || scope in API_KEY_SCOPES;
}

export function hashApiKey(rawKey: string): string {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateRawApiKey(): string {
    return API_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export async function createApiKey(params: {
    userId: string;
    name: string;
    scopes: ApiKeyScope[];
    sessionIds?: string[] | null;
    expiresAt?: Date | null;
}) {
    const raw = generateRawApiKey();
    const record = await prisma.apiKey.create({
        data: {
            userId: params.userId,
            name: params.name,
            prefix: raw.slice(0, 12),
            keyHash: hashApiKey(raw),
            scopes: params.scopes,
            sessionIds: params.sessionIds && params.sessionIds.length ? params.sessionIds : undefined,
            expiresAt: params.expiresAt ?? null,
        },
    });
    return { key: raw, record };
}

/** Public view of a key record (never includes the hash) */
export function serializeApiKey(k: {
    id: string; name: string; prefix: string; scopes: unknown; sessionIds: unknown;
    lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date;
}) {
    return {
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        sessionIds: k.sessionIds ?? null,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        createdAt: k.createdAt,
        active: !k.revokedAt && (!k.expiresAt || k.expiresAt > new Date()),
    };
}

export interface ResolvedApiKey {
    id: string;
    name: string;
    scopes: string[];
    sessionIds: string[] | null;
    user: { id: string; email: string; name: string | null; role: string };
}

/** Look up an active key by its raw value; null if unknown, revoked or expired */
export async function resolveApiKey(rawKey: string): Promise<ResolvedApiKey | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) return null;
    const key = await prisma.apiKey.findUnique({
        where: { keyHash: hashApiKey(rawKey) },
        include: { user: { select: { id: true, email: true, name: true, role: true } } },
    });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) return null;

    // Track usage, at most once a minute per key
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
        prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
            .catch(err => logger.error("Auth", "Failed to update API key lastUsedAt:", err));
    }

    return {
        id: key.id,
        name: key.name,
        scopes: Array.isArray(key.scopes) ? (key.scopes as string[]) : [],
        sessionIds: Array.isArray(key.sessionIds) ? (key.sessionIds as string[]) : null,
        user: key.user,
    };
}

// ---------------------------------------------------------------------------
// Request authorization (scope + session)
// ---------------------------------------------------------------------------

/** Resources whose path is /api/<resource>/<sessionId>/... */
const SESSION_SCOPED_RESOURCES = new Set([
    "messages", "chat", "chats", "contacts", "groups", "labels", "profile",
    "scheduler", "webhooks", "autoreplies", "sessions",
]);

const ADMIN_RESOURCES = new Set(["users", "user", "settings", "system", "notifications", "api-keys"]);

/** Scope needed for an API call, derived from its method and path */
export function requiredScope(method: string, pathname: string): Exclude<ApiKeyScope, "*"> {
    const seg = pathname.split("/").filter(Boolean); // ["api", resource, ...]
    const resource = seg[1] || "";
    const isRead = method === "GET" || method === "HEAD";

    if (ADMIN_RESOURCES.has(resource)) return "admin";
    if (resource === "webhooks") return "webhooks";
    if (resource === "messages" && seg[3] === "broadcast") return isRead ? "read" : "broadcast";
    if (isRead) return "read";
    if (resource === "sessions") return seg[3] === "bot-config" ? "manage" : "admin";
    if (resource === "chat" && seg[3] === "check") return "read";
    if (resource === "groups" && seg[4] === "send") return "send";
    if (resource === "groups" && seg[3] === "broadcast") return "broadcast";
    if (["messages", "chat", "scheduler", "media"].includes(resource)) return "send";
    return "manage";
}

/** WhatsApp session referenced by the path, if any */
export function sessionIdFromPath(pathname: string): string | null {
    const seg = pathname.split("/").filter(Boolean);
    if (seg[0] !== "api") return null;
    // Media files are named {sessionId}-{messageId}.{ext}; sessionIds may contain "-"
    if (seg[1] === "media" && seg[2]) {
        const base = decodeURIComponent(seg[2]).replace(/\.[^.]+$/, "");
        const lastDash = base.lastIndexOf("-");
        return lastDash > 0 ? base.substring(0, lastDash) : null;
    }
    if (!SESSION_SCOPED_RESOURCES.has(seg[1] || "")) return null;
    return seg[2] ? decodeURIComponent(seg[2]) : null;
}

export function hasScope(scopes: string[], needed: string): boolean {
    return scopes.includes("*") || scopes.includes(needed);
}

/** Does this restricted key allow the session in the path? Accepts the WhatsApp sessionId or the DB id. */
async function sessionAllowed(allowed: string[], pathSessionId: string): Promise<boolean> {
    if (allowed.includes(pathSessionId)) return true;
    const session = await prisma.session.findUnique({ where: { id: pathSessionId }, select: { sessionId: true } }).catch(() => null);
    return !!session && allowed.includes(session.sessionId);
}

export type ApiKeyCheck = { ok: true } | { ok: false; status: 401 | 403; message: string };

/**
 * Authorize a request carrying a "wak_" key. Called by the custom server for every /api request
 * with such a key, before Next.js routing. Requests with other credentials are not affected.
 */
export async function checkApiKeyRequest(method: string, pathname: string, rawKey: string): Promise<ApiKeyCheck> {
    if (pathname.startsWith("/api/auth/")) return { ok: true };

    const key = await resolveApiKey(rawKey);
    if (!key) return { ok: false, status: 401, message: "Invalid, revoked or expired API key" };

    const needed = requiredScope(method, pathname);
    if (!hasScope(key.scopes, needed)) {
        return { ok: false, status: 403, message: `API key "${key.name}" lacks the "${needed}" scope required for ${method} ${pathname}` };
    }

    if (key.sessionIds && key.sessionIds.length) {
        const sid = sessionIdFromPath(pathname);
        if (!sid) {
            return { ok: false, status: 403, message: `API key "${key.name}" is restricted to specific sessions and cannot call ${pathname}` };
        }
        if (!(await sessionAllowed(key.sessionIds, sid))) {
            return { ok: false, status: 403, message: `API key "${key.name}" is not allowed to use session "${sid}"` };
        }
    }

    return { ok: true };
}
