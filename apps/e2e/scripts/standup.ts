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
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockGithub, VALID_TOKEN } from './mock-github.ts';
import { startGitServer, type GitServer } from './git-server.ts';

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
/** Stop function for the in-process mock GitHub API server, or null when this
 * run didn't start the spawned server (and so never started this either). */
let stopMockGithub: (() => Promise<void>) | null = null;
/**
 * `standup()` runs in WebdriverIO's launcher process (the `onPrepare` hook);
 * a spec file runs in a separate worker process it forks — a different
 * Node process with its own module cache. So `mockGithubUrl`'s port (chosen
 * at random each run) cannot be read back as a plain exported variable the
 * way `BASE_URL` can (that one is recomputed identically from `E2E_PORT` in
 * every process). It goes through a file instead, the same way `ADMIN_FILE`
 * carries the per-run admin credentials across the same boundary.
 */
const MOCK_GITHUB_FILE = path.join(RUN_DIR, 'mock-github.json');

/** Reads the mock GitHub API server's URL back, from whichever process asks —
 * a spec's own worker process, not the one that started it. */
export function mockGithubUrl(): string {
  if (!existsSync(MOCK_GITHUB_FILE)) {
    throw new Error(`[e2e] no mock GitHub server recorded at ${MOCK_GITHUB_FILE} — was standup() run?`);
  }
  const { url } = JSON.parse(readFileSync(MOCK_GITHUB_FILE, 'utf8')) as { url: string };
  return url;
}

/** The stand-in for GitHub's hosted MCP server, handed across processes the
 * same way as the mock GitHub API (see `mockGithubUrl`). */
const MOCK_GITHUB_MCP_FILE = path.join(RUN_DIR, 'mock-github-mcp.json');

/** The mock GitHub MCP server's `/mcp` URL, from whichever process asks. */
export function mockGithubMcpUrl(): string {
  if (!existsSync(MOCK_GITHUB_MCP_FILE)) {
    throw new Error(`[e2e] no mock GitHub MCP server recorded at ${MOCK_GITHUB_MCP_FILE} — was standup() run?`);
  }
  const { url } = JSON.parse(readFileSync(MOCK_GITHUB_MCP_FILE, 'utf8')) as { url: string };
  return url;
}

/** The mock GitHub MCP server runs as its own process from apps/server's tree,
 * because apps/e2e has no MCP SDK of its own. Started with the spawned server,
 * stopped with it. */
let mockGithubMcp: ChildProcess | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}

/**
 * Where the harness's git daemon keeps its bare repositories. Unlike the
 * mock GitHub port, this needs no file: it is a fixed path under this run's
 * own artifacts directory, computable identically in any process without
 * having to ask the one that created it.
 */
export const GIT_SERVER_DIR = path.join(RUN_DIR, 'git');
/** The harness's git server, for specs that clone a workspace. Started with
 * the spawned server, stopped with it. */
/** Internal to this module — a spec runs in a different process (see
 * `mockGithubUrl`'s doc comment above) and must use `GIT_SERVER_DIR` instead,
 * which needs no cross-process handoff because it is a fixed, computable path. */
let gitServer: GitServer | null = null;
const FIXTURES_DIR = path.join(E2E_DIR, 'fixtures');
/** The mock scenario engine's fixture — see mock-scenarios.ts. Passed
 * unconditionally: it is inert under real-model mode (only mockStream reads
 * it), and every mock-lane spec that drives a multi-step scenario needs it
 * wired, not just the ones that happen to be running today. */
