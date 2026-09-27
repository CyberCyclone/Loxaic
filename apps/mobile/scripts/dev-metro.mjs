/**
 * `pnpm dev`'s Metro: reuse the one already on :8081, or start one.
 *
 * See dev-metro-core.mjs for why. Started by turbo beside the API server and
 * the desktop app, so it must stay running either way — a persistent task that
 * exits looks to turbo like one that finished.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, probePort } from './dev-metro-core.mjs';

const PORT = 8081;
const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { action, message } = decide(await probePort(`http://localhost:${String(PORT)}`), PORT);
console.log(`[dev-metro] ${message}`);

if (action === 'start') {
  // The same command as the package's own `start`, pinned to the port the
  // desktop app loads from. Under turbo there is no terminal to answer Expo's
  // prompts, and none are needed with the port chosen and free.
  const child = spawn('pnpm', ['exec', 'dotenv', '-e', '../../.env', '--', 'expo', 'start', '--port', String(PORT)], {
    cwd: MOBILE_DIR,
    stdio: 'inherit',
  });
  const stop = (signal) => { child.kill(signal); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} else {
  // Nothing to run, but stay alive until turbo stops the others, so this task
  // neither ends early nor takes the rest down with it.
  setInterval(() => undefined, 1 << 30);
}
