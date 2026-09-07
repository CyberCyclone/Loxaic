import { scenarioDecisionFor } from "./mock-scenarios.ts";

// Read at call time, not module load — a supervisor sets these in the child's
// env, and module-scope reads would freeze them before any caller could act.
const BASE_URL = () => process.env.INFERENCE_BASE_URL ?? "http://localhost:4002";
const MOCK_MODE = () => process.env.MOCK_INFERENCE === "true";

/** An OpenAI-shaped tool call. `arguments` is a JSON *string*, per the spec. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI-style content part. Images are sent as data URIs — llama.cpp
 * (with --mmproj) and LM Studio both accept them on /v1/chat/completions. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

/** The text of a message whose content may be a part array. Image parts
 * contribute nothing — callers that need to know images exist count them
 * separately. */
export function textOfContent(content: string | ContentPart[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** How many `<attached-file>` wrappers a user turn carries. Counts the real
 * provenance marker prompt assembly emits, so a positive count is proof the
 * document actually reached the prompt — not merely that one was uploaded. */
export function countDocumentParts(content: string | ContentPart[] | null | undefined): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (p) => p.type === "text" && p.text.includes("<attached-file name="),
  ).length;
}

export function countImageParts(content: string | ContentPart[] | null | undefined): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => p.type === "image_url").length;
}

/**
 * Maps a backend's rejection of image input to a friendly, actionable message.
 * llama.cpp without --mmprj and text-only LM Studio models both name the
 * problem in their error text. Returns null when the error doesn't look
 * image-related — callers only consult this when the prompt carried images.
 */
export function visionErrorMessage(raw: string): string | null {
  if (!/image|multimodal|mmproj|vision|mtmd/i.test(raw)) return null;
  return "This model can't see images. Your message and image were saved — switch to a vision model (one loaded with --mmproj) and ask again.";
}

/** JSON-Schema tool definition sent to the model. */
export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlamaTimings {
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
  cache_n?: number;
  total_ms?: number;
}

export interface CompletionResult {
  text: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** Time to first token (ms), measured server-side. Null if nothing streamed. */
  ttftMs: number | null;
  /** Total wall-clock duration (ms) of the inference call — model load (if any), prompt eval, and generation. */
  totalMs: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  timings: LlamaTimings | null;
  /**
   * Tokens the backend reported reusing from its KV cache. **Null means the
   * backend does not report it**, which is a different fact from zero — and
   * conflating the two is what pinned the stats screen at a 0% cache-hit
   * rate. llama.cpp reports `timings.cache_n`; LM Studio reports nothing
   * about caching on any endpoint (no cache field in `usage`, no `/slots`,
   * no `/props`, and its `stats` block carries only TTFT and generation
   * rate). `reusableTokens`, computed in `inference/prompt-reuse.ts`, is what
   * fills that gap.
   */
  cachedTokens: number | null;
  /**
   * Prompt-evaluation rate, over the tokens that were actually *evaluated*.
   *
   * Null unless the backend says how many that was. This used to fall back to
   * `prompt_tokens / ttft`, which is not a rate of anything once a cache hit
   * is involved: a fully-cached 30k-token prompt returns its first token in
   * ~400 ms, and the fallback duly reported 47,742 tok/s as "Prompt speed".
   * The honest presentation without `timings` is the prompt size and the
   * wall-clock time it took, which is what the client now shows.
   */
  promptTps: number | null;
  /** Generation rate. Safe to derive from the wall clock — every completion
   * token really was produced in the measured window. */
  genTps: number | null;
}

export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "thinking"; content: string }
  | { type: "done"; result: CompletionResult };

export interface StreamOptions {
  tools?: OpenAiTool[];
  signal?: AbortSignal;
}

export async function* streamCompletion(
  model: string,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  if (MOCK_MODE()) {
    yield* mockStream(messages, options);
    return;
  }
  yield* liveStream(model, messages, options);
}

// ── Mock ──────────────────────────────────────────────────
// Mock mode has to be able to drive a *loop*, not just echo: when tools are
// offered and the prompt mentions one, it emits a real tool call; once a
// tool result comes back it wraps up with text. Otherwise the agent loop
// would be untestable without a GGUF.

/** Prompts asking the mock to take its time — see the delay in mockStream. */
const MOCK_SLOW_MATCH = /\btake your time\b/i;
/** Long enough for a second conversation to be started by hand or by a test
 * and observed waiting; short enough not to dominate a suite. */
const MOCK_SLOW_MS = 8_000;