const SCENARIOS_FIXTURE = path.join(FIXTURES_DIR, 'scenarios.json');

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
    // Neither lane's wiring is observable from /health: GITHUB_API_URL,
    // MOCK_SCENARIOS_FILE, SANDBOX_ALLOW_NETWORK, and SANDBOX_EXTRA_HOSTS all
    // decide whether a spec's workspace/scenario/network actually works, and a
    // health check that only
    // sees `inference: "mock"` or `"ok"` cannot tell this harness's own server
    // apart from `pnpm dev`, a previous run's leftover, or a server standing
    // up a *different* set of fixtures. Reusing blind turns a harness
    // misconfiguration into a failure that reads as a real bug (an agent
    // silently missing network, a scenario nobody wrote). So this always
    // insists on a server it started itself — E2E_NO_STANDUP=1 is the
    // documented way to point a run at one on purpose.
    throw new Error(
      `[e2e:standup] a server is already listening at ${BASE_URL}, and this harness always starts ` +
        'its own rather than trust a health check to prove someone else\'s server is wired the way ' +
        'this run needs (GitHub API URL, mock scenarios, sandbox network). Stop it, use a ' +
        'different E2E_PORT / E2E_BASE_URL, or set E2E_NO_STANDUP=1 if that server is intentionally yours.',
    );
  }

  log(`starting server on port ${String(PORT)} with ${REAL_MODEL ? `INFERENCE_BASE_URL=${String(INFERENCE_URL)}` : 'MOCK_INFERENCE=true'}`);
  mkdirSync(SANDBOX_HOST_ROOT, { recursive: true });
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const { email: adminEmail } = writeAdminCreds();
  // The git server first, because the mock GitHub API hands out its URLs as
  // each repo's clone_url.
  gitServer = await startGitServer({
    dir: GIT_SERVER_DIR,
    fixtures: {
      'bugfix-app': path.join(FIXTURES_DIR, 'bugfix-app'),
      'other-repo': path.join(FIXTURES_DIR, 'bugfix-app'),
      'seeded-app': SEED_DIR,
    },
  });
  const mockGithub = await startMockGithub({ cloneUrlFor: gitServer.cloneUrlFor });
  stopMockGithub = mockGithub.stop;
  writeFileSync(MOCK_GITHUB_FILE, JSON.stringify({ url: mockGithub.url }), 'utf8');
  // GitHub's hosted MCP server, standing in for api.githubcopilot.com. It
  // refuses every bearer but the one the mock GitHub API accepts, so a GitHub
  // tool answering at all proves the connection's token reached it.
  const mcpPort = await freePort();
  mockGithubMcp = spawn(path.join(REPO_ROOT, 'apps/server/node_modules/.bin/tsx'), ['test-fixtures/mock-mcp-http-server.ts'], {
    cwd: path.join(REPO_ROOT, 'apps/server'),
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, MOCK_MCP_HTTP_PORT: String(mcpPort), MOCK_MCP_HTTP_TOKEN: VALID_TOKEN },
  });
  await waitUntil('the mock GitHub MCP server to listen', () => tcpOpen('127.0.0.1', mcpPort), 60_000);
  const mockGithubMcpUrlValue = `http://127.0.0.1:${String(mcpPort)}/mcp`;
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(MOCK_GITHUB_MCP_FILE, JSON.stringify({ url: mockGithubMcpUrlValue }), 'utf8');
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
      GITHUB_API_URL: mockGithub.url,
      // Read when a GitHub MCP server connects, never stored in its row — so
      // the rows this harness's boot backfill creates in the shared database
      // keep pointing at GitHub once the harness has gone.
      GITHUB_MCP_URL: mockGithubMcpUrlValue,
      MOCK_SCENARIOS_FILE: SCENARIOS_FIXTURE,
      // Lets a networked sandbox reach this machine's git server by name on
      // Linux and Podman; Docker Desktop resolves it without help. Network
      // itself stays off by default — a spec that clones turns it on through
      // the admin API and resets it after, like every other sandbox setting.
      SANDBOX_EXTRA_HOSTS: 'host.docker.internal:host-gateway',
      // The idle-stop reaper's real tick is five minutes.
      // sandbox-lifecycle.spec.ts has to watch it actually pause a workspace,
      // and reaching past the timer to stop a container by hand would assert
      // nothing about the timer that is the subject. Two seconds costs one
      // cheap query per tick and lets the spec observe the production path.
      SANDBOX_REAP_INTERVAL_MS: '2000',
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
  if (stopMockGithub) {
    await stopMockGithub();
    stopMockGithub = null;
  }
  rmSync(MOCK_GITHUB_FILE, { force: true });
  if (mockGithubMcp?.pid !== undefined) {
    try {
      mockGithubMcp.kill();
    } catch {
      // Already gone.
    }
    mockGithubMcp = null;
  }
  rmSync(MOCK_GITHUB_MCP_FILE, { force: true });
  if (gitServer) {
    gitServer.stop();
    gitServer = null;
    if (owned) rmSync(GIT_SERVER_DIR, { recursive: true, force: true });
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
