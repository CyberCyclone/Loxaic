import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadOrCreateSecrets } from "./secrets.js";
import { advertiseUrlFor, bindHostFor } from "./config.js";
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
  // A host serves users on other machines, so both of these stop being
  // deployment trivia: TRUSTED_ORIGINS decides whose browser better-auth will
  // talk to, and ADMIN_EMAILS decides who administers the host rather than
  // whoever happened to sign up first.
  "TRUSTED_ORIGINS",
  "ADMIN_EMAILS",
];

/**
 * Full connection URL for an external database. The config file holds the URL
 * without a password (safe to read and show); the password lives in
 * secrets.json beside the auth secret, and is injected here.
 */
function externalDatabaseUrl(db, secrets) {
  const url = new URL(db.url);
  if (secrets.externalDbPassword) url.password = secrets.externalDbPassword;
  return url.toString();
}

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
 * dataDir — or an external database, in which case none is started) and the
 * bundled server. The whole child env is built here — the packaged app never
 * reads a repo .env.
 *
 * `instance` is the resolved config.json for this install (mode, instanceId,
 * host name, database choice). It is what turns a Solo stack into a Host one:
 * the bind address, the advertised URL that `BETTER_AUTH_URL` is derived
 * from, and the `SHANNON_HOSTING` gate all come from it. Omitted, the stack
 * behaves exactly as a loopback single-user install.
 *
 * Returns { apiBaseUrl, port, stop } — stop() tears down server-then-Postgres
 * in order, so the server can drain against a live database.
 */
/** The desktop app's own version, from its package.json — the packaged app
 * runs under Electron, not pnpm, so npm_package_version is never set. */
function desktopVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function startStack({
  dataDir,
  port = 4100,
  host,
  log = console.log,
  instance = null,
}) {
  const { serverDir, migrationsDir, webDistDir } = resolveRuntimePaths();
  const entry = path.join(serverDir, "dist/index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `no server payload at ${serverDir} — run \`pnpm --filter @shannon/desktop build:server\` first`,
    );
  }

  mkdirSync(dataDir, { recursive: true });
  const secrets = loadOrCreateSecrets(dataDir);

  const hostConfig = instance?.host ?? null;
  const hosting = instance?.mode === "host";
  const bindHost = host ?? (hostConfig ? bindHostFor(hostConfig) : "0.0.0.0");
  // What other machines dial. Solo resolves to loopback, so the same code
  // path serves both modes without a second branch.
  const advertiseUrl = hostConfig
    ? advertiseUrlFor({ ...hostConfig, port })
    : `http://localhost:${String(port)}`;

  // A previous app crash leaves both children running (they don't die with
  // the parent). The postgres side adopts via postmaster.pid; the server side
  // adopts here: if the target port already serves a healthy Shannon /health,
  // reuse it instead of failing with EADDRINUSE. An *unhealthy* leftover (its
  // postgres died too) is reaped via the pid we recorded when spawning it —
  // never a pid we didn't write ourselves.
  const serverPidFile = path.join(dataDir, "server.pid");
  const orphanBaseUrl = `http://localhost:${port}`;
  // Adoption is only safe when the leftover is configured the way this start
  // would configure it. Before instance modes existed that was always true;
  // now the process env *is* the mode — SHANNON_HOSTING, the bind, the
  // advertised URL BETTER_AUTH_URL derives from — and a healthy leftover Solo
  // server adopted during a Solo→Host switch would leave the user told they
  // are hosting while nothing about the running process changed, with a no-op
  // stop() so the next switch couldn't clean it up either. With an instance
  // config in hand, a leftover is reaped and replaced rather than trusted.
  if (!instance && (await isHealthyShannon(orphanBaseUrl))) {
    log(`[stack] adopting running server at ${orphanBaseUrl} (left over from a previous run)`);
    return {
      apiBaseUrl: orphanBaseUrl,
      port,
      stop: async () => {},
    };
  }
  await reapRecordedServer(serverPidFile, log);

  // An external database means no embedded Postgres at all — not one started
  // and ignored. `pg` stays null and every later reference is guarded, so a
  // stop() never tries to shut down a server that was never ours.
  const externalDb = hostConfig?.db?.kind === "external" ? hostConfig.db : null;
  let pg = null;
  if (externalDb) {
    log(`[stack] using external database (no embedded Postgres)`);
  } else {
    const pgPort = await freePort();
    pg = await startPostgres({ dataDir, port: pgPort, password: secrets.pgPassword, log });
  }
  const databaseUrl = externalDb ? externalDatabaseUrl(externalDb, secrets) : pg.url;

  const env = {
    // Deliberately not `...process.env`: the stack's config is fully explicit.
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "production",
    // The bundled server records this in the hosts table. npm_package_version
    // only exists under `pnpm dev`; the packaged app has to say so itself.
    SHANNON_VERSION: desktopVersion(),
    PORT: String(port),
    HOST: bindHost,
    DATABASE_URL: databaseUrl,
    STREAM_BACKEND: "memory",
    WEB_DIST_DIR: webDistDir,
    MIGRATIONS_DIR: migrationsDir,
    MIGRATIONS_STRICT: "1",
    // Lets the container sandbox provider auto-build its image on first use
    // even though a packaged install has no repo checkout to build from —
    // build-server.mjs ships a copy of infra/docker/sandbox.Dockerfile here.
    SANDBOX_BUILD_CONTEXT: path.join(serverDir, "sandbox"),
    BETTER_AUTH_SECRET: secrets.betterAuthSecret,
    // Derived from the advertised URL, not pinned to loopback: better-auth
    // builds its callback URLs and cookie domain from this, so a host serving
    // LAN clients while claiming to be localhost rejects every one of them.
    BETTER_AUTH_URL: advertiseUrl,
    SHANNON_DATA_DIR: dataDir,
    // Without this, storage.ts falls back to <cwd>/uploads — and cwd here is
    // serverDir, i.e. inside the installed app bundle. Attachments would be
    // written next to the shipped code, wiped by every update while their DB
    // rows survive (degrading to "[image unavailable]"), and on macOS would
    // break the bundle's code signature. Same treatment as the Postgres data
    // dir: user data belongs under dataDir.
    UPLOADS_DIR: path.join(dataDir, "uploads"),
  };
  if (instance) {
    // This machine's identity in the `hosts` table. Stable across mode
    // changes, so a Solo→Host switch updates one row rather than registering
    // the same machine twice.
    env.SHANNON_INSTANCE_ID = instance.instanceId;
    env.SHANNON_ADVERTISE_URL = advertiseUrl;
    if (hostConfig?.name) env.SHANNON_HOST_NAME = hostConfig.name;
  }
  if (hosting) {
    // Hosting for other users requires container isolation. The server
    // refuses to boot without it — see apps/server/src/index.ts. Enforcing it
    // there rather than here means a hand-started server can't skip the gate.
    env.SHANNON_HOSTING = "1";
  }
  for (const key of PASSTHROUGH_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  let server;
  try {
    server = await startServer({ entry, cwd: serverDir, env, log });
  } catch (err) {
    await pg?.stop().catch(() => undefined);
    throw err;
  }
  if (server.child.pid) writeFileSync(serverPidFile, String(server.child.pid));

  const apiBaseUrl = `http://localhost:${server.port}`;
  try {
    await waitForHealth(apiBaseUrl);
  } catch (err) {
    await server.stop();
    await pg?.stop().catch(() => undefined);
    throw err;
  }
  log(
    `[stack] up at ${apiBaseUrl} (${pg ? `postgres :${String(pg.port)}` : "external database"}, ` +
      `data ${dataDir}${hosting ? `, hosting as "${String(hostConfig?.name)}"` : ""})`,
  );

  let stopped = false;
  return {
    apiBaseUrl,
    port: server.port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      await pg?.stop().catch(() => undefined);
      rmSync(serverPidFile, { force: true });
      log("[stack] stopped");
    },
  };
}
