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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SELF_CONTAINED = process.env.E2E_SELF_CONTAINED === '1';

/** Fresh per-run data dir handed to the app; null outside self-contained mode. */
export let selfContainedDataDir: string | null = null;

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
  selfContainedDataDir = mkdtempSync(path.join(os.tmpdir(), 'loxaic-e2e-selfcontained-'));

  // Seed the instance config the app would otherwise ask the user for. A data
  // dir with no config.json is, by design, a first run: the app opens
  // onboarding and starts no stack at all. This suite is testing the
  // *configured* self-contained path, so it writes what a Solo install looks
  // like — Solo rather than Host because Host requires a container engine and
  // the server refuses to boot without one.
  //
  // The unconfigured path has its own spec (specs/electron/onboarding.spec.ts),
  // which deletes this file to get back to a genuine first run.
  writeFileSync(
    path.join(selfContainedDataDir, 'config.json'),
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
