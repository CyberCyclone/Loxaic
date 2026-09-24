import type { PromptProgress } from "@loxaic/types";
import { PLAN_REQUIRED_NUDGE, QUESTIONS_ANSWERED_PREFIX } from "@loxaic/types";
import { scenarioDecisionFor } from "./mock-scenarios.ts";
import { parsePromptProgress } from "./prompt-progress.ts";
import { redactSecrets } from "./provider-secrets.ts";
import { resolveModelRef, type ResolvedProvider } from "./providers.ts";
import { routerModelName } from "../llama/preset.ts";
import { routerEndpoint, routerUnavailableReason } from "../llama/router.ts";
import { listServableModels } from "../llama/catalog.ts";
import { inferenceFetch, inferenceNetworkError } from "./transport.ts";

// Read at call time, not module load — a supervisor sets these in the child's
// env, and module-scope reads would freeze them before any caller could act.
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
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** OpenAI's (and OpenRouter's) spelling of what llama.cpp reports as
     * `timings.cache_n`. Present only on providers that do report it. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
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
  /** The backend's own prompt-evaluation progress — only ever sent when
   * `reportProgress` asked for it, and only before the first output. */
  | { type: "progress"; progress: PromptProgress }
  | { type: "done"; result: CompletionResult };

export interface StreamOptions {
  tools?: OpenAiTool[];
  signal?: AbortSignal;
  /**
   * Whether the model may call a tool this request. Defaults to `"auto"`.
   *
   * `"none"` is what a check-in answered with "answer now" sends. The tools
   * stay in the request either way, deliberately: llama.cpp renders their
   * schemas into the prompt's system region, so dropping them would change the
   * prefix and cost a full re-evaluation of the whole conversation on the one
   * request that is supposed to wrap things up cheaply.
   *
   * `"required"` is what a planning turn that answered in prose is re-asked
   * with (#199): it must call a tool — in practice, propose_plan or
   * ask_questions. Sent on that one request only, so every other request is
   * unchanged. OpenAI, llama.cpp and vLLM honour it.
   */
  toolChoice?: "auto" | "none" | "required";
  /**
   * Ask the backend to report prompt-evaluation progress on the stream
   * (llama.cpp's `return_progress`). The caller decides, because only it knows
   * whether the backend identified itself as a local runtime: OpenAI answers
   * an unknown request field with a 400, so sending this to a hosted API — or
   * to a hand-entered provider pointed at one — would break every request.
   * Adds a request-body field, never a message, so the prompt is unchanged.
   */
  reportProgress?: boolean;
}

/**
 * `model` is a stored model *reference*, not necessarily the id the backend
 * knows: an added provider's models carry a `slug::` prefix, which is resolved
 * here into which backend to call and what to call the model when we get
 * there.
 *
 * Resolved per request rather than once per run, so deleting a provider to
 * stop it spending takes effect on a run already in flight.
 */