const MOCK_TOOL_TRIGGERS: { match: RegExp; name: string; args: Record<string, unknown> }[] = [
  // MCP entries first — a trigger only fires when the tool is actually in
  // options.tools, so these double as a wiring test of the MCP registry.
  { match: /\bmcp echo\b/i, name: "mockmcp__echo", args: { text: "hello from mcp" } },
  { match: /\bmcp slow\b/i, name: "mockmcp__slow", args: {} },
  { match: /\bmcp huge\b/i, name: "mockmcp__huge", args: {} },
  { match: /\bmcp evil\b/i, name: "mockmcp__evil", args: {} },
  { match: /\bmcp bad args\b/i, name: "mockmcp__echo", args: { wrong: 1 } },
  { match: /\bbash\b|\bshell\b|\bcommand\b/i, name: "bash", args: { command: "echo hello from the sandbox" } },
  // Object keys deliberately NOT in an order Postgres jsonb preserves: it
  // re-sorts by key length then bytes, so these come back as id/text/status.
  // A real model emits keys in whatever order it likes, and a mock that
  // happened to match jsonb's ordering is why a prompt-prefix bug — the replay
  // re-serialising tool arguments into different bytes than the live loop sent
  // — stayed invisible to every test we had.
  { match: /\btodo|\bplan\b/i, name: "todo_write", args: { todos: [
    { status: "completed", id: "1", text: "Investigate the request" },
    { status: "in_progress", id: "2", text: "Apply the change" },
    { status: "pending", id: "3", text: "Verify" },
  ] } },
  { match: /\bfetch\b|\bhttps?:\/\//i, name: "web_fetch", args: { url: "https://example.com" } },
  { match: /\bwrite\b|\bcreate a file\b/i, name: "fs_write", args: { path: "notes.txt", content: "written by the mock agent\n" } },
  { match: /\bedit\b|\breplace\b/i, name: "fs_edit", args: { path: "notes.txt", oldText: "mock", newText: "MOCK" } },
  { match: /\bgrep\b|\bsearch\b/i, name: "grep", args: { pattern: "TODO" } },
  { match: /\blist files\b|\bglob\b|\bfiles\b/i, name: "glob", args: { pattern: "**/*" } },
  { match: /\bread\b|\bcat\b/i, name: "fs_read", args: { path: "notes.txt" } },
];

async function* mockStream(
  messages: ChatMessage[],
  options: StreamOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  const startTime = Date.now();
  const toolNames = new Set((options.tools ?? []).map((t) => t.function.name));
  // Only the *current* turn counts: earlier turns in the conversation have
  // their own tool messages, and treating those as "already ran" would make
  // the mock refuse to call a tool ever again in a long-lived conversation.
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  const currentTurn = messages.slice(lastUserIndex + 1);
  const alreadyRanTools = currentTurn.some((m) => m.role === "tool");
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const prompt = textOfContent(lastUser?.content);
  const imageCount = countImageParts(lastUser?.content);
  const documentCount = countDocumentParts(lastUser?.content);

  // A scenario step is looked up by how many tool calls this turn has already
  // made — not gated by alreadyRanTools, since a scenario's whole point is
  // running more than one tool in a turn — and takes priority over an
  // ordinary trigger when it fires.
  const toolStepIndex = currentTurn.filter((m) => m.role === "tool").length;
  const scenarioDecision = scenarioDecisionFor(prompt, toolNames, toolStepIndex);

  // A list, because a scenario step may carry several calls for one assistant
  // message — what a real model does routinely, and what the tool loop's
  // per-call abort check needs in order to be testable at all (#113).
  const triggered: { name: string; args: Record<string, unknown> }[] =
    scenarioDecision?.type === "step"
      ? scenarioDecision.calls.map((c) => ({ name: c.tool, args: c.args }))
      : alreadyRanTools
        ? []
        : (() => {
            const t = MOCK_TOOL_TRIGGERS.find((x) => toolNames.has(x.name) && x.match.test(prompt));
            return t ? [{ name: t.name, args: t.args }] : [];
          })();

  // A prompt that takes long enough to still be running when the next one
  // arrives. The run queue is only observable when two runs overlap, and every
  // other mock response finishes in milliseconds — so without a way to ask for
  // a slow one, the only way to test the queue would be to race the harness
  // against itself. Keyed on the prompt rather than an environment variable so
  // it affects exactly the conversation that asked, leaving every other spec's
  // timing alone. See MOCK_TOOL_TRIGGERS above for the same idiom.
  if (MOCK_SLOW_MATCH.test(prompt)) {
    // Interruptible, because a real backend's fetch is: `signal` aborts the
    // live HTTP request in liveStream, so a mock that slept through a stop
    // would make the mock lane the *only* place where stopping mid-response
    // does nothing — precisely the bug being tested (#113).
    await new Promise<void>((resolve) => {
      const signal = options.signal;
      if (signal?.aborted) { resolve(); return; }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, MOCK_SLOW_MS);
      function onAbort() {
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  let ttftMs: number | null = null;
  const emit = async function* (text: string): AsyncGenerator<StreamEvent> {
    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      ttftMs ??= Date.now() - startTime;
      yield { type: "delta" as const, content: (i === 0 ? "" : " ") + words[i] };
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  let fullText = "";
  const toolCalls: ToolCall[] = [];

  if (triggered.length > 0) {
    // Trailing newline on purpose. Real models routinely end their text with
    // one before a tool call, the history loader trims it on replay, and the
    // live loop did not — so the two disagreed at that message and broke the
    // prompt prefix. A mock that emitted perfectly trimmed text could never
    // show that.
    const preamble = `[Mock] I'll use the ${triggered.map((t) => t.name).join(", ")} tool.\n`;
    fullText = preamble;
    yield* emit(preamble);
    ttftMs ??= Date.now() - startTime;
    for (const [i, t] of triggered.entries()) {
      toolCalls.push({
        // Distinct per call: ids collide otherwise when a batch is emitted
        // inside one millisecond, and the loop keys results by call id.
        id: `mock_call_${Date.now().toString(36)}_${String(i)}`,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      });
    }
  } else if (scenarioDecision?.type === "final") {
    // A finished scenario's own wrap-up text, in place of the generic one —
    // it can describe what the steps actually did (e.g. name the bug fixed).
    fullText = scenarioDecision.text;
    yield* emit(fullText);
  } else {
    const lastTool = [...currentTurn].reverse().find((m) => m.role === "tool");
    // Acknowledging attachment parts explicitly makes the full pipeline
    // provable end-to-end without a vision GGUF — and, for documents, without
    // a real model that could only be taken at its word. The mock counts what
    // is actually in the assembled prompt, so these notes are evidence that
    // upload → ownership → blocks → history loader → content parts all held.
    const imageNote = imageCount > 0 ? `Received ${String(imageCount)} image(s). ` : "";
    const documentNote = documentCount > 0 ? `Received ${String(documentCount)} document(s). ` : "";
    fullText = lastTool
      ? `[Mock] Done. The tool returned: ${lastTool.content.slice(0, 200)}`
      : `[Mock] ${imageNote}${documentNote}Echo: ${prompt || "Hello"}`;
    yield* emit(fullText);
  }

  const completionTokens = fullText.split(" ").length;
  yield {
    type: "done",
    result: {
      text: fullText,
      content: fullText,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      ttftMs,
      totalMs: Date.now() - startTime,
      usage: { prompt_tokens: 10, completion_tokens: completionTokens, total_tokens: 10 + completionTokens },
      timings: {
        prompt_n: 10,
        prompt_ms: 50,
        prompt_per_token_ms: 5,
        prompt_per_second: 200,
        predicted_n: completionTokens,
        predicted_ms: 150,
        predicted_per_token_ms: 15,
        predicted_per_second: 66,
        cache_n: 3,
        total_ms: Date.now() - startTime,
      },
      cachedTokens: 3,
      promptTps: 200,
      genTps: 66,
    },
  };
}

// ── Live (llama.cpp / any OpenAI-compatible server) ───────

/** Accumulator for streamed tool-call fragments, keyed by choice index. */
interface ToolCallFragment { id: string; name: string; args: string }

interface InferenceErrorResponse {
  error?: { message?: string };
}

/** A tool-call fragment as it arrives in a streamed `delta` — accumulated across chunks by index. */
interface StreamChunkToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Some backends send one complete, non-streamed tool call instead of fragments. */
interface StreamChunkCompleteToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface StreamChunkChoice {
  finish_reason?: string | null;
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: StreamChunkToolCallDelta[];
  };
  message?: {
    content?: string | null;
    tool_calls?: StreamChunkCompleteToolCall[];
  };
}

interface StreamChunk {
  choices?: StreamChunkChoice[];
  usage?: CompletionResult["usage"];
  timings?: LlamaTimings;
  /** Backends report a mid-stream failure as an SSE error payload carrying a
   * 200 status (llama.cpp/LM Studio: `event: error` + {"error": …}) — shape
   * varies, so both the bare-string and object forms are accepted. */
  error?: string | { message?: string };
}

async function* liveStream(
  model: string,
  messages: ChatMessage[],
  options: StreamOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  const startTime = Date.now();
  let ttftMs: number | null = null;
  let fullText = "";

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // llama.cpp only exposes native tool calling when started with --jinja;
  // without tools we send no tool fields at all so plain chat is unaffected.
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(`${BASE_URL()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    // OpenAI-compatible backends (LM Studio, llama.cpp) wrap the real reason in
    // {"error":{"message":"..."}} — surface just that instead of the raw body,
    // so the client can show it directly rather than a JSON dump.
    let message = errText;
    try {
      const parsed = JSON.parse(errText) as InferenceErrorResponse;
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty (but present) message should still fall back to errText; ?? would keep the empty string instead.
      message = parsed.error?.message || errText;
    } catch {
      // Not JSON — use the raw text as-is.
    }
    throw new Error(message || `Inference error ${String(response.status)}`);
  }

  if (!response.body) throw new Error("Inference response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage: CompletionResult["usage"] | null = null;
  let lastTimings: LlamaTimings | null = null;
  let finishReason: string | null = null;
  const fragments = new Map<number, ToolCallFragment>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === "[DONE]") continue;

        let parsed: StreamChunk;
        try {
          parsed = JSON.parse(jsonStr) as StreamChunk;
        } catch {
          continue; // partial or non-JSON keepalive
        }

        // Backends report failures mid-stream as an SSE error payload with a
        // 200 status (llama.cpp/LM Studio: `event: error` + {"error": …}).
        // Swallowing it would end the turn as a silent empty message.
        if (parsed.error) {
          const detail =
            typeof parsed.error === "string" ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error));
          throw new Error(`Inference backend error: ${detail}`);
        }

        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        // Reasoning models (and llama.cpp with a reasoning template) stream
        // chain-of-thought separately from the answer.
        const delta = choice?.delta;
        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          ttftMs ??= Date.now() - startTime;
          yield { type: "thinking", content: reasoning };
        }

        if (delta?.content) {
          ttftMs ??= Date.now() - startTime;
          fullText += delta.content;
          yield { type: "delta", content: delta.content };
        }

        // Tool calls arrive as fragments: the id and name land on the first
        // chunk for an index, the JSON arguments dribble in across many.
        if (Array.isArray(delta?.tool_calls)) {
          ttftMs ??= Date.now() - startTime;
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const cur = fragments.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
            fragments.set(idx, cur);
          }
        }

        // Some builds send a complete, non-streamed message instead.
        const message = choice?.message;
        if (Array.isArray(message?.tool_calls)) {
          message.tool_calls.forEach((tc, i) => {
            fragments.set(i, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              args: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments ?? {}),
            });
          });
        }
        if (typeof message?.content === "string" && message.content && !fullText) {
          fullText = message.content;
          yield { type: "delta", content: message.content };
        }

        if (parsed.usage) lastUsage = parsed.usage;
        if (parsed.timings) lastTimings = parsed.timings;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const totalMs = Date.now() - startTime;
  if (lastTimings) lastTimings.total_ms = totalMs;

  const toolCalls: ToolCall[] = [...fragments.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, f]) => f.name)
    .map(([idx, f]) => ({
      id: f.id || `call_${String(idx)}_${Date.now().toString(36)}`,
      type: "function" as const,
      function: { name: f.name, arguments: f.args || "{}" },
    }));

  const usage = lastUsage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // Prompt eval finishes right when the first token (reasoning or content)
  // comes back, so ttftMs is a reasonable stand-in for prompt-eval duration;
  // whatever's left of the total is generation.
  const genMs = ttftMs !== null ? totalMs - ttftMs : null;
  // No wall-clock fallback: see CompletionResult.promptTps.
  const promptTps = lastTimings?.prompt_per_second ?? null;
  const genTps =
    lastTimings?.predicted_per_second ??
    (genMs && genMs > 0 && usage.completion_tokens > 0 ? (usage.completion_tokens / genMs) * 1000 : null);

  yield {
    type: "done",
    result: {
      text: fullText,
      content: fullText,
      toolCalls,
      finishReason: finishReason ?? (toolCalls.length ? "tool_calls" : null),
      ttftMs,
      totalMs,
      usage,
      timings: lastTimings,
      cachedTokens: lastTimings?.cache_n ?? null,
      promptTps,
      genTps,
    },
  };
}
