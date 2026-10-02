import { v4 as uuid } from "uuid";
import { usageRecords } from "@loxaic/db/schema";
import type { ContextBreakdown, TurnUsage } from "@loxaic/types";
import type { CompletionResult } from "../../inference/provider.ts";

/** A whole number for an integer column, or null. */
function whole(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value);
}

/**
 * The `usage_records` row for one finished model request — the one builder
 * both the tool loop and compaction insert through.
 *
 * Every figure bound for an integer column is rounded here. llama.cpp reports
 * its `timings` in fractional milliseconds (`prompt_ms: 749609.667`), and the
 * timing columns are integers: before this, every request answered by the
 * built-in llama.cpp router failed to record its usage, and a compaction —
 * which wrote its row after marking the summary complete, with no catch —
 * threw its finished summary away over it. LM Studio reported whole numbers,
 * which is why nothing noticed until the router replaced it.
 */
export function usageRecordValues(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  runId?: string;
  model: string;
  result: CompletionResult;
  /** Our own prefix-reuse measurement; absent for compaction. */
  reusableTokens?: number | null;
  context?: ContextBreakdown | null;
}): typeof usageRecords.$inferInsert {
  const { result } = input;
  return {
    id: uuid(),
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    ...(input.runId ? { runId: input.runId } : {}),
    model: input.model,
    origin: "server",
    inputTokens: whole(result.usage.prompt_tokens) ?? 0,
    // Null, not 0, when the backend says nothing — see the column's comment.
    cachedTokens: whole(result.cachedTokens),
    ...(input.reusableTokens !== undefined ? { reusableTokens: whole(input.reusableTokens) } : {}),
    outputTokens: whole(result.usage.completion_tokens) ?? 0,
    ttftMs: whole(result.ttftMs),
    promptMs: whole(result.timings?.prompt_ms),
    predictMs: whole(result.timings?.predicted_ms),
    totalMs: whole(result.totalMs),
    promptTps: result.promptTps,
    predictedTps: result.genTps,
    // Null when nothing was drafted — never 0, see the column.
    draftTokens: whole(result.timings?.draft_n),
    draftAcceptedTokens: whole(result.timings?.draft_n) == null ? null : (whole(result.timings?.draft_n_accepted) ?? 0),
    contextBreakdown: input.context ?? null,
  };
}

/** The draft figures for a request's `TurnUsage` — present only when the
 * backend drafted something (an MTP head), and absent otherwise, which the
 * client reads as "not speculated", never as every guess wrong. */
export function turnDraftUsage(result: CompletionResult): Pick<TurnUsage, "draft_tokens" | "draft_accepted_tokens"> {
  const drafted = whole(result.timings?.draft_n);
  if (drafted === null) return {};
  return { draft_tokens: drafted, draft_accepted_tokens: whole(result.timings?.draft_n_accepted) ?? 0 };
}
