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
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

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
