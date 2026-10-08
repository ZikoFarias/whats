import type { IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { resolveApiKey } from "@/lib/api-keys";
import { type Ctx, ToolError, tool, allowedSessions, pickSession } from "./helpers";
import { registerGroupTools, GROUP_INSTRUCTIONS } from "./group-tools";
import { resolveRecipientJid } from "@/lib/jid-utils";
import { waManager } from "@/modules/whatsapp/manager";
import { ChatService } from "@/modules/whatsapp/chat.service";
import {
    createBroadcastCampaign, pauseCampaign, resumeCampaign, cancelCampaign, phoneJidVariants,
} from "@/modules/whatsapp/broadcast-queue";
import pkg from "../../../package.json";

/**
 * MCP server: lets an AI (Claude Code, Claude Desktop, Cowork, any MCP client) work as a
 * WhatsApp attendant through this hub — read conversations, reply, start chats, send media
 * and run broadcasts.
 *
 * Transport: Streamable HTTP at POST /api/mcp, stateless (one server per request).
 * Auth: a per-integration API key (wak_...) in "Authorization: Bearer", "x-api-key", or,
 * only if MCP_ALLOW_KEY_IN_URL=true, "?key=". Each tool checks the key's scope and
 * allowed numbers, and the key owner's access to the session.
 */

const INSTRUCTIONS = `You are connected to a WhatsApp hub (WA-AKG) and act as an attendant for the business.

How to work:
- Start with list_numbers to see which WhatsApp numbers (sessions) you can use. If there is only one, sessionId can be omitted everywhere.
- To find who is waiting for an answer, call list_conversations with onlyAwaitingReply=true, then get_conversation to read the context before replying.
- Reply with send_message (text) or send_media. Use replyToMessageId to quote a specific message when helpful. Call mark_as_read after handling a conversation.
- Phone numbers can be given in any format; numbers without country code are treated as Brazilian (DDD + number).
- Write like a human attendant: short messages, in the customer's language, no markdown tables.

Safety rules (WhatsApp restricts numbers that message strangers):
- Messages to people who never wrote to the number ("new chats") are risky. send_message reports isNewChat; keep new chats few and only when the business asked for it.
- To message several people at once, use create_broadcast: it queues the campaign with delays, sending hours and daily limits. Never loop send_message over a list.
- If a send fails with error 463 the number is restricted from starting new chats: stop contacting new people and tell the user.
- Never invent prices, links or promises; if you don't know, say you'll check and tell the user.`;

function connectedSocket(sessionId: string) {
    const instance = waManager.getInstance(sessionId);
    if (!instance?.socket || instance.status !== "CONNECTED") {
        throw new ToolError(`WhatsApp number "${sessionId}" is not connected (status: ${instance?.status ?? "not loaded"})`);
    }
    return instance.socket;
}

/** JIDs a contact may be stored under (phone variants, or the JID itself) */
function contactJids(input: string): string[] {
    return /@/.test(input) ? [input] : phoneJidVariants(input);
}

async function hasInboundHistory(dbSessionId: string, jid: string): Promise<boolean> {
    const count = await prisma.message.count({
        where: { sessionId: dbSessionId, fromMe: false, remoteJid: { in: [jid, ...contactJids(jid.split("@")[0])] } },
    });
    return count > 0;
}

const phoneOf = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null);

const sessionIdArg = z.string().optional().describe("WhatsApp number (session) id from list_numbers. Optional when only one is available.");

