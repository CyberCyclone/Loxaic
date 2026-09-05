import type { ContextBreakdown, ContextCategory, ContextPart } from "@loxaic/types";
import type { ChatMessage, OpenAiTool } from "./provider.ts";
import { textOfContent } from "./provider.ts";

/**
 * Attributing a prompt's token count to the things that made it up.
 *
 * We never tokenise anything ourselves. The backend hands back an
 * authoritative `prompt_tokens`, and this module splits *that* number across
 * the categories by measuring characters at assembly time. The total is
 * therefore exact by construction; only the split between categories is an
 * approximation.
 *
 * This has to live server-side. The agent ships its tool schemas in
 * `body.tools` — they never appear in `messages`, so a client looking at the
 * conversation cannot see them at all, and on a small window they're routinely
 * the largest single slice of the context.
 */

/** Chars per token, per category.
 *
 * English prose sits around 4.0 chars/token. JSON, code and tool output
 * tokenise far denser — punctuation, braces, quotes and identifiers all split
 * — so they land nearer 3.0-3.3. Weighting by these instead of using a flat
 * character share matters: flat share systematically under-attributes `tools`
 * and `tool_io`, which are exactly the categories someone opens this popup to
 * find. */
const CHARS_PER_TOKEN: Record<ContextCategory, number> = {
  system: 4.0,
  tools: 3.0,
  summary: 4.0,
  history: 4.0,
  reasoning: 4.0,
  tool_io: 3.2,
  current: 4.0,
  response: 4.0,
};

/** Standalone estimate for one category's text — used only where no measured
 * figure exists at all (e.g. the compact run's `before` fallback). Anything
 * with a real token count from the backend must use that instead. */
export function estimateTokens(category: ContextCategory, text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN[category]);
}

/** How a compaction summary is replayed into subsequent prompts. One shared
 * constant: the loaders that build prompts with it and the tallies that
 * attribute its tokens must be measuring the same string. */
export const SUMMARY_PREAMBLE =
  "Summary of the conversation so far. Earlier messages were compacted into this summary; treat it as the authoritative history.\n\n";

export function summaryMessage(summaryText: string): Extract<ChatMessage, { role: "system" }> {
  return { role: "system", content: SUMMARY_PREAMBLE + summaryText };
}

/** Character counts per category, accumulated while a prompt is assembled. */
export type ContextTally = Partial<Record<ContextCategory, number>>;

export function addChars(tally: ContextTally, category: ContextCategory, text: string | null | undefined): void {
  if (!text) return;
  tally[category] = (tally[category] ?? 0) + text.length;
}

/**
 * Tally a prompt straight off the wire payload. Used by the shared tool loop
 * (both surfaces), which has no block-level view of its history — by the time
 * messages are `ChatMessage`s the thinking has already been dropped, so
 * there's nothing to separate: no `reasoning` category ever applies.
 */
export function tallyChatMessages(messages: ChatMessage[], tools?: OpenAiTool[]): ContextTally {
  const tally: ContextTally = {};
  if (tools?.length) addChars(tally, "tools", JSON.stringify(tools));

  // The final user message is this turn's prompt; earlier ones are history.
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");

  messages.forEach((msg, i) => {
    switch (msg.role) {
      case "system":
        addChars(tally, "system", msg.content);
        break;
      case "user":
        // Image parts are deliberately not tallied: their prompt-token cost is
        // backend-specific (patch embeddings, not text), so pretending a char
        // count covers them would be worse than leaving them out of the split.
        addChars(tally, i === lastUserIdx ? "current" : "history", textOfContent(msg.content));
        break;
      case "assistant":
        addChars(tally, "history", msg.content);
        if (msg.tool_calls?.length) addChars(tally, "tool_io", JSON.stringify(msg.tool_calls));
        break;
      case "tool":
        addChars(tally, "tool_io", msg.content);
        break;
    }
  });

  return tally;
}

export interface ApportionMeta {
  historyMessages: number;
  historyLimit: number;
  historyTruncated: boolean;
  windowTokens?: number | null;
}

/**
 * Split `promptTokens` across the tallied categories, then append the measured
 * response. The returned parts sum to `used_tokens` exactly — that's what lets
 * the UI be self-checking (rows minus free space must equal in + out).
 *
 * Note the scale factor also absorbs chat-template overhead — the
 * `<|im_start|>` wrappers, role markers and BOS tokens that the backend counts
 * but we never measured. Spreading that pro-rata across categories is the one
 * deliberate inaccuracy here; it's bounded and small, and the alternative
 * (pretending the overhead doesn't exist) would make the parts fail to sum.
 */
export function apportion(
  tally: ContextTally,
  promptTokens: number,
  completionTokens: number,
  meta: ApportionMeta,
): ContextBreakdown {
  const base: ContextBreakdown = {
    used_tokens: promptTokens + completionTokens,
    parts: [],
    history_messages: meta.historyMessages,
    history_limit: meta.historyLimit,
    history_truncated: meta.historyTruncated,
    window_tokens: meta.windowTokens ?? null,
  };

  // Estimated tokens per category. Zero-char categories are dropped entirely
  // rather than emitted as 0 — a row reading "0" is noise, not information.
  const estimates = (Object.entries(tally) as [ContextCategory, number][])
    .filter(([, chars]) => chars > 0)
    .map(([category, chars]) => ({ category, est: chars / CHARS_PER_TOKEN[category] }));

  const totalEst = estimates.reduce((sum, e) => sum + e.est, 0);

  const parts: ContextPart[] = [];
  // No measurable prompt (nothing tallied, or the backend reported no usage) —
  // `used_tokens` stays truthful and the UI falls back to its no-breakdown state.
  if (totalEst > 0 && promptTokens > 0) {
    const scale = promptTokens / totalEst;
    for (const { category, est } of estimates) {
      parts.push({ category, tokens: Math.round(est * scale) });
    }
    // Rounding leaves a residual of a token or two. Push it onto the largest
    // part so the sum is exact without visibly distorting anything.
    const residual = promptTokens - parts.reduce((sum, p) => sum + p.tokens, 0);
    if (residual !== 0) {
      const largest = parts.reduce((a, b) => (b.tokens > a.tokens ? b : a));
      largest.tokens += residual;
    }
  }

  if (completionTokens > 0) parts.push({ category: "response", tokens: completionTokens });

  return { ...base, parts };
}
