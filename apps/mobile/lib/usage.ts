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
    cache: 0,
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
    cache: 0,
    context: u.context,
  };
}
