import type { Message } from '@/lib/types';

/**
 * What the newest message's live counter — "Thinking… 12s", the elapsed time
 * under a reply, the typing indicator's wait — counts from.
 *
 * It used to be the run's start for all of them. A run is a whole turn, and an
 * agent turn is many messages, one per tool iteration: fifty iterations in,
 * a reply seconds old read "Thinking… 1955s". So the counter belongs to the
 * message — its `startedAt` — and the run's start is only what it falls back
 * to: before this turn has a reply of its own (the first queue wait and
 * prefill, while the newest message is still the person's), and for a message
 * whose start nobody reported (an older server, history).
 *
 * Never earlier than the run's start, which a message of this run cannot
 * precede: that keeps a previous turn's reply, or a clock reading that
 * disagrees by a hair, from making a counter jump back.
 *
 * Null when nothing is running.
 */
export function liveCounterStart(
  newest: Pick<Message, 'role' | 'startedAt'> | undefined,
  runStartedAt: number | null | undefined,
): number | null {
  if (!runStartedAt) return null;
  if (!newest || newest.role === 'user' || newest.startedAt === undefined) return runStartedAt;
  return Math.max(newest.startedAt, runStartedAt);
}

/**
 * A reply that has nothing to show yet, which the typing indicator stands in
 * for during model load and prompt processing.
 *
 * Nothing means no thinking, no text **and no tool calls**. A reply that is
 * only a tool call — a model that calls `subagent` or `bash` without a word —
 * used to count as empty, so its card was hidden behind "Processing prompt…"
 * for as long as the tools ran, counting the whole run's age.
 */
export function isEmptyGenerating(msg: Pick<Message, 'role' | 'thinking' | 'text' | 'tools'> | undefined): boolean {
  return !!msg && msg.role === 'assistant' && !msg.thinking && !msg.text && !msg.tools?.length;
}
