import type { SandboxRetention } from '@loxaic/api-client';

/**
 * Durations as a sentence, not a number.
 *
 * Retention is expressed in milliseconds everywhere in the stack so nothing
 * has to convert between units — which leaves exactly one place that has to
 * turn them back into something a person reads, and this is it. Shared by the
 * agent Inspector and the sandbox screen so the terms a user is shown before
 * they start work and the ones an admin sets are worded the same way.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  if (days < 365) return `${String(days)} day${days === 1 ? '' : 's'}`;
  const years = Math.round(days / 365);
  return `${String(years)} year${years === 1 ? '' : 's'}`;
}

/**
 * The retention terms in one sentence.
 *
 * Names both halves even though only one of them ever deletes anything: the
 * pause is the part people notice (their container is not running) and the
 * deletion is the part that costs them, so a summary that mentioned only one
 * would be read as the whole policy.
 */
export function describeRetention(retention: SandboxRetention): string {
  const paused = `Workspaces pause after ${formatDuration(retention.idleStopMs)} idle and resume with your files intact.`;
  return retention.reapEnabled
    ? `${paused} They are deleted after ${formatDuration(retention.reapAfterMs)} unused.`
    : `${paused} They are kept until you delete the conversation.`;
}

/** "in 29 days" / "today", for a reap deadline. Absolute dates read as
 * precision this number does not have — the reaper runs on a five-minute
 * tick and the policy can move — so the relative form is the honest one. */
export function formatDeadline(iso: string, now = Date.now()): string {
  const days = Math.round((new Date(iso).getTime() - now) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${String(days)} days`;
}
