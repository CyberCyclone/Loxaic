import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { MAX_UPLOAD_BYTES } from "@loxaic/types";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactUrl } from "./logging";
import { runMigrations } from "./db/migrate";
import { initStreamBroker } from "./streams/index";
import { recoverOrphanedStreams } from "./streams/recovery";
import { authRoutes } from "./routes/auth";
import { conversationRoutes } from "./routes/conversations";
import { adminConversationRoutes, shareRoutes } from "./routes/shares";
import { statsRoutes } from "./routes/stats";
import { syncRoutes } from "./routes/sync";
import { sandboxRoutes } from "./routes/sandbox";
import { chatWsHandler } from "./ws/chat";
import { sandboxTerminalWs } from "./ws/sandbox";
import { agentWsHandler } from "./ws/agent";
import { executorWsHandler } from "./ws/executor.ts";
import { executorRoutes } from "./routes/executors.ts";
import { startRoutineScheduler, stopRoutineScheduler } from "./routines/scheduler";
import { startSandboxReaper, sweepOrphanSandboxes } from "./agent/sandbox-manager";
import { closeDb } from "@loxaic/db";
import { routineRoutes } from "./routes/routines";
import { modelRoutes } from "./routes/models";
import { configRoutes } from "./routes/config";
import { mcpRoutes } from "./routes/mcp";
import { githubRoutes } from "./routes/github.ts";
import { gitRoutes } from "./routes/git.ts";
import { prefsRoutes } from "./routes/prefs";
import { adminSettingsRoutes } from "./routes/admin-settings";
import { fileRoutes } from "./routes/files";
import { hostingBlockedReason, loadServerSettings } from "./settings";
import { ensureCluster, registerHost } from "./cluster";
import { startMcpReaper } from "./mcp/client-manager";
import { backfillGithubMcpServers } from "./mcp/github-server.ts";
import { startAttachmentReaper, sweepOrphanAttachments } from "./files/reaper";
import { startExtractionReaper, stopAllExtractionSandboxes } from "./files/extract";

const app = Fastify({
  logger: {
    serializers: {
      // Fastify's default serializer logs `req.url` verbatim, which would put
      // the `?token=` on /ws/chat and /v1/files/:ref into stdout in the clear.
      // Same fields as the default, minus the credential — see logging.ts.
      req(request) {
        return {
          method: request.method,
          url: redactUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        };
      },
    },
  },
});

// ── Run DB migrations before registering routes ──────────
// MIGRATIONS_STRICT=1 (set by the desktop supervisor) turns a failed
// migration into a fatal boot error instead of a warning — a supervised
// server that silently skips migrations would fail at request time instead.
try {
  await runMigrations();
  app.log.info("Migrations applied");
} catch (err) {
  if (process.env.MIGRATIONS_STRICT === "1") throw err;
  app.log.warn(`Migration skipped: ${(err as Error).message}`);
}

// ── Server-level settings ─────────────────────────────────
// After migrations (the table must exist) and before any route or sandbox
// operation can read them. Env vars still win over anything stored here.
await loadServerSettings();

// ── Hosting gate ──────────────────────────────────────────
// A Host serves other users' chats and agent runs, which is only defensible
// with container isolation. Fail the boot rather than start unisolated —
// enforced here, not in the desktop supervisor, so a hand-started server
// cannot skip it. Solo/dev installs (no LOXAIC_HOSTING) are unaffected.
const hostingBlocked = hostingBlockedReason();
if (hostingBlocked) throw new Error(hostingBlocked);

// ── Cluster identity ──────────────────────────────────────
// The cluster is the set of instances sharing this database; its id is minted
// here on first boot. Registration is a no-op without LOXAIC_INSTANCE_ID
// (a dev server or a Compose deployment has no durable per-machine identity).
await ensureCluster();
const registeredHostId = await registerHost();
if (registeredHostId) app.log.info(`Registered host ${registeredHostId}`);

// ── Stream log ────────────────────────────────────────────
// Deliberately NOT wrapped in try/catch: STREAM_BACKEND=redis with an
// unreachable Redis must fail the boot loudly, not silently fall back to
// the memory driver (which would silently drop the durability guarantee
// stream resume depends on).
await initStreamBroker();
app.log.info(`Stream backend: ${process.env.STREAM_BACKEND ?? "memory"}`);
await recoverOrphanedStreams();

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);
await app.register(multipart, {
  limits: {
    // The largest any class may be; the per-class cap (images 10 MB,
    // documents 25 MB) is enforced in the route once the real size is known.
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    // Busboy's own defaults are `fields: Infinity` at 1 MB each and
    // `parts: 1000`, all buffered into `body` before `request.file()` returns
    // — so an authenticated POST carrying no file at all could pin ~1 GB of
    // heap. The upload route reads no form fields, so these can be tight;
    // `parts` counts fields plus files, hence 2 for one file and one slot of
    // slack.
    fields: 1,
    fieldSize: 1024,
    parts: 2,
  },
});

