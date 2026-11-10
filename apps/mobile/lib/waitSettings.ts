/**
 * Formatting for the approval wait and progress review settings, and for the
 * countdown that shows an approval wait in use. Pure, so the wording is
 * unit-tested.
 */

/** The window choices the settings screen offers, beside "server default". */
export const WAIT_PRESETS_MS = [5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000] as const;

/** Working time between progress reviews, beside "server default". */
export const PROGRESS_CHECK_PRESETS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000] as const;

/** Steps between progress reviews, beside "server default". */
export const PROGRESS_STEP_PRESETS = [10, 20, 50, 100] as const;

/**
 * A duration a person reads at a glance: "45 s", "10 min", "1 h 30 min".
 * Rounded to the unit that matters at that size — nobody deciding how long to
 * be waited on cares about seconds once it is minutes.
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${String(min)} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${String(h)} h` : `${String(h)} h ${String(rest)} min`;
}

/** A countdown: "9:41", or "1:02:05" past the hour. Never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${ss}` : `${String(m)}:${ss}`;
}

/**
 * The whole countdown sentence for a tool approval. `remainingMs` is already
 * corrected for clock skew by the caller. The adaptive clause says *why* the
 * window is longer than the setting — otherwise a 44-minute countdown against
 * a 10-minute setting looks like a bug.
 */
export function deadlineSentence(input: {
  remainingMs: number;
  timeoutMs?: number;
  basis?: 'setting' | 'adaptive';
}): string {
  const head = `If nobody answers in ${formatCountdown(input.remainingMs)}, this call won't run.`;
  if (input.basis === 'adaptive' && input.timeoutMs != null) {
    return `${head} Waiting longer than usual because a step here has taken up to ${formatDuration(input.timeoutMs / 2)}.`;
  }
  return head;
}
