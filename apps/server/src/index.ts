import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { runMigrations } from "./db/migrate";
import { authRoutes } from "./routes/auth";
import { conversationRoutes } from "./routes/conversations";
import { statsRoutes } from "./routes/stats";
import { syncRoutes } from "./routes/sync";
import { sandboxRoutes } from "./routes/sandbox";
import { chatWsHandler } from "./ws/chat";
import { sandboxTerminalWs } from "./ws/sandbox";
import { agentWsHandler } from "./ws/agent";
import { startRoutineScheduler } from "./routines/scheduler";
import { routineRoutes } from "./routes/routines";
import { modelRoutes } from "./routes/models";

const app = Fastify({ logger: true });

// ── Run DB migrations before registering routes ──────────
try {
  await runMigrations();
  app.log.info("Migrations applied");
} catch (err) {
  app.log.warn(`Migration skipped: ${(err as Error).message}`);
}

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
  return {
    status: dbStatus === "ok" ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      inference: process.env.MOCK_INFERENCE === "true" ? "unavailable" : "unavailable",
    },
  };
});

// ── Models ────────────────────────────────────────────────
app.get("/v1/models", async () => [
  { id: "default", name: "Default (llama.cpp)", context_window: 8192 },
]);

// ── Routes ────────────────────────────────────────────────
await authRoutes(app);
await conversationRoutes(app);
await statsRoutes(app);
await syncRoutes(app);
await sandboxRoutes(app);
await routineRoutes(app);
await modelRoutes(app);

// ── WebSocket ─────────────────────────────────────────────
chatWsHandler(app);
sandboxTerminalWs(app);
agentWsHandler(app);

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
});