/**
 * Each SSE chunk from an OpenAI-style completion stream (delta or reasoning)
 * is one sampled token, so counting chunks against wall-clock time since the
 * first one gives a live tok/s estimate without waiting for the final usage
 * event. `stats` is a ref-held map so this stays allocation-free per tick.
 */
export function tickLiveTps(stats: Map<string, { start: number; count: number }>, messageId: string): number {
  let entry = stats.get(messageId);
  if (!entry) {
    entry = { start: Date.now(), count: 0 };
    stats.set(messageId, entry);
  }
  entry.count += 1;
  const elapsedSec = Math.max((Date.now() - entry.start) / 1000, 0.05);
  return entry.count / elapsedSec;
}
