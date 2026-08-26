import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./db/migrate";
import { initStreamBroker } from "./streams/index";
import { recoverOrphanedStreams } from "./streams/recovery";
import { authRoutes } from "./routes/auth";
import { conversationRoutes } from "./routes/conversations";
import { statsRoutes } from "./routes/stats";
import { syncRoutes } from "./routes/sync";
import { sandboxRoutes } from "./routes/sandbox";
import { chatWsHandler } from "./ws/chat";
import { sandboxTerminalWs } from "./ws/sandbox";
import { agentWsHandler } from "./ws/agent";
import { startRoutineScheduler } from "./routines/scheduler";
import { startSandboxReaper } from "./agent/sandbox-manager";
import { routineRoutes } from "./routes/routines";
import { modelRoutes } from "./routes/models";
import { mcpRoutes } from "./routes/mcp";
import { startMcpReaper } from "./mcp/client-manager";

const app = Fastify({ logger: true });

// ── Run DB migrations before registering routes ──────────
try {
  await runMigrations();
  app.log.info("Migrations applied");
} catch (err) {
  app.log.warn(`Migration skipped: ${(err as Error).message}`);
}

// ── Stream log ────────────────────────────────────────────
// Deliberately NOT wrapped in try/catch: STREAM_BACKEND=redis with an
// unreachable Redis must fail the boot loudly, not silently fall back to
// the memory driver (which would silently drop the durability guarantee
// incognito conversations depend on).
await initStreamBroker();
app.log.info(`Stream backend: ${process.env.STREAM_BACKEND || "memory"}`);
await recoverOrphanedStreams();

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);

// ── Health ────────────────────────────────────────────────
app.get("/health", async () => {
  let dbStatus: "ok" | "error" = "ok";
  try {
    const { db } = await import("@shannon/db");
    await db.query.conversations.findFirst();
  } catch {
    dbStatus = "error";
  }

  let inferenceStatus: "mock" | "ok" | "unavailable" = "unavailable";
  if (process.env.MOCK_INFERENCE === "true") {
    inferenceStatus = "mock";
  } else {
    const base = process.env.INFERENCE_BASE_URL || "http://localhost:4002";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(`${base}/v1/models`, { signal: controller.signal });
      inferenceStatus = res.ok ? "ok" : "unavailable";
    } catch {
      inferenceStatus = "unavailable";
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status: dbStatus === "ok" ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      inference: inferenceStatus,
    },
  };
});

// ── Routes ────────────────────────────────────────────────
await authRoutes(app);
await conversationRoutes(app);
await statsRoutes(app);
await syncRoutes(app);
await sandboxRoutes(app);
await routineRoutes(app);
await modelRoutes(app);
await mcpRoutes(app);

// ── WebSocket ─────────────────────────────────────────────
chatWsHandler(app);
sandboxTerminalWs(app);
agentWsHandler(app);

// ── Web app (Expo static export, same origin as the API) ──
// Build with: pnpm --filter @shannon/mobile export:web
// Override the location with WEB_DIST_DIR; skipped when the dir is absent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist =
  process.env.WEB_DIST_DIR ||
  path.resolve(__dirname, "../../mobile/dist");
if (existsSync(path.join(webDist, "index.html"))) {
  await app.register(fastifyStatic, {
    root: webDist,
    // Keep the default wildcard route: `wildcard: false` glob-registers
    // per-file routes and misses assets under dot-dirs (assets/…/.pnpm/…).
    dotfiles: "allow",
    setHeaders: (reply, filePath) => {
      // Hashed bundles are immutable; index.html must always revalidate so
      // fresh exports take effect on reload.
      if (filePath.endsWith("index.html")) {
        reply.header("Cache-Control", "no-cache");
      } else if (filePath.includes("/_expo/")) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });
  // SPA fallback: non-API, non-asset GETs render the app shell (expo-router
  // handles the path client-side). Asset-like paths 404 properly instead of
  // returning HTML (which would mask stale-bundle errors).
  app.setNotFoundHandler((request, reply) => {
    const url = (request.raw.url || "").split("?")[0];
    const isApi =
      url.startsWith("/v1") ||
      url.startsWith("/api") ||
      url.startsWith("/ws") ||
      url.startsWith("/health");
    const lastSegment = url.slice(url.lastIndexOf("/") + 1);
    const looksLikeAsset = url.startsWith("/_expo/") || lastSegment.includes(".");
    if (request.method === "GET" && !isApi && !looksLikeAsset) {
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });
  app.log.info(`Serving web app from ${webDist}`);
} else {
  app.log.info(`No web build at ${webDist} — API-only mode`);
}

// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "0.0.0.0";

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening at http://${HOST}:${PORT}`);
  startRoutineScheduler().catch((e) => app.log.warn(`Scheduler start skipped: ${e.message}`));
  startSandboxReaper((n) => app.log.info(`Reaped ${n} idle agent sandbox(es)`));
  startMcpReaper((n) => app.log.info(`Closed ${n} idle MCP connection(s)`));
});