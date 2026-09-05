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
 * The readiness gate is `GET /health` reporting `database: "ok"` and
 * `inference: "mock"` (or `"ok"` under E2E_REAL_MODEL — see below). That
 * single check proves more than it looks: /health runs a real query (so the
 * DB is up AND migrated), and the inference field is a genuine connectivity
 * check against whichever endpoint the server booted with — mock or real —
 * which is fixed at module load, so a server can never be talked into the
 * other mode later.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
/**
 * Self-contained mode: the app under test (the packaged Electron build) brings
 * up its own embedded Postgres + server, so this harness stands up nothing and
 * tears down nothing — the app owns its stack's lifecycle.
 */
export const SELF_CONTAINED = process.env.E2E_SELF_CONTAINED === '1';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/loxaic';
/**
 * Sandbox specs need an admin session, and "first user ever" is unreliable
 * against a DB stand-up reuses across runs — so one account is granted admin
 * via ADMIN_EMAILS on the server this file spawns.
 *
 * Generated fresh per run rather than hardcoded. `DATABASE_URL` defaults to
 * the same database `pnpm dev` uses, `ensurePostgres()` deliberately reuses
 * an already-running one, and nothing deletes the row afterwards — so a
 * fixed address and a committed password would leave every developer's dev
 * database holding a guessable *admin* account, on a project whose whole
 * premise is being reachable remotely. Random credentials make a leftover
 * row inert instead.
 *
 * Written to a file rather than kept in memory because the processes that
 * need it are not the same one: wdio workers are forked separately, and the
 * documented `standup` + `E2E_NO_STANDUP=1` workflow runs stand-up in a
 * different process entirely. See helpers/auth.ts's adminCreds().
 */
export const ADMIN_FILE = path.join(RUN_DIR, 'admin.json');
const SANDBOX_HOST_ROOT = path.join(RUN_DIR, 'sandboxes');
/**
 * Where uploaded attachments land. Kept under the run directory rather than
 * apps/server's default ./uploads so a suite run never leaves image files in
 * the working tree, and so teardown can drop them wholesale.
 */
const UPLOADS_DIR = path.join(RUN_DIR, 'uploads');
/**
 * Real-model mode: drives the agent with an actual inference endpoint
 * instead of the mock, so it has to genuinely read instructions and write
 * working code — see the "Real-model task suite" section of the README.
 * Never inferred automatically; always opt-in, like SELF_CONTAINED.
 */
export const REAL_MODEL = process.env.E2E_REAL_MODEL === '1';
const INFERENCE_URL = process.env.E2E_INFERENCE_URL;
const SEED_DIR = path.resolve(E2E_DIR, 'fixtures/seeded-app');

function writeAdminCreds(): { email: string; password: string } {
  const suffix = randomBytes(9).toString('hex');
  const creds = {
    email: `e2e-admin-${suffix}@loxaic.test`,
    password: `Pw-${randomBytes(18).toString('base64url')}`,
  };
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(ADMIN_FILE, JSON.stringify(creds), 'utf8');
  return creds;
}

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
  await run('pnpm', ['--filter', '@loxaic/db', 'db:migrate'], REPO_ROOT, { DATABASE_URL });
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
  await run('pnpm', ['--filter', '@loxaic/mobile', 'export:web'], REPO_ROOT);
}

