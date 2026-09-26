/**
 * Freezing and thawing this run's server, for specs about the app losing it.
 *
 * `SIGSTOP` rather than a kill: the process keeps its listening socket and its
 * open connections, so the kernel still accepts new ones and nothing is ever
 * answered — what a host that has gone to sleep, or wedged, looks like from a
 * phone. A killed server refuses at once, which is the easy case; the app has
 * to cope with this one too. It is also the only way to take the server away
 * on native, where there is no page to patch (compare `server-unreachable.spec.ts`).
 *
 * Always thaw in an `afterEach`: a spec that fails while the server is frozen
 * otherwise takes every spec after it down with it.
 */
import { execFileSync } from 'node:child_process';
import { PORT, SELF_CONTAINED } from '../../scripts/standup.ts';

let frozen: number | null = null;

/** The process listening on this run's port — the server itself, not the
 * `tsx`/`pnpm` wrapper that started it, which SIGSTOP would stop to no effect. */
function serverPid(): number {
  if (SELF_CONTAINED || process.env.E2E_NO_STANDUP === '1') {
    throw new Error('pauseServer needs the harness to own the server (not E2E_SELF_CONTAINED or E2E_NO_STANDUP)');
  }
  const out = execFileSync('lsof', ['-tiTCP:' + String(PORT), '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
  const pid = Number(out.split('\n')[0]);
  if (!pid) throw new Error(`nothing is listening on ${String(PORT)}`);
  return pid;
}

export function pauseServer(): void {
  if (frozen) return;
  const pid = serverPid();
  process.kill(pid, 'SIGSTOP');
  frozen = pid;
}

export function resumeServer(): void {
  if (!frozen) return;
  try {
    process.kill(frozen, 'SIGCONT');
  } finally {
    frozen = null;
  }
}
