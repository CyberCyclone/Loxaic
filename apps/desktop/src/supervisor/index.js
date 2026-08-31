import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadOrCreateSecrets } from "./secrets.js";
import { freePort } from "./ports.js";
import { startPostgres } from "./postgres.js";
import { startServer } from "./server.js";
import { resolveRuntimePaths } from "./paths.js";

const HEALTH_TIMEOUT_MS = 30_000;

/** Env vars a user may set on the app that pass straight through to the server. */
const PASSTHROUGH_ENV = [
  "MOCK_INFERENCE",
  "INFERENCE_BASE_URL",
  "CONTAINER_SOCKET",
  "SANDBOX_MODE",
  "SANDBOX_HOST_ROOT",
  "SANDBOX_IMAGE",
  "SANDBOX_ALLOW_NETWORK",
  "NTFY_URL",
];

async function isHealthyShannon(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return body.services?.database === "ok";
  } catch {
    return false;
  }
}

/** Kill the server child a previous run recorded, if it's still alive. */
async function reapRecordedServer(pidFile, log) {
  let pid;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // Already gone.
  }
  log(`[stack] reaping orphaned server from a previous run (pid ${pid})`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // Exited.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.services?.database === "ok") return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server /health did not report database:"ok" within ${HEALTH_TIMEOUT_MS}ms`);
}

/**
 * Bring up the embedded stack: Postgres (ephemeral localhost port, data under
 * dataDir) and the bundled server (default port 4100). The whole child env is
 * built here — the packaged app never reads a repo .env.
 *
 * Returns { apiBaseUrl, port, stop } — stop() tears down server-then-Postgres
 * in order, so the server can drain against a live database.
 */
export async function startStack({ dataDir, port = 4100, host = "0.0.0.0", log = console.log }) {
  const { serverDir, migrationsDir, webDistDir } = resolveRuntimePaths();
  const entry = path.join(serverDir, "dist/index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `no server payload at ${serverDir} — run \`pnpm --filter @shannon/desktop build:server\` first`,
    );
  }

  mkdirSync(dataDir, { recursive: true });
  const secrets = loadOrCreateSecrets(dataDir);

  // A previous app crash leaves both children running (they don't die with
  // the parent). The postgres side adopts via postmaster.pid; the server side
  // adopts here: if the target port already serves a healthy Shannon /health,
  // reuse it instead of failing with EADDRINUSE. An *unhealthy* leftover (its
  // postgres died too) is reaped via the pid we recorded when spawning it —
  // never a pid we didn't write ourselves.
  const serverPidFile = path.join(dataDir, "server.pid");
  const orphanBaseUrl = `http://localhost:${port}`;
  if (await isHealthyShannon(orphanBaseUrl)) {
    log(`[stack] adopting running server at ${orphanBaseUrl} (left over from a previous run)`);
    return {
      apiBaseUrl: orphanBaseUrl,
      port,
      stop: async () => {},
    };
  }
  await reapRecordedServer(serverPidFile, log);

  const pgPort = await freePort();
  const pg = await startPostgres({ dataDir, port: pgPort, password: secrets.pgPassword, log });

  const env = {
    // Deliberately not `...process.env`: the stack's config is fully explicit.
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "production",
    PORT: String(port),
    HOST: host,
    DATABASE_URL: pg.url,
    STREAM_BACKEND: "memory",
    WEB_DIST_DIR: webDistDir,
    MIGRATIONS_DIR: migrationsDir,
    MIGRATIONS_STRICT: "1",
    // Lets the container sandbox provider auto-build its image on first use
    // even though a packaged install has no repo checkout to build from —
    // build-server.mjs ships a copy of infra/docker/sandbox.Dockerfile here.
    SANDBOX_BUILD_CONTEXT: path.join(serverDir, "sandbox"),
    BETTER_AUTH_SECRET: secrets.betterAuthSecret,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    SHANNON_DATA_DIR: dataDir,
    // Without this, storage.ts falls back to <cwd>/uploads — and cwd here is
    // serverDir, i.e. inside the installed app bundle. Attachments would be
    // written next to the shipped code, wiped by every update while their DB
    // rows survive (degrading to "[image unavailable]"), and on macOS would
    // break the bundle's code signature. Same treatment as the Postgres data
    // dir: user data belongs under dataDir.
    UPLOADS_DIR: path.join(dataDir, "uploads"),
  };
  for (const key of PASSTHROUGH_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  let server;
  try {
    server = await startServer({ entry, cwd: serverDir, env, log });
  } catch (err) {
    await pg.stop().catch(() => undefined);
    throw err;
  }
  if (server.child.pid) writeFileSync(serverPidFile, String(server.child.pid));

  const apiBaseUrl = `http://localhost:${server.port}`;
  try {
    await waitForHealth(apiBaseUrl);
  } catch (err) {
    await server.stop();
    await pg.stop().catch(() => undefined);
    throw err;
  }
  log(`[stack] up at ${apiBaseUrl} (postgres :${pg.port}, data ${dataDir})`);

  let stopped = false;
  return {
    apiBaseUrl,
    port: server.port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      await pg.stop().catch(() => undefined);
      rmSync(serverPidFile, { force: true });
      log("[stack] stopped");
    },
  };
}
