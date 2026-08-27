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
import { mkdtempSync } from 'node:fs';
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
  selfContainedDataDir = mkdtempSync(path.join(os.tmpdir(), 'shannon-e2e-selfcontained-'));
}
