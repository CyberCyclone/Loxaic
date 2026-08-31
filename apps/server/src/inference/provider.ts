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
   * Tokens/sec for prompt eval and generation. Uses `timings` when the
   * backend reports it natively (llama.cpp); otherwise LM Studio gives us no
   * such field over its streaming API at all, so this is derived from
   * wall-clock TTFT and total duration against the token counts instead.
   */
  promptTps: number | null;
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

const MOCK_TOOL_TRIGGERS: { match: RegExp; name: string; args: Record<string, unknown> }[] = [
  // MCP entries first — a trigger only fires when the tool is actually in
  // options.tools, so these double as a wiring test of the MCP registry.
  { match: /\bmcp echo\b/i, name: "mockmcp__echo", args: { text: "hello from mcp" } },
  { match: /\bmcp slow\b/i, name: "mockmcp__slow", args: {} },
  { match: /\bmcp huge\b/i, name: "mockmcp__huge", args: {} },
  { match: /\bmcp evil\b/i, name: "mockmcp__evil", args: {} },
  { match: /\bmcp bad args\b/i, name: "mockmcp__echo", args: { wrong: 1 } },
  { match: /\bbash\b|\bshell\b|\bcommand\b/i, name: "bash", args: { command: "echo hello from the sandbox" } },
  { match: /\btodo|\bplan\b/i, name: "todo_write", args: { todos: [
    { id: "1", text: "Investigate the request", status: "completed" },
    { id: "2", text: "Apply the change", status: "in_progress" },
    { id: "3", text: "Verify", status: "pending" },
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

  const trigger = alreadyRanTools
    ? undefined
    : MOCK_TOOL_TRIGGERS.find((t) => toolNames.has(t.name) && t.match.test(prompt));

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

  if (trigger) {
    const preamble = `[Mock] I'll use the ${trigger.name} tool.`;
    fullText = preamble;
    yield* emit(preamble);
    ttftMs ??= Date.now() - startTime;
    toolCalls.push({
      id: `mock_call_${Date.now().toString(36)}`,
      type: "function",
      function: { name: trigger.name, arguments: JSON.stringify(trigger.args) },
    });
  } else {
    const lastTool = [...currentTurn].reverse().find((m) => m.role === "tool");
    // Acknowledging image parts explicitly makes the full attachment pipeline
    // provable end-to-end without a vision GGUF.
    const imageNote = imageCount > 0 ? `Received ${String(imageCount)} image(s). ` : "";
    fullText = lastTool
      ? `[Mock] Done. The tool returned: ${lastTool.content.slice(0, 200)}`
      : `[Mock] ${imageNote}Echo: ${prompt || "Hello"}`;
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
  const promptTps =
    lastTimings?.prompt_per_second ??
    (ttftMs && ttftMs > 0 && usage.prompt_tokens > 0 ? (usage.prompt_tokens / ttftMs) * 1000 : null);
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
      promptTps,
      genTps,
    },
  };
}
