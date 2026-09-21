/**
 * Formatting for the check-in and approval wait settings, and for the
 * countdown that shows them in use. Pure, so the wording is unit-tested.
 */

/** The window choices the settings screen offers, beside "server default". */
export const WAIT_PRESETS_MS = [5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000] as const;

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

export type WaitKind = 'checkin' | 'approval';

/** What happens when a wait runs out, in the run's own voice. */
export function onTimeoutPhrase(
  kind: WaitKind,
  onTimeout: 'continue' | 'answer' | undefined,
  unattended: number | undefined,
  autoContinues: number | undefined,
): string {
  if (kind === 'approval') return "this call won't run";
  if (onTimeout === 'continue') {
    const ladder =
      unattended != null && autoContinues != null && autoContinues > 0
        ? ` (${String(unattended + 1)} of ${String(autoContinues)})`
        : '';
    return `I'll keep going${ladder}`;
  }
  return "I'll wrap up with what I have";
}

/**
 * The whole countdown sentence. `remainingMs` is already corrected for clock
 * skew by the caller. The adaptive clause says *why* the window is longer than
 * the setting — otherwise a 44-minute countdown against a 10-minute setting
 * looks like a bug.
 */
export function deadlineSentence(input: {
  kind: WaitKind;
  remainingMs: number;
  timeoutMs?: number;
  basis?: 'setting' | 'adaptive';
  onTimeout?: 'continue' | 'answer';
  unattended?: number;
  autoContinues?: number;
}): string {
  const what = onTimeoutPhrase(input.kind, input.onTimeout, input.unattended, input.autoContinues);
  const head = `If nobody answers in ${formatCountdown(input.remainingMs)}, ${what}.`;
  if (input.basis === 'adaptive' && input.timeoutMs != null) {
    return `${head} Waiting longer than usual because a step here has taken up to ${formatDuration(input.timeoutMs / 2)}.`;
  }
  return head;
}
