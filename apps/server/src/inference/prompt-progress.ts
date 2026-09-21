/**
 * A backend's own report of how far it has got evaluating a prompt.
 *
 * llama.cpp's server sends it when a streaming request asks with
 * `return_progress: true`: a `prompt_progress {total, cache, processed,
 * time_ms}` object on otherwise-empty chunks of the *same* SSE stream — one at
 * 0% when the slot starts, then one per decoded batch. That is why this is not
 * a `/slots` poll: the progress belongs to the request itself, so there is no
 * second request that could delay or fail the one it observes, and no slot to
 * match against our request when `--parallel` is above 1.
 *
 * It arrives off a socket, so it is a claim, not a fact: anything malformed is
 * dropped rather than thrown, since progress is decoration and must never be
 * the reason a turn fails.
 */
import type { PromptProgress } from "@loxaic/types";
import { MIN_EVALUATED_TOKENS } from "./prefill-rate.ts";

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A validated `prompt_progress`, or null for anything we cannot trust. */
export function parsePromptProgress(raw: unknown): PromptProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const total = count(r.total);
  const cache = count(r.cache);
  const processed = count(r.processed);
  const timeMs = count(r.time_ms);
  if (total == null || cache == null || processed == null || timeMs == null || total <= 0) return null;
  const processedTokens = Math.min(processed, total);
  const cachedTokens = Math.min(cache, processedTokens);
  const progress: PromptProgress = {
    total_tokens: total,
    cached_tokens: cachedTokens,
    processed_tokens: processedTokens,
    elapsed_ms: timeMs,
    remaining_ms: null,
  };
  progress.remaining_ms = remainingMs(progress);
  return progress;
}

/**
 * Time left at the rate this request has managed so far — llama.cpp's own
 * "timed" progress, `(processed − cache) / time_ms`, so a cached prefix does
 * not read as blistering speed. Null below MIN_EVALUATED_TOKENS evaluated, for
 * the same reason prefill-rate.ts refuses such samples: fixed overheads
 * dominate that early.
 *
 * Shown as a countdown only. It never becomes `prompt_tps` or a prefill-rate
 * sample; those keep using `timings.prompt_per_second`.
 */
export function remainingMs(p: PromptProgress): number | null {
  const evaluated = p.processed_tokens - p.cached_tokens;
  if (evaluated < MIN_EVALUATED_TOKENS || p.elapsed_ms <= 0) return null;
  const perMs = evaluated / p.elapsed_ms;
  return Math.round((p.total_tokens - p.processed_tokens) / perMs);
}