export async function* streamCompletion(
  model: string,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent, void, unknown> {
  const { provider, upstreamModel } = await resolveModelRef(model);
  // Mock mode stands in for the backend this deployment was configured with,
  // not for a provider an admin added: an added one has a real address and a
  // real key, so leaving it live is what lets the mock lane exercise the whole
  // provider path — auth header included — with nothing stubbed.
  // One exception: a downloaded, enabled local model with a router running to
  // serve it goes to that router, mock or not. Nothing else would ever send a
  // request to the router under the mock — which is what the e2e lane runs —
  // and the whole local-models path (the router's key, its streaming, the
  // settings it loaded the model with) would be exercised by no test at all.
  // Without a router the mock answers, as it always has.
  if (provider.isDefault && MOCK_MODE() && !(await servedByLocalRouter(upstreamModel))) {
    yield* mockStream(messages, options);
    return;
  }
  // No router right now (not installed yet, still starting, turned off): say
  // so, rather than letting the request fail as "connection refused" against
  // an address nobody configured.
  if (provider.isDefault && !routerEndpoint()) throw new Error(routerUnavailableReason());
  // The built-in backend is the router, which knows a model by its router name
  // rather than its id (see routerModelName). An added provider gets the id it
  // listed, untouched.
  yield* liveStream(provider, provider.isDefault ? routerModelName(upstreamModel) : upstreamModel, messages, options);
}

async function servedByLocalRouter(upstreamModel: string): Promise<boolean> {
  if (!routerEndpoint()) return false;
  return (await listServableModels()).some((r) => r.id === upstreamModel);
}

// ── Mock ──────────────────────────────────────────────────
// Mock mode has to be able to drive a *loop*, not just echo: when tools are
// offered and the prompt mentions one, it emits a real tool call; once a
// tool result comes back it wraps up with text. Otherwise the agent loop
// would be untestable without a GGUF.

/** Prompts asking the mock to take its time — see the delay in mockStream. */
/** The same failure a real backend's aborted fetch produces. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

const MOCK_SLOW_MATCH = /\btake your time\b/i;
/** Long enough for a second conversation to be started by hand or by a test
 * and observed waiting; short enough not to dominate a suite. */
const MOCK_SLOW_MS = 8_000;

/** A slow prompt that also reports progress the way llama.cpp does with
 * `return_progress`. A separate phrase from MOCK_SLOW_MATCH, so the specs that
 * use that one keep covering the estimate-only path every other backend has. */
const MOCK_PROGRESS_MATCH = /\breport your progress\b/i;
const MOCK_PROGRESS_TICK_MS = 1_000;
/** Big enough that the countdown is past MIN_EVALUATED_TOKENS on the first
 * tick, with a cached prefix so both bar segments render. */
const MOCK_PROGRESS = { total: 12_000, cache: 4_000 };

/** Resolves after `ms`, or at once on abort — callers follow it with
 * throwIfAborted. See the MOCK_SLOW_MATCH branch for why the mock's waits have
 * to be interruptible at all. */
function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A prompt the mock fails the way LM Studio fails a model it cannot load: an
 * HTTP 400 before any token, whose `error.message` liveStream throws as-is.
 * Without it a failed turn needs a real, broken backend, so whether its reason
 * reaches the user could not be tested on the mock lane at all. */
const MOCK_FAIL_MATCH = /\bfail to load the model\b/i;
const MOCK_FAIL_MESSAGE = 'Failed to load model "mock-model". Error: the mock backend was asked to fail this turn.';

/**
 * The mock's plan (#199), built from the prompt it answers so a revision is
 * visibly a different plan from the one it revises, and long enough — forty
 * lines — that the plan panel's body has to scroll on a short window, which is
 * what its reachability check needs.
 */
function mockPlan(prompt: string): string {
  const steps = Array.from({ length: 36 }, (_, i) => `${String(i + 1)}. Step ${String(i + 1)} of the mock plan.`);
  return ["## Mock plan", "", `Asked: ${prompt}`, "", ...steps].join("\n");
}

/**
 * The mock's questions (#199): two, the second multi-select, so the panel's
 * steps, both kinds of choice and "Other" are all exercised by one prompt.
 */
const MOCK_QUESTIONS = {
  questions: [
    {
      question: "Which part should the plan cover first?",
      header: "Scope",
      options: [
        { label: "The API", description: "Server routes and their tests" },
        { label: "The UI", description: "Screens and components" },
      ],
    },
    {
      question: "Which checks should the plan include?",
      header: "Checks",
      multiSelect: true,
      options: [{ label: "Unit tests" }, { label: "End-to-end tests" }, { label: "Manual QA" }],
    },
  ],
};

/** A planning prompt the mock answers in prose — the one way to drive the
 * server's "finish with a plan or questions" nudge (#199). */
const MOCK_PROSE_MATCH = /\banswer in prose\b/i;

const MOCK_TOOL_TRIGGERS: {
  match: RegExp;
  name: string;
  /** Fixed arguments, or arguments built from the prompt. */
  args: Record<string, unknown> | ((prompt: string) => Record<string, unknown>);
}[] = [
  // MCP entries first — a trigger only fires when the tool is actually in
  // options.tools, so these double as a wiring test of the MCP registry.
  { match: /\bmcp echo\b/i, name: "mockmcp__echo", args: { text: "hello from mcp" } },
  { match: /\bmcp slow\b/i, name: "mockmcp__slow", args: {} },
  { match: /\bmcp huge\b/i, name: "mockmcp__huge", args: {} },
  { match: /\bmcp evil\b/i, name: "mockmcp__evil", args: {} },
  { match: /\bmcp bad args\b/i, name: "mockmcp__echo", args: { wrong: 1 } },
  // The GitHub MCP server provisioned from a GitHub connection. `get_me` is
  // one of the tools that start allowed, so this one prompt shows both that
  // the default policy applied (no approval asked) and that the connection's
  // token reached the server.
  { match: /\bgithub who am i\b/i, name: "github__get_me", args: {} },
  // Planning mode's hand-off. Before the `plan` trigger below, which would
  // otherwise take the same prompt for todo_write; only planning mode offers
  // propose_plan, so everywhere else this falls through to that one. Neither
  // plan-decision message matches it.
  { match: /\bpropose (?:a|the) plan\b/i, name: "propose_plan", args: (prompt) => ({ plan: mockPlan(prompt) }) },
  // Questions instead of a plan — planning mode only offers the tool, so
  // this falls through everywhere else.
  { match: /\bask me\b|\bquestions?\b/i, name: "ask_questions", args: MOCK_QUESTIONS },
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
  // Before anything is yielded, as a refused request is: nothing streamed.
  if (MOCK_FAIL_MATCH.test(prompt)) throw new Error(MOCK_FAIL_MESSAGE);
  const imageCount = countImageParts(lastUser?.content);
  const documentCount = countDocumentParts(lastUser?.content);

  // A scenario step is looked up by how many tool calls this turn has already
  // made — not gated by alreadyRanTools, since a scenario's whole point is
  // running more than one tool in a turn — and takes priority over an
  // ordinary trigger when it fires.
  const toolStepIndex = currentTurn.filter((m) => m.role === "tool").length;
  // `tool_choice: "none"` is a real constraint, not a hint, so the mock has to
  // honour it or the one path that depends on it — a check-in answered with
  // "answer now" — would be untestable in the mock lane. It must be decided
  // *before* the scenario lookup: the nudge that turns tools off is itself a
  // user message, so `lastUserIndex` has already moved and `toolStepIndex` is
  // back at 0 — a scenario consulted here would cheerfully restart at step 1.
  const noTools = options.toolChoice === "none";
  const scenarioDecision = noTools ? null : scenarioDecisionFor(prompt, toolNames, toolStepIndex);

  // Planning mode ends every turn in a plan or questions (#199), whatever was
  // asked, the way a real model given the planning prompt does — a trigger
  // still runs first (a model looks around before it plans), and the turn
  // then ends in a plan rather than "[Mock] Done". The one exception is the
  // prose prompt, answered in prose until tool_choice says it may not be.
  const planning = toolNames.has("propose_plan");
  const planningFinish = (): { name: string; args: Record<string, unknown> }[] => {
    if (!planning) return [];
    if (options.toolChoice !== "required" && MOCK_PROSE_MATCH.test(prompt)) return [];
    // After the nudge the prompt is the nudge itself; plan from what was
    // actually asked, the user message before it.
    const asked =
      prompt === PLAN_REQUIRED_NUDGE
        ? textOfContent(messages.slice(0, lastUserIndex).filter((m) => m.role === "user").at(-1)?.content)
        : prompt;
    return [{ name: "propose_plan", args: { plan: mockPlan(asked) } }];
  };

  // A list, because a scenario step may carry several calls for one assistant
  // message — what a real model does routinely, and what the tool loop's
  // per-call abort check needs in order to be testable at all (#113).
  const triggered: { name: string; args: Record<string, unknown> }[] = noTools
    ? []
    : scenarioDecision?.type === "step"
      ? scenarioDecision.calls.map((c) => ({ name: c.tool, args: c.args }))
      : alreadyRanTools
        ? planningFinish()
        : (() => {
            if (planning && MOCK_PROSE_MATCH.test(prompt) && options.toolChoice !== "required") return [];
            // The nudge's own words ("your plan") would match the todo trigger;
            // it is asking for the plan, so that is what it gets.
            if (planning && prompt === PLAN_REQUIRED_NUDGE) return planningFinish();
            // Answers are what the plan was waiting for, and they mention
            // "questions" — which would otherwise ask the same ones again.
            if (planning && prompt.startsWith(QUESTIONS_ANSWERED_PREFIX)) return planningFinish();
            const t = MOCK_TOOL_TRIGGERS.find((x) => toolNames.has(x.name) && x.match.test(prompt));
            return t ? [{ name: t.name, args: typeof t.args === "function" ? t.args(prompt) : t.args }] : planningFinish();
          })();

  // A prompt that takes long enough to still be running when the next one
  // arrives. The run queue is only observable when two runs overlap, and every
  // other mock response finishes in milliseconds — so without a way to ask for
  // a slow one, the only way to test the queue would be to race the harness
  // against itself. Keyed on the prompt rather than an environment variable so
  // it affects exactly the conversation that asked, leaving every other spec's
  // timing alone. See MOCK_TOOL_TRIGGERS above for the same idiom.
  if (MOCK_PROGRESS_MATCH.test(prompt)) {
    // llama.cpp's `return_progress`, played out over the same eight seconds
    // as the slow prompt: a 0% report as the slot starts, then one a second.
    // Only when asked, as the real backend only sends it when asked — so the
    // engine's gate is exercised end to end, not assumed.
    const steps = MOCK_SLOW_MS / MOCK_PROGRESS_TICK_MS;
    for (let i = 0; i <= steps; i++) {
      if (i > 0) await sleepUnlessAborted(MOCK_PROGRESS_TICK_MS, options.signal);
      throwIfAborted(options.signal);
      if (!options.reportProgress) continue;
      const progress = parsePromptProgress({
        total: MOCK_PROGRESS.total,
        cache: MOCK_PROGRESS.cache,
        processed: MOCK_PROGRESS.cache + Math.round(((MOCK_PROGRESS.total - MOCK_PROGRESS.cache) * i) / steps),
        time_ms: i * MOCK_PROGRESS_TICK_MS,
      });
      if (progress) yield { type: "progress", progress };
    }
  } else if (MOCK_SLOW_MATCH.test(prompt)) {
    // Interruptible, because a real backend's fetch is: `signal` aborts the
    // live HTTP request in liveStream, so a mock that slept through a stop
    // would make the mock lane the *only* place where stopping mid-response
    // does nothing — precisely the bug being tested (#113).
    await sleepUnlessAborted(MOCK_SLOW_MS, options.signal);
    // Cut short is not the same as stopped. `liveStream`'s fetch throws
    // AbortError, which is what puts the engine on its cancel path; a mock
    // that merely woke early and then streamed its whole reply ended the
    // turn as *complete* — the user got the entire answer they asked to stop,
    // and the mock lane could not observe mid-response cancellation at all.
    throwIfAborted(options.signal);
  }

  let ttftMs: number | null = null;
  const emit = async function* (text: string): AsyncGenerator<StreamEvent> {
    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      throwIfAborted(options.signal);
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
  } else if (noTools) {
    // Distinct wording so a spec can tell "the model wrapped up because it was
    // told to" from the generic post-tool summary below, which it would
    // otherwise be indistinguishable from.
    const lastTool = [...currentTurn].reverse().find((m) => m.role === "tool");
    fullText = `[Mock] Answering now without tools.${lastTool ? ` Last tool said: ${lastTool.content.slice(0, 200)}` : ""}`;
    yield* emit(fullText);
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
    /** OpenRouter's name for `reasoning_content`. */
    reasoning?: string | null;
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
  /** llama.cpp with `return_progress`; validated by parsePromptProgress. */
  prompt_progress?: unknown;
}

/**
 * Everything a provider could echo back in an error.
 *
 * Whatever this function throws is persisted on the assistant's message row
 * and re-served to everyone on the conversation, shared viewers included —
 * and a rejected request routinely quotes the credential it rejected
 * ("Incorrect API key provided: sk-…abcd"). So an upstream message is scrubbed
 * before it becomes an Error, not after.
 */
function secretsOf(provider: ResolvedProvider): (string | null)[] {
  return [provider.apiKey, ...Object.values(provider.headers)];
}

async function* liveStream(
  provider: ResolvedProvider,
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
    body.tool_choice = options.toolChoice ?? "auto";
  }
  // The preset check is a second lock behind the caller's: a named hosted API
  // never gets a field it would refuse, whatever the caller believed.
  if (options.reportProgress && provider.preset === null) body.return_progress = true;

  // Not the global fetch: see transport.ts for the 300-second cut-off it has.
  const response = await inferenceFetch(`${provider.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...provider.headers,
      // Last, so a custom header can never displace it — the write path
      // refuses `authorization` too, and one of the two has to be the rule
      // rather than both being a convention.
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: options.signal,
    // A redirect would carry the Authorization header to wherever it points.
    redirect: "error",
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
    // A rejected credential is the admin's problem, not the user's, and the
    // upstream wording ("Incorrect API key provided", "No auth credentials
    // found") tells whoever is reading the transcript nothing they can act on.
    // Replaced rather than appended to, so no part of the vendor's own text —
    // which may quote the key — reaches the conversation.
    if (!provider.isDefault && (response.status === 401 || response.status === 403)) {
      throw new Error(
        `The "${provider.name}" provider rejected this server's API key. Ask an admin to check it in Settings → Model providers.`,
      );
    }
    throw new Error(
      redactSecrets(message || `Inference error ${String(response.status)}`, secretsOf(provider)),
    );
  }

  if (!response.body) throw new Error("Inference response has no body");

  // undici types its body chunks as `any`; they are bytes.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage: CompletionResult["usage"] | null = null;
  let lastTimings: LlamaTimings | null = null;
  let finishReason: string | null = null;
  const fragments = new Map<number, ToolCallFragment>();

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        // A connection lost mid-reply surfaces here, as undici's "terminated".
        throw inferenceNetworkError(err, options.signal);
      }
      const { done, value } = chunk;
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
          throw new Error(redactSecrets(`Inference backend error: ${detail}`, secretsOf(provider)));
        }

        // Before anything else in the chunk, and deliberately not touching
        // ttftMs: a progress chunk also carries an empty assistant delta
        // (`content: null`), which is not output. Only reported until output
        // starts — llama.cpp's last one can ride on the first token's chunk,
        // and "evaluating" after the answer has begun would be false.
        if (parsed.prompt_progress !== undefined && ttftMs === null) {
          const progress = parsePromptProgress(parsed.prompt_progress);
          if (progress) yield { type: "progress", progress };
        }

        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;

        // Reasoning models (and llama.cpp with a reasoning template) stream
        // chain-of-thought separately from the answer.
        const delta = choice?.delta;
        // `reasoning_content` is llama.cpp's and LM Studio's spelling;
        // OpenRouter uses `reasoning` for the same thing. Neither backend
        // sends both, so taking whichever is present costs nothing.
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
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
    // Cancel, not just release. Any early exit — a mid-stream SSE error, a
    // throw in the consumer's loop — otherwise leaves the request in flight:
    // undici pauses the socket on backpressure, a read-from stream is not
    // cancelled when it is garbage collected, and the only timeout left is
    // the hour-long ceiling. The backend would keep generating for nobody.
    // Cancelling a body that already finished is a no-op.
    await reader.cancel().catch(() => undefined);
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
      // llama.cpp's figure first, then the OpenAI-shaped one a hosted provider
      // reports. Still null — never 0 — when neither is present: "the backend
      // does not report this" is a different fact from "nothing was cached",
      // and storing the second for the first is what pinned the stats screen
      // at a permanent 0% hit rate.
      cachedTokens: lastTimings?.cache_n ?? usage.prompt_tokens_details?.cached_tokens ?? null,
      promptTps,
      genTps,
    },
  };
}
