import type { PromptStats, StreamEventKind } from '@loxaic/api-client';

/**
 * The "Processing prompt…" line's evidence: how big the prompt is, how much of
 * it the backend was offered to reuse, and roughly how long evaluating the
 * rest should take. All three are estimates and say so — the point is to tell
 * a twenty-minute prefill of 80k fresh tokens apart from a hang, not to be a
 * stopwatch.
 */

/** Live fold, mirroring the server's: set by `prompt.stats`, gone at the
 * message's first output of any kind. */
export function foldPromptStats(prev: PromptStats | null, event: StreamEventKind): PromptStats | null {
  if (event.kind === 'prompt.stats') {
    const { kind: _kind, ...stats } = event;
    return stats;
  }
  if (
    prev &&
    (event.kind === 'text.delta' || event.kind === 'thinking.delta' || event.kind === 'tool.call' || event.kind === 'message.end') &&
    event.message_id === prev.message_id
  ) {
    return null;
  }
  return prev;
}

/** "83k", "1.2k", "640". */
export function formatTokens(n: number): string {
  if (n >= 10_000) return `${String(Math.round(n / 1000))}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatEta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(Math.max(1, s))} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${String(min)} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${String(h)} h ${String(rest)} min` : `${String(h)} h`;
}

/**
 * The line itself: "~83k tokens · 0% reusable · about 7 min (estimate)".
 *
 * Reuse is a percentage only when measured; unknown reuse is left unsaid, and
 * the ETA then reads "up to about", since it was computed as if nothing could
 * be reused. `0% reusable` is a real measurement (the prefix broke) and is
 * shown — the rule is never to turn null into 0, not never to show 0.
 */
export function describePromptStats(stats: PromptStats): string {
  const parts = [`~${formatTokens(stats.prompt_tokens_est)} tokens`];
  const reuseKnown = stats.reusable_tokens != null;
  if (stats.reusable_tokens != null && stats.prompt_tokens_est > 0) {
    // Floored, like the usage row: 99.6% is not a perfect 100%.
    const pct = Math.min(100, Math.floor((stats.reusable_tokens / stats.prompt_tokens_est) * 100));
    parts.push(`${String(pct)}% reusable`);
  }
  if (stats.eta_ms != null) {
    parts.push(`${reuseKnown ? 'about' : 'up to about'} ${formatEta(stats.eta_ms)}`);
  }
  return `${parts.join(' · ')} (estimate)`;
}
