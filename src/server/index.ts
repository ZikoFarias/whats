import { loadEnvConfig } from "@next/env";
// Load environment variables before any other imports/logic
loadEnvConfig(process.cwd());

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { Server } from "socket.io";
import { setupSocket } from "./socket";
import { waManager } from "../modules/whatsapp/manager";
import { logger } from "../lib/logger";
import { API_KEY_PREFIX, checkApiKeyRequest } from "../lib/api-keys";
import pkg from "../../package.json";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3030", 10);

if (!process.env.AUTH_SECRET) {
  logger.error("Server", "AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  process.exit(1);
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const parsedUrl = parse(req.url, true);

      // MCP endpoint for AI attendants (authenticates and checks scopes per tool itself)
      if (parsedUrl.pathname === "/api/mcp") {
        const { handleMcpRequest } = await import("../modules/mcp/server");
        await handleMcpRequest(req, res);
        return;
      }

      // Per-integration API keys: enforce scopes and session limits before any route runs
      const apiKey = req.headers["x-api-key"];
      if (typeof apiKey === "string" && apiKey.startsWith(API_KEY_PREFIX) && parsedUrl.pathname?.startsWith("/api/")) {
        const check = await checkApiKeyRequest(req.method || "GET", parsedUrl.pathname, apiKey);
        if (!check.ok) {
          res.statusCode = check.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: false, message: check.message, error: check.message }));
          return;
        }
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error("Server", "Error handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  const io = new Server(server, {
    path: "/api/socket/io",
    addTrailingSlash: false,
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  setupSocket(io);
  // Optional: Global instance for Baileys to emit events
  (global as any).io = io;

  // Initialize WhatsApp Manager
  waManager.setup(io);
  waManager.loadSessions();

  // Start Scheduler
  import("../modules/whatsapp/scheduler").then(m => m.startScheduler());

  // Start persistent broadcast queue worker
  import("../modules/whatsapp/broadcast-queue").then(m => m.startBroadcastWorker());

  // Start scheduled group automations (open/close group, recurring posts)
  import("../modules/groups/automations").then(m => m.startAutomationScheduler());

  // Start webhook outbox worker (retries failed deliveries)
  import("../lib/webhook-delivery").then(m => m.startWebhookWorker());

  // Cloudflare 520 Fix: increase keep-alive timeout so Node doesn't kill idle connections that Cloudflare expects to reuse
  // See: https://github.com/vercel/next.js/issues/48962
  server.keepAliveTimeout = 120 * 1000; // 120 seconds
  server.headersTimeout = 120 * 1000; // 120 seconds

  server.listen(port, () => {
    logger.banner(pkg.name.toUpperCase(), pkg.version, port);
  });
});