function buildServer(ctx: Ctx) {
    const server = new McpServer({ name: "wa-akg", version: pkg.version }, { instructions: INSTRUCTIONS + GROUP_INSTRUCTIONS });

    server.registerTool("list_numbers", {
        title: "List WhatsApp numbers",
        description: "WhatsApp numbers (sessions) this key can use, with connection status and phone.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async () => {
        const sessions = await allowedSessions(ctx);
        return sessions.map(s => {
            const instance = waManager.getInstance(s.sessionId);
            const me = instance?.socket?.user?.id;
            return {
                sessionId: s.sessionId,
                name: s.name,
                status: instance?.status ?? "DISCONNECTED",
                phone: me ? me.split(":")[0].split("@")[0] : null,
            };
        });
    }));

    server.registerTool("list_conversations", {
        title: "List conversations",
        description: "Recent conversations of a number, newest first, with the last message. Use onlyAwaitingReply=true to get the ones where the customer spoke last.",
        inputSchema: {
            sessionId: sessionIdArg,
            onlyAwaitingReply: z.boolean().optional().describe("Only conversations whose last message came from the customer"),
            includeGroups: z.boolean().optional().describe("Include group chats (default false)"),
            search: z.string().optional().describe("Filter by name or number"),
            limit: z.number().int().min(1).max(100).optional().describe("Max conversations (default 20)"),
        },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (args: { sessionId?: string; onlyAwaitingReply?: boolean; includeGroups?: boolean; search?: string; limit?: number }) => {
        const session = await pickSession(ctx, args.sessionId);
        const limit = args.limit ?? 20;
        // Fetch extra rows so filters still return up to `limit`
        const chats = await ChatService.getChatsList(session.id, Math.min(limit * 5, 500), undefined, args.search);
        return chats
            // Skip status/channels and WhatsApp's own system account (0@s.whatsapp.net)
            .filter(c => !c.jid.endsWith("@broadcast") && !c.jid.endsWith("@newsletter") && !c.jid.startsWith("0@"))
            .filter(c => args.includeGroups || !c.jid.endsWith("@g.us"))
            .filter(c => !args.onlyAwaitingReply || !c.lastMessage.fromMe)
            .slice(0, limit)
            .map(c => ({
                jid: c.jid,
                phone: phoneOf(c.jid),
                name: c.name || c.notify || null,
                isGroup: c.jid.endsWith("@g.us"),
                awaitingReply: !c.lastMessage.fromMe,
                lastMessage: {
                    id: c.lastMessage.keyId,
                    fromMe: c.lastMessage.fromMe,
                    type: c.lastMessage.type,
                    text: c.lastMessage.content,
                    at: c.lastMessage.timestamp,
                },
            }));
    }));

    server.registerTool("get_conversation", {
        title: "Read a conversation",
        description: "Messages of one conversation in chronological order (oldest first). Pass the jid from list_conversations or a phone number.",
        inputSchema: {
            sessionId: sessionIdArg,
            contact: z.string().describe("Contact JID (e.g. 5561999998888@s.whatsapp.net, ...@lid, ...@g.us) or phone number"),
            limit: z.number().int().min(1).max(200).optional().describe("Max messages (default 30, most recent)"),
            before: z.string().optional().describe("ISO timestamp: only messages older than this (pagination)"),
        },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (args: { sessionId?: string; contact: string; limit?: number; before?: string }) => {
        const session = await pickSession(ctx, args.sessionId);
        let result: Awaited<ReturnType<typeof ChatService.getMessages>> = { messages: [], hasMore: false };
        let usedJid = args.contact;
        for (const jid of contactJids(args.contact)) {
            const r = await ChatService.getMessages(session.id, jid, args.limit ?? 30, args.before);
            if (r.messages.length) { result = r; usedJid = jid; break; }
        }
        return {
            jid: usedJid,
            hasMore: result.hasMore,
            messages: result.messages.map(m => ({
                id: m.keyId,
                fromMe: m.fromMe,
                sender: m.fromMe ? "me" : (m.pushName || m.senderJid || m.remoteJid),
                type: m.type,
                text: m.content,
                mediaUrl: m.mediaUrl,
                status: m.status,
                at: m.timestamp,
                quoted: m.quoted ? { id: m.quoted.keyId, text: m.quoted.content, fromMe: m.quoted.fromMe } : undefined,
            })),
        };
    }));

    server.registerTool("send_message", {
        title: "Send a text message",
        description: "Send a text to one contact: reply in an existing conversation or start a new one. Returns isNewChat=true when the contact never wrote to this number (risky; keep these few).",
        inputSchema: {
            sessionId: sessionIdArg,
            to: z.string().describe("Phone number (any format) or JID"),
            text: z.string().min(1).describe("Message text"),
            replyToMessageId: z.string().optional().describe("Message id to quote (from get_conversation)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, tool(ctx, "send", async (args: { sessionId?: string; to: string; text: string; replyToMessageId?: string }) => {
        const session = await pickSession(ctx, args.sessionId);
        const socket = connectedSocket(session.sessionId);
        const jid = await resolveRecipientJid(socket, args.to);
        const isNewChat = !jid.endsWith("@g.us") && !(await hasInboundHistory(session.id, jid));
        const result = await ChatService.sendTextMessage(session.sessionId, jid, { text: args.text }, undefined, args.replyToMessageId);
        return { sent: true, messageId: result?.key?.id ?? null, to: jid, isNewChat };
    }));

    server.registerTool("send_media", {
        title: "Send media",
        description: "Send an image, video, audio or document from a public URL to one contact, with optional caption.",
        inputSchema: {
            sessionId: sessionIdArg,
            to: z.string().describe("Phone number (any format) or JID"),
            type: z.enum(["image", "video", "audio", "document"]),
            url: z.string().url().describe("Public URL of the file"),
            caption: z.string().optional(),
            fileName: z.string().optional().describe("File name shown for documents"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, tool(ctx, "send", async (args: { sessionId?: string; to: string; type: "image" | "video" | "audio" | "document"; url: string; caption?: string; fileName?: string }) => {
        const session = await pickSession(ctx, args.sessionId);
        const socket = connectedSocket(session.sessionId);
        const jid = await resolveRecipientJid(socket, args.to);
        const payload: Record<string, unknown> = { [args.type]: { url: args.url } };
        if (args.caption && args.type !== "audio") payload.caption = args.caption;
        if (args.type === "document") {
            payload.fileName = args.fileName || args.url.split("?")[0].split("/").pop() || "file";
            payload.mimetype = "application/octet-stream";
        }
        if (args.type === "audio") payload.mimetype = "audio/mp4";
        const isNewChat = !jid.endsWith("@g.us") && !(await hasInboundHistory(session.id, jid));
        const result = await ChatService.sendTextMessage(session.sessionId, jid, payload);
        return { sent: true, messageId: result?.key?.id ?? null, to: jid, isNewChat };
    }));

    server.registerTool("mark_as_read", {
        title: "Mark conversation as read",
        description: "Mark a conversation as read (blue ticks for the customer).",
        inputSchema: { sessionId: sessionIdArg, contact: z.string().describe("JID or phone number") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, tool(ctx, "send", async (args: { sessionId?: string; contact: string }) => {
        const session = await pickSession(ctx, args.sessionId);
        const socket = connectedSocket(session.sessionId);
        const jid = /@/.test(args.contact) ? args.contact : await resolveRecipientJid(socket, args.contact);
        const unread = await prisma.message.findMany({
            where: { sessionId: session.id, remoteJid: jid, fromMe: false },
            orderBy: { timestamp: "desc" },
            take: 20,
            select: { keyId: true, senderJid: true },
        });
        if (unread.length) {
            await socket.readMessages(unread.map(m => ({
                remoteJid: jid, id: m.keyId, fromMe: false,
                participant: jid.endsWith("@g.us") ? (m.senderJid ?? undefined) : undefined,
            })));
        }
        return { markedRead: unread.length, jid };
    }));

    server.registerTool("check_whatsapp_numbers", {
        title: "Check numbers on WhatsApp",
        description: "Check whether phone numbers have WhatsApp and get their JIDs (handles the Brazilian 9th digit).",
        inputSchema: { sessionId: sessionIdArg, numbers: z.array(z.string()).min(1).max(50) },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (args: { sessionId?: string; numbers: string[] }) => {
        const session = await pickSession(ctx, args.sessionId);
        const socket = connectedSocket(session.sessionId);
        const out = [];
        for (const n of args.numbers) {
            try {
                out.push({ number: n, exists: true, jid: await resolveRecipientJid(socket, n) });
            } catch (e) {
                out.push({ number: n, exists: false, error: e instanceof Error ? e.message : String(e) });
            }
        }
        return out;
    }));

    server.registerTool("search_contacts", {
        title: "Search contacts",
        description: "Find saved contacts of a number by name or phone.",
        inputSchema: { sessionId: sessionIdArg, query: z.string().min(2), limit: z.number().int().min(1).max(50).optional() },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (args: { sessionId?: string; query: string; limit?: number }) => {
        const session = await pickSession(ctx, args.sessionId);
        const q = args.query.trim();
        const contacts = await prisma.contact.findMany({
            where: {
                sessionId: session.id,
                OR: [{ name: { contains: q } }, { notify: { contains: q } }, { jid: { contains: q.replace(/\D/g, "") || q } }],
            },
            take: args.limit ?? 20,
            select: { jid: true, name: true, notify: true },
        });
        return contacts.map(c => ({ jid: c.jid, phone: phoneOf(c.jid), name: c.name || c.notify }));
    }));

    server.registerTool("create_broadcast", {
        title: "Create a broadcast campaign",
        description: "Queue a message to many recipients. Sent in the background with randomized delays, sending hours and daily limits per number; returns a broadcastId to follow with get_broadcast. Use {{variable}} placeholders with per-recipient variables.",
        inputSchema: {
            sessionId: sessionIdArg,
            recipients: z.array(z.union([
                z.string(),
                z.object({ phone: z.string(), variables: z.record(z.string(), z.string()).optional() }),
            ])).min(1).max(5000),
            message: z.string().describe("Text; may contain {{nome}} style placeholders. Can be empty if media is set."),
            media: z.object({ type: z.enum(["image", "video", "document"]), url: z.string().url(), fileName: z.string().optional() }).optional(),
            delaySeconds: z.number().int().min(5).max(600).optional().describe("Base delay between messages (default 12s, randomized up to 2x)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, tool(ctx, "broadcast", async (args: { sessionId?: string; recipients: (string | { phone: string; variables?: Record<string, string> })[]; message: string; media?: { type: "image" | "video" | "document"; url: string; fileName?: string }; delaySeconds?: number }) => {
        const session = await pickSession(ctx, args.sessionId);
        if (!args.message.trim() && !args.media) throw new ToolError("message or media is required");
        return createBroadcastCampaign({
            sessionId: session.sessionId,
            recipients: args.recipients,
            message: args.message,
            media: args.media,
            delay: args.delaySeconds ? args.delaySeconds * 1000 : undefined,
        });
    }));

    server.registerTool("get_broadcast", {
        title: "Broadcast status",
        description: "Progress of a broadcast campaign: status, counters, why it is waiting or paused, and failed recipients.",
        inputSchema: { sessionId: sessionIdArg, broadcastId: z.string() },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (args: { sessionId?: string; broadcastId: string }) => {
        const session = await pickSession(ctx, args.sessionId);
        const log = await prisma.broadcastLog.findFirst({ where: { id: args.broadcastId, sessionId: session.sessionId } });
        if (!log) throw new ToolError("Broadcast not found for this number");
        const [pending, failed] = await Promise.all([
            prisma.broadcastRecipient.count({ where: { broadcastLogId: log.id, status: { in: ["pending", "sending"] } } }),
            prisma.broadcastRecipient.findMany({ where: { broadcastLogId: log.id, status: "failed" }, take: 50, select: { jid: true, error: true } }),
        ]);
        return {
            id: log.id, status: log.status, total: log.total, sent: log.sent, failed: log.failed, pending,
            waitingReason: log.waitingReason, pauseReason: log.pauseReason,
            startedAt: log.startedAt, completedAt: log.completedAt, failedRecipients: failed,
        };
    }));

    server.registerTool("list_broadcasts", {
        title: "List broadcasts",
        description: "Recent broadcast campaigns of a number.",
        inputSchema: { sessionId: sessionIdArg, limit: z.number().int().min(1).max(50).optional() },
        annotations: { readOnlyHint: true },
    }, tool(ctx, "read", async (args: { sessionId?: string; limit?: number }) => {
        const session = await pickSession(ctx, args.sessionId);
        const logs = await prisma.broadcastLog.findMany({
            where: { sessionId: session.sessionId }, orderBy: { startedAt: "desc" }, take: args.limit ?? 10,
            select: { id: true, status: true, message: true, total: true, sent: true, failed: true, waitingReason: true, pauseReason: true, startedAt: true },
        });
        return logs.map(l => ({ ...l, message: l.message.length > 120 ? l.message.slice(0, 117) + "..." : l.message }));
    }));

    server.registerTool("control_broadcast", {
        title: "Pause, resume or cancel a broadcast",
        description: "Pause, resume or cancel a broadcast campaign. Cancel is final: pending recipients are not sent.",
        inputSchema: { sessionId: sessionIdArg, broadcastId: z.string(), action: z.enum(["pause", "resume", "cancel"]) },
        annotations: { readOnlyHint: false, destructiveHint: true },
    }, tool(ctx, "broadcast", async (args: { sessionId?: string; broadcastId: string; action: "pause" | "resume" | "cancel" }) => {
        const session = await pickSession(ctx, args.sessionId);
        const log = await prisma.broadcastLog.findFirst({ where: { id: args.broadcastId, sessionId: session.sessionId }, select: { status: true } });
        if (!log) throw new ToolError("Broadcast not found for this number");
        const fn = { pause: pauseCampaign, resume: resumeCampaign, cancel: cancelCampaign }[args.action];
        const changed = await fn(args.broadcastId);
        if (!changed) throw new ToolError(`Cannot ${args.action} a broadcast that is ${log.status}`);
        return { broadcastId: args.broadcastId, action: args.action, done: true };
    }));

    registerGroupTools(server, ctx);

    return server;
}

// ---------------------------------------------------------------------------
// HTTP entry point (called by the custom server for /api/mcp)
// ---------------------------------------------------------------------------

function extractKey(req: IncomingMessage, url: URL): string | null {
    const auth = req.headers.authorization;
    if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
    const header = req.headers["x-api-key"];
    if (typeof header === "string" && header) return header;
    if (process.env.MCP_ALLOW_KEY_IN_URL === "true") return url.searchParams.get("key");
    return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 4 * 1024 * 1024) throw new Error("Request body too large");
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : undefined;
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method !== "POST") {
        // Stateless server: no SSE stream (GET) or session to delete (DELETE)
        sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null }, { Allow: "POST" });
        return;
    }

    const rawKey = extractKey(req, url);
    const key = rawKey ? await resolveApiKey(rawKey) : null;
    if (!key) {
        sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: send a valid wak_ API key in 'Authorization: Bearer <key>' or 'x-api-key'" }, id: null },
            { "WWW-Authenticate": 'Bearer realm="wa-akg"' });
        return;
    }

    let body: unknown;
    try {
        body = await readBody(req);
    } catch (e) {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: e instanceof Error ? e.message : "Parse error" }, id: null });
        return;
    }

    const server = buildServer({ key });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    } catch (e) {
        logger.error("MCP", "Request failed:", e);
        if (!res.headersSent) {
            sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
    }
}