// ── Health ────────────────────────────────────────────────
app.get("/health", async () => {
  let dbStatus: "ok" | "error" = "ok";
  try {
    const { db } = await import("@loxaic/db");
    await db.query.conversations.findFirst();
  } catch {
    dbStatus = "error";
  }

  let inferenceStatus: "mock" | "ok" | "unavailable" = "unavailable";
  if (process.env.MOCK_INFERENCE === "true") {
    inferenceStatus = "mock";
  } else {
    const base = process.env.INFERENCE_BASE_URL ?? "http://localhost:4002";
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 1500);
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
authRoutes(app);
conversationRoutes(app);
statsRoutes(app);
syncRoutes(app);
sandboxRoutes(app);
routineRoutes(app);
modelRoutes(app);
configRoutes(app);
shareRoutes(app);
adminConversationRoutes(app);
mcpRoutes(app);
githubRoutes(app);
gitRoutes(app);
executorRoutes(app);
prefsRoutes(app);
adminSettingsRoutes(app);
fileRoutes(app);

// ── WebSocket ─────────────────────────────────────────────
chatWsHandler(app);
sandboxTerminalWs(app);
agentWsHandler(app);
executorWsHandler(app);

// ── Web app (Expo static export, same origin as the API) ──
// Build with: pnpm --filter @loxaic/mobile export:web
// Override the location with WEB_DIST_DIR; skipped when the dir is absent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist =
  process.env.WEB_DIST_DIR ??
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
    const url = (request.raw.url ?? "").split("?")[0];
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
// PORT=0 is valid (bind an ephemeral port; the supervisor reads the real one
// from the LOXAIC_LISTENING handshake), so no `|| 4000` here — that maps 0
// to the default.
const PORT =
  process.env.PORT === undefined || process.env.PORT === ""
    ? 4000
    : Number(process.env.PORT);
if (Number.isNaN(PORT)) throw new Error(`Invalid PORT: ${process.env.PORT ?? ""}`);
const HOST = process.env.HOST ?? "0.0.0.0";

let reaperTimer: NodeJS.Timeout | null = null;
let mcpReaperTimer: NodeJS.Timeout | null = null;
let attachmentReaperTimer: NodeJS.Timeout | null = null;
let extractionReaperTimer: NodeJS.Timeout | null = null;

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  const addr = app.server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  app.log.info(`Server listening at http://${HOST}:${String(actualPort)}`);
  // Machine-readable readiness handshake for the desktop supervisor (same
  // pattern as tsnet-proxy's `LISTENING <addr>` line). Must be plain stdout,
  // not pino, so a readline consumer can match it without parsing JSON.
  console.log(`LOXAIC_LISTENING ${String(actualPort)}`);
  startRoutineScheduler().catch((e: unknown) => {
    app.log.warn(`Scheduler start skipped: ${e instanceof Error ? e.message : String(e)}`);
  });
  reaperTimer = startSandboxReaper((n) => { app.log.info(`Paused ${String(n)} idle agent sandbox(es) — their contents are kept`); });
  // A crashed process's leftover sandbox containers outlive their DB rows;
  // the label sweep is what finds them.
  sweepOrphanSandboxes()
    .then((n) => { if (n > 0) app.log.info(`Swept ${String(n)} orphaned sandbox container(s)`); })
    .catch(() => { /* best-effort sweep */ });
  mcpReaperTimer = startMcpReaper((n) => { app.log.info(`Closed ${String(n)} idle MCP connection(s)`); });
  // Users who connected GitHub before its MCP server was provisioned with the
  // connection have a token and no server; give them one.
  backfillGithubMcpServers((m) => { app.log.warn(m); })
    .then((n) => { if (n > 0) app.log.info(`Set up GitHub tools for ${String(n)} existing GitHub connection(s)`); })
    .catch((e: unknown) => { app.log.warn(`GitHub tools backfill skipped: ${e instanceof Error ? e.message : String(e)}`); });
  // Uploads that no message references — a picked-then-abandoned image has no
  // other reclaim path.
  sweepOrphanAttachments()
    .then((n) => { if (n > 0) app.log.info(`Swept ${String(n)} orphaned attachment(s)`); })
    .catch(() => { /* best-effort sweep */ });
  attachmentReaperTimer = startAttachmentReaper((n) => { app.log.info(`Swept ${String(n)} orphaned attachment(s)`); });
  extractionReaperTimer = startExtractionReaper((n) => { app.log.info(`Stopped ${String(n)} idle extraction sandbox(es)`); });
});

// ── Graceful shutdown ─────────────────────────────────────
// The desktop supervisor stops the server with SIGTERM before stopping
// Postgres; draining here keeps that teardown (and Ctrl-C in dev) clean.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received — shutting down`);
  try {
    stopRoutineScheduler();
    if (reaperTimer) clearInterval(reaperTimer);
    if (mcpReaperTimer) clearInterval(mcpReaperTimer);
    if (attachmentReaperTimer) clearInterval(attachmentReaperTimer);
    if (extractionReaperTimer) clearInterval(extractionReaperTimer);
    await stopAllExtractionSandboxes().catch(() => undefined);
    await app.close();
    await closeDb();
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
  process.exit(0);
}
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
