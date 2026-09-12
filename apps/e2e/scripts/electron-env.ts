/**
 * Environment prep for the self-contained Electron mode (E2E_SELF_CONTAINED=1),
 * where the packaged app brings up its own embedded Postgres + server instead
 * of connecting to a stack this harness stood up.
 *
 * Must be imported BEFORE scripts/standup.ts: standup reads E2E_PORT /
 * E2E_BASE_URL at module load, and this module is what allocates them for a
 * self-contained run (a free port, so the suite can never collide with a dev
 * server on 4000 or a release build on 4100).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF_CONTAINED = process.env.E2E_SELF_CONTAINED === '1';

/**
 * Per-run values that every process has to agree on — the launcher (which
 * bakes them into the app's launch args), the spec workers (which assert on
 * them), and the app itself (which reads one from its own environment) —
 * travel as environment variables and are only *minted* here when absent.
 * A module-level `mkdtempSync` would run once per process and hand each a
 * different directory; see AGENTS.md's note on WebdriverIO's process model.
 */
function perRunDir(envKey: string, prefix: string): string {
  process.env[envKey] ??= mkdtempSync(path.join(os.tmpdir(), prefix));
  return process.env[envKey];
}

/** Fresh per-run data dir handed to the app; null outside self-contained mode. */
export let selfContainedDataDir: string | null = null;

/**
 * The folder the desktop's `pickDirectory` returns under test, instead of
 * opening a native dialog nobody can drive — read by the app as
 * `LOXAIC_E2E_PICK_DIR` (apps/desktop/src/main.js). Minted here so the
 * agent-local-dir spec can assert on the real filesystem afterwards.
 */
export const E2E_PICK_DIR = perRunDir('LOXAIC_E2E_PICK_DIR', 'loxaic-e2e-pick-');

/**
 * The tsnet sidecar the app spawns under test: a script that speaks the
 * real one's stdout protocol without joining a tailnet (fixtures/fake-tsnet.sh),
 * read by the app as `LOXAIC_TSNET_BIN`. Set for every Electron run, not only
 * the tailnet spec — no test may ever reach the real Tailscale control plane,
 * and a spec that enables the tailnet by accident would otherwise do so.
 *
 * Copied out of the repo into a per-run temp dir rather than pointed at in
 * place. A checkout usually lives somewhere macOS protects (~/Documents,
 * ~/Desktop), and the packaged app — launched by chromedriver, not by a
 * terminal whose Files-and-Folders grant it could inherit — is refused when
 * `bash` tries to open the script there: exit 126, "Operation not permitted",
 * while the very same spawn from a shell works. The temp dir carries no such
 * grant, which is also why the folder-picker stand-in lives there.
 */
export const FAKE_TSNET_BIN = ((): string => {
  if (process.env.LOXAIC_TSNET_BIN) return process.env.LOXAIC_TSNET_BIN;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-tsnet.sh');
  const dest = path.join(perRunDir('E2E_TSNET_BIN_DIR', 'loxaic-e2e-tsnet-'), 'fake-tsnet.sh');
  if (!existsSync(dest)) {
    copyFileSync(source, dest);
    chmodSync(dest, 0o755);
  }
  process.env.LOXAIC_TSNET_BIN = dest;
  return dest;
})();

if (SELF_CONTAINED && process.env.E2E_BASE_URL === undefined) {
  // Config modules load synchronously, so ask a child for a free port instead
  // of net.Server's async listen(0).
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});",
    ],
    { encoding: 'utf8' },
  );
  const port = Number(probe.stdout.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not allocate a free port for the self-contained run: ${probe.stderr}`);
  }
  process.env.E2E_PORT = String(port);
  process.env.E2E_BASE_URL = `http://localhost:${String(port)}`;
}

if (SELF_CONTAINED) {
  selfContainedDataDir = perRunDir('E2E_SELF_CONTAINED_DATA_DIR', 'loxaic-e2e-selfcontained-');

  // Seed the instance config the app would otherwise ask the user for. A data
  // dir with no config.json is, by design, a first run: the app opens
  // onboarding and starts no stack at all. This suite is testing the
  // *configured* self-contained path, so it writes what a Solo install looks
  // like — Solo rather than Host because Host requires a container engine and
  // the server refuses to boot without one.
  //
  // The unconfigured path has its own spec (specs/electron/onboarding.spec.ts),
  // which deletes this file to get back to a genuine first run. Written only
  // when absent: a worker re-evaluating this module must not hand the running
  // app a config with a different instanceId from the one it booted with.
  const configFile = path.join(selfContainedDataDir, 'config.json');
  if (!existsSync(configFile)) writeFileSync(
    configFile,
    JSON.stringify(
      {
        version: 1,
        mode: 'solo',
        instanceId: randomUUID(),
        host: { name: 'E2E Host', port: Number(process.env.E2E_PORT), bind: 'localhost', db: { kind: 'embedded' } },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}

/**
 * The data directory the app under test is pointed at, in *both* modes.
 * Self-contained runs need one for their embedded stack; external-server
 * runs did not strictly need one before, but the local executor writes the
 * folders a user picks into `<dataDir>/executor-roots.json` — and without
 * this, a test run would append its temp folders to the developer's real
 * Loxaic config. Env and flags still decide where the app points (see
 * main.js's resolveApi), so an empty data dir here never means onboarding.
 */
export const appDataDir: string = selfContainedDataDir ?? perRunDir('E2E_DESKTOP_DATA_DIR', 'loxaic-e2e-desktop-');

/**
 * Stops the embedded stack a self-contained run leaves behind.
 *
 * wdio ends the session by killing the Electron main process, which never
 * gets its `before-quit` — so the Postgres and server children it spawned
 * outlive it, reparented to launchd, one pair per run. macOS hands out only
 * 32 SysV shared-memory segments in total (`kern.sysv.shmmni`), each Postgres
 * takes one, and after enough runs every later one fails to start with
 * "could not create shared memory segment: No space left on device" — which
 * looks like a flaky spec and is nothing of the kind. Found the hard way, at
 * exactly 29 orphans.
 *
 * Both pids are on disk in this run's own data dir — the supervisor writes
 * `server.pid`, Postgres writes `postmaster.pid` — so nothing outside this
 * run is ever touched. A pid that has already exited is silently skipped.
 */
export function stopSelfContainedLeftovers(): void {
  if (!selfContainedDataDir) return;
  const pidFiles = [
    path.join(selfContainedDataDir, 'server.pid'),
    path.join(selfContainedDataDir, 'postgres', 'postmaster.pid'),
  ];
  for (const file of pidFiles) {
    let pid: number;
    try {
      // postmaster.pid's first line is the pid; server.pid is just the pid.
      pid = Number(readFileSync(file, 'utf8').split('\n')[0].trim());
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[e2e] stopped leftover process ${String(pid)} from ${file}`);
    } catch {
      // Already gone.
    }
  }
}
