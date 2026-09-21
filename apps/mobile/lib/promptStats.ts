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

/**
 * Whether "Loading model…" still holds after `event`. Set by `model.loading`;
 * carried through a plain `prompt.stats` (which the server sends after it,
 * before the first token); ended by one that carries measured progress — only
 * a loaded model evaluating the prompt can report that — and by anything else.
 */
export function loadingAfter(loading: boolean, event: StreamEventKind): boolean {
  if (event.kind === 'model.loading') return true;
  if (event.kind === 'prompt.stats') return loading && !event.progress;
  return false;
}

/**
 * Whether the stats line belongs under the status right now.
 *
 * Deliberately **not** gated on a model load. The server still measures size
 * and reuse for a request that has to load its model first (it withholds only
 * the ETA, which a load makes meaningless), and nothing is emitted between
 * `prompt.stats` and the first token — the same event that ends "Loading
 * model…" also clears the stats. So a `!loadingModel` gate meant the line
 * never rendered for such a run, which is the longest silent gap there is.
 */
export function showPromptStats(input: {
  promptStats: PromptStats | null | undefined;
  queuePosition?: number | null;
  compacting?: boolean;
}): boolean {
  return !!input.promptStats && !input.queuePosition && !input.compacting;
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

function floorPct(part: number, whole: number): number {
  // Floored, like the usage row: 99.6% is not a perfect 100%.
  return whole > 0 ? Math.max(0, Math.min(100, Math.floor((part / whole) * 100))) : 0;
}

/**
 * The bar's two segments, as percentages of the whole prompt: what the
 * backend reused from its cache, and what it has evaluated beyond that. Null
 * when the backend reported no progress — the bar is for measurements only.
 */
export function promptProgressSegments(stats: PromptStats): { cachedPct: number; evaluatedPct: number } | null {
  const p = stats.progress;
  if (!p) return null;
  const cachedPct = floorPct(p.cached_tokens, p.total_tokens);
  const evaluatedPct = Math.min(100 - cachedPct, floorPct(p.processed_tokens - p.cached_tokens, p.total_tokens));
  return { cachedPct, evaluatedPct };
}

/**
 * The line when the backend reported progress: "83k tokens · 33% cached ·
 * 40% evaluated · about 3 min left". No `~` and no "(estimate)", because none
 * of it is one. "cached" is the backend's word for what it reused, which is
 * deliberately not "reusable" — that is our figure for what we offered.
 * "evaluated" is of the part that was not cached (llama.cpp's own timed
 * progress), so a big cache hit does not make the bar look nearly done.
 */
function describeMeasured(p: NonNullable<PromptStats['progress']>): string {
  const parts = [`${formatTokens(p.total_tokens)} tokens`];
  if (p.cached_tokens > 0) parts.push(`${String(floorPct(p.cached_tokens, p.total_tokens))}% cached`);
  const toEvaluate = p.total_tokens - p.cached_tokens;
  parts.push(`${String(toEvaluate > 0 ? floorPct(p.processed_tokens - p.cached_tokens, toEvaluate) : 100)}% evaluated`);
  if (p.remaining_ms != null) parts.push(`about ${formatEta(p.remaining_ms)} left`);
  return parts.join(' · ');
}

/**
 * The line itself: "~83k tokens · 0% reusable · about 7 min (estimate)".
 *
 * Reuse is a percentage only when measured; unknown reuse is left unsaid, and
 * the ETA then reads "up to about", since it was computed as if nothing could
 * be reused. `0% reusable` is a real measurement (the prefix broke) and is
 * shown — the rule is never to turn null into 0, not never to show 0.
 *
 * Once the backend reports progress the whole line is the backend's figures
 * instead — see describeMeasured.
 */
export function describePromptStats(stats: PromptStats): string {
  if (stats.progress) return describeMeasured(stats.progress);
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
