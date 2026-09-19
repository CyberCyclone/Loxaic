import { createHash } from "node:crypto";
import type { ChatMessage, OpenAiTool } from "./provider.ts";

/**
 * How much of a prompt we *offered* the backend to reuse.
 *
 * llama.cpp and LM Studio both cache the KV state of a prompt **prefix**: a
 * turn is cheap only when the previous request's prompt is a literal prefix of
 * this one. llama.cpp reports what it actually reused (`timings.cache_n`); LM
 * Studio reports nothing about caching on any endpoint, so on that backend
 * there is no ground truth to display at all.
 *
 * What we can always establish, exactly, is the other half: whether the prompt
 * we just built still starts with the prompt we sent last time. That is a
 * property of our own request, it is the thing the app is responsible for, and
 * it is precisely what a sliding history window destroys. It is *not* proof
 * the backend reused anything — it may have evicted the slot for another
 * conversation, been restarted, or reloaded the model. Report it as what it
 * is: reusable, not cached.
 *
 * ## How the token count is exact
 *
 * We never tokenise anything. When the previous request's whole message list
 * is a prefix of this one — every ordinary next turn, and every iteration of
 * the tool loop — the reusable prefix *is* the previous request, so its
 * measured `prompt_tokens` is the answer. That number came from the backend,
 * so it is exact but for the handful of tokens the chat template appends as
 * the generation prompt (`<|im_start|>assistant\n` and friends, 3-5 tokens for
 * Qwen), which sat at the end of the previous prompt and is not reusable. The
 * count is therefore a very tight overestimate, never a guess.
 *
 * When the prefix breaks earlier than that we report 0 rather than estimating.
 * The backend could still reuse everything up to the break, so 0 is a floor —
 * but in practice the break is at the *first* message after the system prompt
 * (a history re-anchor changes the oldest replayed message), where the true
 * value really is near zero. Estimating the general case would mean guessing
 * at a token split we cannot measure, which is the whole failure mode this
 * module exists to avoid.
 */

/** A prompt's shape, as far as prefix reuse is concerned. */
export interface PromptFingerprint {
  model: string;
  /** Tool schemas ride in `body.tools` and chat templates render them into the
   * very front of the prompt, so a changed toolset invalidates everything. */
  toolsHash: string;
  /** One hash per message, in order. */
  messageHashes: string[];
}

export interface PromptReuse {
  /**
   * Tokens of this prompt that were a token-identical prefix of the previous
   * request for the same conversation. Null only when there is no previous
   * request to compare against (a conversation's first turn, or the first
   * after a server restart — we deliberately claim nothing then, even though
   * a separately-hosted backend may well still hold the prefix).
   */
  tokens: number | null;
  /** Leading messages shared with the previous request. */
  sharedMessages: number;
  /** How many messages the previous request had. Equal to `sharedMessages`
   * when this prompt strictly extended it — the cacheable case. */
  previousMessages: number;
}

/** Exported for the tool loop's loop detector, which hashes tool calls for the
 * same reason and wants the same "same or not" guarantee. */
export function sha(input: string): string {
  // 16 hex chars: this only ever answers "same or not" for values we produced
  // ourselves, and a conversation holds at most ~75 of them.
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * `carried` lets a caller reuse hashes it already computed for the first N
 * messages, and exists for one reason: image turns carry their whole base64
 * data URI inline, so hashing every message on every tool iteration costs CPU
 * proportional to the entire attachment budget, repeatedly, on the single Node
 * thread. Measured at ~18 ms per 10 MB image per call, against a 32 MB image
 * budget and for as many iterations as a run's check-in window allows — a
 * diagnostic that could add seconds of synchronous work and hundreds of MB of
 * transient strings.
 *
 * **The caller must guarantee those first N messages are unchanged.** The tool
 * loop can: `chatMessages` is only ever appended to within a run. Anything that
 * rewrote an earlier message and passed its old hashes would silently report
 * reuse that isn't there — so this is an explicit parameter rather than an
 * internal cache that could be reached from somewhere with weaker guarantees.
 */
export function fingerprintPrompt(
  model: string,
  messages: ChatMessage[],
  tools: OpenAiTool[] | undefined,
  carried?: readonly string[],
): PromptFingerprint {
  return {
    model,
    toolsHash: sha(JSON.stringify(tools ?? [])),
    messageHashes: messages.map((m, i) => carried?.[i] ?? sha(JSON.stringify(m))),
  };
}

interface TraceEntry extends PromptFingerprint {
  /** The backend's measured `prompt_tokens` for this exact prompt. */
  promptTokens: number;
}

/**
 * Last request per conversation. In memory on purpose, and bounded: this is a
 * diagnostic, and losing it across a restart costs one turn reporting "no
 * previous request" rather than a wrong number.
 */
const traces = new Map<string, TraceEntry>();
/** Bounds the map for a long-lived server; conversations are the natural key
 * and there is no natural end-of-life event to hook. */
const MAX_TRACES = 500;

function commonPrefix(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** What the previous request for this conversation left available to reuse. */
export function measureReuse(conversationId: string, current: PromptFingerprint): PromptReuse {
  const previous = traces.get(conversationId);
  if (!previous) return { tokens: null, sharedMessages: 0, previousMessages: 0 };

  // A different model has its own cache and its own tokenizer; a changed
  // toolset changes the front of the prompt. Either way nothing carries over.
  if (previous.model !== current.model || previous.toolsHash !== current.toolsHash) {
    return { tokens: 0, sharedMessages: 0, previousMessages: previous.messageHashes.length };
  }

  const shared = commonPrefix(previous.messageHashes, current.messageHashes);
  const extended = shared === previous.messageHashes.length;
  return {
    // Only the strict-extension case has a measured number behind it.
    tokens: extended ? previous.promptTokens : 0,
    sharedMessages: shared,
    previousMessages: previous.messageHashes.length,
  };
}

/** Record what we actually sent, once the backend has told us its size. */
export function recordPrompt(
  conversationId: string,
  fingerprint: PromptFingerprint,
  promptTokens: number,
): void {
  // A backend that reported no usage leaves us nothing to anchor on; keeping
  // the older entry beats replacing it with a zero we would later hand out as
  // a reuse count.
  if (promptTokens <= 0) return;
  if (!traces.has(conversationId) && traces.size >= MAX_TRACES) {
    const oldest = traces.keys().next();
    if (!oldest.done) traces.delete(oldest.value);
  }
  // Re-insert so the key moves to the back of the Map's insertion order,
  // making the eviction above least-recently-used.
  traces.delete(conversationId);
  traces.set(conversationId, { ...fingerprint, promptTokens });
}

/** Test seam. */
export function resetPromptTraces(): void {
  traces.clear();
}
