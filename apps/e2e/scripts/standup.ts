/**
 * Brings up everything a suite needs and gates on the stack actually being
 * ready, rather than on a fixed sleep.
 *
 * Every step is written to be re-entrant: each one first checks whether what
 * it would create already exists (a Postgres already listening, a mock-mode
 * server already healthy, an already-built web export) and reuses it. That
 * matters because these suites are run repeatedly on a dev machine that may
 * already have `pnpm dev` or a sibling checkout's containers up, and starting
 * a second Postgres on 5432 just fails on a port collision.
 *
 * The readiness gate is `GET /health` reporting BOTH `database: "ok"` and
 * `inference: "mock"`. That single check proves more than it looks: /health
 * runs a real query (so the DB is up AND migrated), and the inference field
 * proves the server booted with MOCK_INFERENCE set — which is read once at
 * module load, so a server started without it can never be talked into mock
 * mode later.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(E2E_DIR, '../..');
const RUN_DIR = path.join(E2E_DIR, 'artifacts', '.run');
const PID_FILE = path.join(RUN_DIR, 'server.pid');

export const PORT = Number(process.env.E2E_PORT ?? 4000);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${String(PORT)}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/shannon';

/** Kept so onComplete can stop exactly the server onPrepare started. */
let spawnedServer: ChildProcess | null = null;

interface Health {
  status: string;
  services: { database: string; inference: string };
}

function log(msg: string): void {
  process.stdout.write(`[e2e:standup] ${msg}\n`);
}

function tcpOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => { done(true); });
    socket.once('timeout', () => { done(false); });
    socket.once('error', () => { done(false); });
  });
}

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

async function waitUntil(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`[e2e:standup] timed out after ${String(timeoutMs)}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${String(code)}`));
    });
  });
}

/** Parses host/port out of DATABASE_URL so the reuse probe matches the URL the server will use. */
function dbHostPort(): { host: string; port: number } {
  try {
    const u = new URL(DATABASE_URL);
    return { host: u.hostname, port: Number(u.port || 5432) };
  } catch {
    return { host: 'localhost', port: 5432 };
  }
}

async function ensurePostgres(): Promise<void> {
  const { host, port } = dbHostPort();
  if (await tcpOpen(host, port)) {
    log(`postgres already listening on ${host}:${String(port)} — reusing it`);
    return;
  }
  log('starting postgres (docker compose up -d db)');
  await run('docker', ['compose', 'up', '-d', 'db'], REPO_ROOT);
  await waitUntil('postgres to accept connections', () => tcpOpen(host, port), 60_000);
  log('postgres is up');
}

async function ensureMigrations(): Promise<void> {
  // Run explicitly rather than leaning on the server's boot-time migration:
  // that one resolves its migrations folder relative to cwd and swallows
  // failures with a log line, so a mis-migrated DB would surface much later
  // as a confusing request-time error instead of failing stand-up here.
  log('applying migrations');
  await run('pnpm', ['--filter', '@shannon/db', 'db:migrate'], REPO_ROOT, { DATABASE_URL });
}

async function ensureWebExport(): Promise<void> {
  const indexHtml = path.join(REPO_ROOT, 'apps/mobile/dist/index.html');
  if (existsSync(indexHtml) && process.env.E2E_FRESH_WEB !== '1') {
    log('web export present — reusing it (set E2E_FRESH_WEB=1 to rebuild)');
    return;
  }
  // Must happen before the server starts: static serving is only registered
  // at boot, and only if dist/index.html already exists.
  log('building web export (this takes a minute)');
  await run('pnpm', ['--filter', '@shannon/mobile', 'export:web'], REPO_ROOT);
}

async function ensureServer(): Promise<void> {
  const existing = await fetchHealth();
  if (existing) {
    if (existing.services.inference === 'mock') {
      log(`reusing server already healthy at ${BASE_URL}`);
      return;
    }
    throw new Error(
      `[e2e:standup] something is already listening at ${BASE_URL} but reports ` +
        `inference="${existing.services.inference}" (expected "mock"). Stop it, or point ` +
        `this run elsewhere with E2E_PORT / E2E_BASE_URL.`,
    );
  }

  log(`starting server on port ${String(PORT)} with MOCK_INFERENCE=true`);
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/server'),
    stdio: 'ignore',
    detached: false,
    env: {
      ...process.env,
      MOCK_INFERENCE: 'true',
      PORT: String(PORT),
      DATABASE_URL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? 'e2e-only-secret-not-for-production-0123456789',
    },
  });
  spawnedServer = child;
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(child.pid ?? ''), 'utf8');

  await waitUntil(
    `${BASE_URL}/health to report database=ok inference=mock`,
    async () => {
      const h = await fetchHealth();
      return h?.services.database === 'ok' && h.services.inference === 'mock';
    },
    120_000,
  );
  log('server is healthy');
}

export async function standup(): Promise<{ baseUrl: string }> {
  if (process.env.E2E_NO_STANDUP === '1') {
    log(`E2E_NO_STANDUP=1 — assuming a stack is already serving ${BASE_URL}`);
    return { baseUrl: BASE_URL };
  }
  await ensurePostgres();
  await ensureMigrations();
  await ensureWebExport();
  await ensureServer();
  return { baseUrl: BASE_URL };
}

export async function teardown(): Promise<void> {
  const stop = (pid: number): void => {
    try {
      process.kill(pid);
      log(`stopped server (pid ${String(pid)})`);
    } catch {
      // Already gone — nothing to clean up.
    }
  };

  if (spawnedServer?.pid !== undefined) {
    stop(spawnedServer.pid);
    spawnedServer = null;
  } else if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) stop(pid);
  }
  rmSync(PID_FILE, { force: true });
  // Postgres is deliberately left running: it is slow to start, holds no
  // per-run state worth clearing, and is very often not ours to stop.
  await Promise.resolve();
}

// Also usable standalone: `pnpm --filter @shannon/e2e standup`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  standup().then(
    (r) => { log(`ready at ${r.baseUrl}`); },
    (err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    },
  );
}