async function ensureServer(): Promise<void> {
  if (REAL_MODEL && !INFERENCE_URL) {
    throw new Error(
      '[e2e:standup] E2E_REAL_MODEL=1 needs E2E_INFERENCE_URL — an OpenAI-compatible endpoint ' +
        '(LM Studio, llama.cpp --jinja, OpenRouter, …). See the README\'s "Real-model task suite".',
    );
  }
  // /health's inference field genuinely round-trips GET <base>/v1/models — see
  // apps/server/src/index.ts — so this is a real connectivity check, not a flag echo.
  const expectedInference = REAL_MODEL ? 'ok' : 'mock';

  const existing = await fetchHealth();
  if (existing) {
    // Real-model mode needs more of the server than /health can show:
    // SANDBOX_ALLOW_NETWORK (for `npm install`) and E2E_SANDBOX_SEED_DIR (the
    // fixture the task is defined by), neither of which is observable from
    // outside. Reusing a server without them yields an agent staring at an
    // empty workspace with no network, and the failure reads as the model
    // being bad rather than the harness being misconfigured — so refuse.
    if (REAL_MODEL) {
      throw new Error(
        `[e2e:standup] a server is already listening at ${BASE_URL}, and real-model mode cannot ` +
          'reuse it: it needs SANDBOX_ALLOW_NETWORK and E2E_SANDBOX_SEED_DIR, which this harness ' +
          'only sets on a server it starts itself. Stop it, or use a different E2E_PORT.',
      );
    }
    if (existing.services.inference === expectedInference) {
      log(`reusing server already healthy at ${BASE_URL}`);
      return;
    }
    throw new Error(
      `[e2e:standup] something is already listening at ${BASE_URL} but reports ` +
        `inference="${existing.services.inference}" (expected "${expectedInference}"). Stop it, or point ` +
        `this run elsewhere with E2E_PORT / E2E_BASE_URL.`,
    );
  }

  log(`starting server on port ${String(PORT)} with ${REAL_MODEL ? `INFERENCE_BASE_URL=${String(INFERENCE_URL)}` : 'MOCK_INFERENCE=true'}`);
  mkdirSync(SANDBOX_HOST_ROOT, { recursive: true });
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const { email: adminEmail } = writeAdminCreds();
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/server'),
    stdio: 'ignore',
    detached: false,
    env: {
      ...process.env,
      // Explicit even/especially in the false branch: a MOCK_INFERENCE=true
      // left over in the calling shell must not silently defeat the real
      // connectivity check /health performs when REAL_MODEL is set.
      MOCK_INFERENCE: REAL_MODEL ? '' : 'true',
      ...(REAL_MODEL
        ? {
            INFERENCE_BASE_URL: INFERENCE_URL,
            // The real-model suite's whole point is an agent that installs
            // dependencies, which needs the network sandboxes lack by default.
            SANDBOX_ALLOW_NETWORK: '1',
            E2E_SANDBOX_SEED_DIR: SEED_DIR,
          }
        : {}),
      PORT: String(PORT),
      DATABASE_URL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? 'e2e-only-secret-not-for-production-0123456789',
      // Sandbox specs sign in as this email to get the admin role (see
      // provisionAdmin()) and switch mode live through the settings API —
      // host mode then needs somewhere disposable to write, hence the root.
      ADMIN_EMAILS: adminEmail,
      SANDBOX_HOST_ROOT,
      UPLOADS_DIR,
    },
  });
  spawnedServer = child;
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(child.pid ?? ''), 'utf8');

  await waitUntil(
    `${BASE_URL}/health to report database=ok inference=${expectedInference}`,
    async () => {
      const h = await fetchHealth();
      return h?.services.database === 'ok' && h.services.inference === expectedInference;
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
  if (SELF_CONTAINED) {
    log(`E2E_SELF_CONTAINED=1 — the packaged app brings its own stack at ${BASE_URL}`);
    return { baseUrl: BASE_URL };
  }
  await ensurePostgres();
  await ensureMigrations();
  await ensureWebExport();
  await ensureServer();
  return { baseUrl: BASE_URL };
}

export async function teardown(): Promise<void> {
  // Nothing was stood up, and a stale PID file from an earlier external-server
  // run must not get a kill signal it doesn't own.
  if (SELF_CONTAINED) return;
  const stop = (pid: number): void => {
    try {
      process.kill(pid);
      log(`stopped server (pid ${String(pid)})`);
    } catch {
      // Already gone — nothing to clean up.
    }
  };

  // Only a run that started a server owns that server's state. Everything
  // below is gated on that for the same reason the kill above is: the host
  // sandbox root is a fixed per-checkout path, so a run that merely *reused*
  // someone else's server would otherwise delete the working directory out
  // from under a live host-mode sandbox that server is still serving.
  const owned = spawnedServer?.pid !== undefined;
  if (spawnedServer?.pid !== undefined) {
    stop(spawnedServer.pid);
    spawnedServer = null;
  } else if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) stop(pid);
  }
  rmSync(PID_FILE, { force: true });
  if (owned) {
    rmSync(SANDBOX_HOST_ROOT, { recursive: true, force: true });
    rmSync(UPLOADS_DIR, { recursive: true, force: true });
    rmSync(ADMIN_FILE, { force: true });
  }
  // Postgres is deliberately left running: it is slow to start, holds no
  // per-run state worth clearing, and is very often not ours to stop.
  await Promise.resolve();
}

// Also usable standalone: `pnpm --filter @loxaic/e2e standup`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  standup().then(
    (r) => { log(`ready at ${r.baseUrl}`); },
    (err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    },
  );
}
