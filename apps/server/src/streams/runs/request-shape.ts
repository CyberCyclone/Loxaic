import type { OpenAiTool } from "../../inference/provider.ts";

/**
 * What a conversation's last run sent ahead of its history: the model, the
 * system prompt, the tool schemas and the thinking fields (llama.cpp renders
 * the thinking level into the system prompt, so it is part of the front too). Kept so a compaction can send the very
 * same front and append its instruction — reusing the prefix the backend
 * already holds instead of re-reading the whole conversation.
 *
 * A compaction used to drop the system prompt and the tools, and llama.cpp
 * renders both into the prompt text, so its request diverged from the cache at
 * the first token: on the beta, 235k tokens re-read from scratch — 749 s of
 * prompt processing — for a conversation whose previous turn was 97% cached.
 *
 * In memory and bounded, like the prompt-reuse traces: after a restart there
 * is no shape, and a compaction falls back to the stripped request it always
 * made. The run's shape is exact only as long as nothing between the run and
 * the compaction changes the history's front, which `loadHistory` decides the
 * same way for both.
 */
export interface RequestShape {
  model: string;
  system: string | null;
  tools: OpenAiTool[];
  /** The run's thinking body fields (inference/thinking.ts), `{}` for none. */
  thinking: Record<string, unknown>;
}

const MAX_SHAPES = 500;
const shapes = new Map<string, RequestShape>();

export function recordRequestShape(conversationId: string, shape: RequestShape): void {
  shapes.delete(conversationId);
  if (shapes.size >= MAX_SHAPES) {
    const oldest = shapes.keys().next();
    if (!oldest.done) shapes.delete(oldest.value);
  }
  shapes.set(conversationId, shape);
}

export function lastRequestShape(conversationId: string): RequestShape | undefined {
  return shapes.get(conversationId);
}

/** For tests. */
export function __forgetRequestShapesForTest(): void {
  shapes.clear();
}
