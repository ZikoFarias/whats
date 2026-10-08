import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { canAccessSession } from "@/lib/api-auth";
import { hasScope, type ResolvedApiKey } from "@/lib/api-keys";
import { GroupError } from "@/modules/groups/service";

export type Ctx = { key: ResolvedApiKey };
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export class ToolError extends Error {}

export const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
export const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Wrap a tool body: scope check + uniform error reporting */
export function tool<A>(ctx: Ctx, scope: string, fn: (args: A) => Promise<unknown>) {
    return async (args: A): Promise<ToolResult> => {
        if (!hasScope(ctx.key.scopes, scope)) {
            return fail(`This API key ("${ctx.key.name}") lacks the "${scope}" scope required for this tool.`);
        }
        try {
            return ok(await fn(args));
        } catch (e) {
            if (!(e instanceof ToolError) && !(e instanceof GroupError)) logger.error("MCP", "Tool failed:", e);
            return fail(e instanceof Error ? e.message : "Unexpected error");
        }
    };
}

/** Sessions this key may use (owner access ∩ key allow-list) */
export async function allowedSessions(ctx: Ctx) {
    const { user, sessionIds } = ctx.key;
    const where = sessionIds?.length ? { sessionId: { in: sessionIds } } : {};
    const sessions = await prisma.session.findMany({ where, orderBy: { createdAt: "asc" }, select: { id: true, sessionId: true, name: true } });
    const result = [];
    for (const s of sessions) {
        if (await canAccessSession(user.id, user.role, s.sessionId)) result.push(s);
    }
    return result;
}

/** Resolve the session for a tool call; defaults to the only allowed one */
export async function pickSession(ctx: Ctx, sessionId?: string) {
    const sessions = await allowedSessions(ctx);
    if (!sessionId) {
        if (sessions.length === 1) return sessions[0];
        throw new ToolError(`sessionId is required. Available: ${sessions.map(s => `${s.sessionId} (${s.name})`).join(", ") || "none"}`);
    }
    const session = sessions.find(s => s.sessionId === sessionId || s.id === sessionId);
    if (!session) throw new ToolError(`Session "${sessionId}" not found or not allowed for this API key`);
    return session;
}

