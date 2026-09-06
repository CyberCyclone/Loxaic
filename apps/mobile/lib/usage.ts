import type { ApiMessageUsage, TurnUsage } from '@loxaic/api-client';
import type { MessageUsage } from '@/lib/types';

/**
 * The two ways usage reaches the client — a persisted row on cold load, and a
 * live `TurnUsage` off the stream — converge here.
 *
 * These lived duplicated byte-for-byte in useChatSession and useAgentSession.
 * Keeping one copy is what stops the two surfaces drifting apart the next time
 * a usage field is added (which is exactly how `context` would have been
 * wired into chat only).
 */

/** Persisted usage row (if any) → the shape Message/MessageList render — real, backend-measured, never guessed. */
export function toMessageUsage(usage: ApiMessageUsage | null): MessageUsage | undefined {
  if (!usage) return undefined;
  return {
    in: usage.inputTokens,
    out: usage.outputTokens,
    tps: usage.predictedTps ?? 0,
    promptTps: usage.promptTps,
    totalMs: usage.totalMs,
    ttftMs: usage.ttftMs,
    cachedTokens: usage.cachedTokens,
    reusableTokens: usage.reusableTokens,
    context: usage.contextBreakdown ?? undefined,
  };
}

/** Same shape, from a live stream's TurnUsage instead of a persisted DB row. */
export function usageFromTurn(u: TurnUsage): MessageUsage {
  return {
    in: u.prompt_tokens,
    out: u.completion_tokens,
    tps: u.gen_tps ?? 0,
    promptTps: u.prompt_tps,
    totalMs: u.total_ms,
    ttftMs: u.ttft_ms ?? null,
    cachedTokens: u.cached_tokens ?? null,
    reusableTokens: u.reusable_tokens ?? null,
    ...(u.omitted_attachments ? { omittedAttachments: u.omitted_attachments } : {}),
    context: u.context,
  };
}

/**
 * How much of a turn's prompt did not need fresh evaluation, as a percentage,
 * plus where that number came from.
 *
 * Provenance matters enough to carry around: `cachedTokens` is the backend's
 * own report and actually proves a cache hit, but only llama.cpp reports it.
 * `reusableTokens` is measured by our server — the part of the prompt that
 * repeated the previous request exactly — so it exists on every backend, but
 * it proves only what we offered, not what the backend did with it. Returns
 * null when neither is known, so callers can render "—" rather than "0%".
 */
export function promptReuse(
  u: Pick<MessageUsage, 'in' | 'cachedTokens' | 'reusableTokens'>,
): { pct: number; measured: boolean } | null {
  if (u.in <= 0) return null;
  const measured = u.cachedTokens != null;
  const tokens = u.cachedTokens ?? u.reusableTokens;
  if (tokens == null) return null;
  // Floor, not round: 99.58% reuse displayed as "100%" claims a perfect hit
  // that did not happen, and this whole figure exists to stop the UI
  // flattering the cache. Only a genuine 100% ever reads as 100%.
  return { pct: Math.floor((Math.min(tokens, u.in) / u.in) * 100), measured };
}
