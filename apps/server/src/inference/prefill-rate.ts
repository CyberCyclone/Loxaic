/**
 * How fast this deployment has recently evaluated prompts, per model — the
 * one input an ETA for "Processing prompt…" needs.
 *
 * In memory and small on purpose. Not a `usage_records` query: that table has
 * no `user_id` index and this is read before every model request, under the
 * inference slot. After a restart there is simply no rate until the first few
 * requests land, and the client shows the prompt's size without an ETA — the
 * conservative direction, same as prompt-reuse.ts's traces.
 *
 * **This is not `prompt_tps` and must never be stored or shown as a speed.**
 * AGENTS.md forbids deriving a prompt rate from `prompt_tokens / ttft`, since
 * a cached prompt makes that a meaningless number. A sample here divides only
 * the tokens that were *evaluated* — and is taken only when that count is
 * known exactly: llama.cpp's own `prompt_per_second`, or a request whose
 * prefix was a measured strict extension of the one before (so the rest is
 * exactly `prompt_tokens − reusable`). Everything else contributes nothing.
 * If the backend evicted the prefix anyway, the true evaluated count was
 * larger than ours, the sample reads slow, and the ETA errs long — the safe
 * side for a number whose job is "this will take a while".
 */

/** Samples kept per model. A median of a handful: one request that raced a
 * model swap or a busy GPU should not move the estimate much. */
const SAMPLES_PER_MODEL = 8;
/** Models tracked at once. */
const MAX_MODELS = 64;
/** Below this many evaluated tokens, TTFT is dominated by fixed overheads
 * (sampling setup, the first token itself) rather than evaluation. */
export const MIN_EVALUATED_TOKENS = 256;

const rates = new Map<string, number[]>();

export interface PrefillObservation {
  /** The backend's own evaluation rate, when it reports one (llama.cpp). */
  promptTps: number | null;
  promptTokens: number;
  /** Tokens known to have been offered from the previous request, and only
   * when that was an exact measurement (a strict extension). Null otherwise. */
  exactReusableTokens: number | null;
  ttftMs: number | null;
  /** A model load happened inside this request's TTFT. */
  loadedModel: boolean;
}

/** A rate in tokens/second from one finished request, or null if it does not
 * yield a trustworthy one. Exported for the tests. */
export function sampleFrom(o: PrefillObservation): number | null {
  if (o.promptTps != null && o.promptTps > 0 && Number.isFinite(o.promptTps)) return o.promptTps;
  if (o.loadedModel || o.exactReusableTokens == null || o.ttftMs == null || o.ttftMs <= 0) return null;
  const evaluated = o.promptTokens - o.exactReusableTokens;
  if (evaluated < MIN_EVALUATED_TOKENS) return null;
  return evaluated / (o.ttftMs / 1000);
}

export function recordPrefill(model: string, o: PrefillObservation): void {
  const sample = sampleFrom(o);
  if (sample == null) return;
  let list = rates.get(model);
  if (!list) {
    if (rates.size >= MAX_MODELS) {
      const oldest = rates.keys().next().value;
      if (oldest !== undefined) rates.delete(oldest);
    }
    list = [];
  } else {
    // Re-insert so the map's order is least-recently-used first.
    rates.delete(model);
  }
  list.push(sample);
  if (list.length > SAMPLES_PER_MODEL) list.shift();
  rates.set(model, list);
}

/** Median recent rate for a model in tokens/second, or null with no samples. */
export function prefillRate(model: string): number | null {
  const list = rates.get(model);
  if (!list?.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function __resetPrefillRatesForTest(): void {
  rates.clear();
}
