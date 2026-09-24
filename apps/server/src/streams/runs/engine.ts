import { v4 as uuid } from "uuid";
import { and, count, db, eq, gt } from "@loxaic/db";
import { conversations, messages, usageRecords, userPrefs } from "@loxaic/db/schema";
import {
  CHECKIN_ANSWER_NUDGE,
  PLAN_REQUIRED_NUDGE,
  DEFAULT_CHECKIN_AUTO_CONTINUES,
  DEFAULT_LOOP_SENSITIVITY,
  DEFAULT_PROVIDER_ID,
  type PromptProgress,
  type PromptStats,
  type StreamEventKind,
  isLoopSensitivity,
  sanitizeFilename,
  type AttachmentRef,
  type CheckinReason,
  type ContentBlock,
  type ContextBreakdown,
  type LoopSensitivity,
  type StepsDecision,
  type TimeoutBasis,
  type TurnUsage,
} from "@loxaic/types";
import {
  countDocumentParts,
  countImageParts,
  streamCompletion,
  visionErrorMessage,
  type ChatMessage,
  type ToolCall,
  type CompletionResult,
} from "../../inference/provider.ts";
import {
  attachmentContentParts,
  DOCUMENT_SYSTEM_ADDENDUM,
  selectAffordableAttachments,
} from "../../files/storage.ts";
import { invalidateBackendModels, modelRunInfo, resolveWindow } from "../../inference/models.ts";
import { resolveModelRef } from "../../inference/providers.ts";
import { addChars, apportion, estimateTallyTokens, summaryMessage, tallyChatMessages, type ContextTally } from "../../inference/context.ts";
import { prefillRate, recordPrefill } from "../../inference/prefill-rate.ts";
import { fingerprintPrompt, measureReuse, recordPrompt, sha, type PromptReuse } from "../../inference/prompt-reuse.ts";
import type { PermissionMode, ToolName } from "@loxaic/agent";
import { HANDOVER_TOOL_NAMES } from "@loxaic/agent";
import { executeTool, toolNeedsSandbox, type ToolResult } from "../../agent/executor.ts";
import {
  attachActiveSandbox,
  getConversationSandbox,
  hasActiveSandbox,
  hasOverflowWrite,
  markOverflowWritten,
} from "../../agent/sandbox-manager.ts";
import { buildToolset, type Toolset } from "../../mcp/registry.ts";
import { describeGithubPermissionFailure } from "../../github/permissions.ts";
import { shouldAutoCompact, userAllowsAutoCompact } from "./auto-compact.ts";
import type { StreamProducer } from "../broker.ts";
import { getRun, unregisterRun } from "../registry.ts";
import { acquireRunSlot, RunSlotAbortedError, type RunSlot } from "../../inference/scheduler.ts";
import { markBackendErrors, turnErrorText } from "../error-text.ts";
import { LoopDetector, loopDetectorOptions } from "./loop-detector.ts";
import {
  clampAutoContinues,
  clampWaitTimeoutMs,
  effectiveTimeoutMs,
  serverDefaultTimeoutMs,
  unattendedDecision,
} from "./timeouts.ts";

/**
 * Tool round-trips one user message may take **between check-ins**, when the
 * user has expressed no preference.
 *
 * This is a cadence, not a ceiling. It used to be one: the loop stopped dead
 * at 20 and ended the stream with an error nothing on the client rendered, so
 * a run that was working perfectly well simply went red with no reason given
 * (#157). Twenty is also far too few — a planning run reading its way around a
 * repository spends that in a couple of minutes on a local model, and being
 * cut off there is not a safety property, just an interruption.
 *
 * So the loop now pauses at the window's edge and *asks*, handing its
 * inference slot back exactly as a tool approval does. 100 is roughly a
 * quarter of an hour of real tool work — long enough that an ordinary task
 * never sees it, short enough that a genuinely confused model does not run
 * unattended all afternoon. Loop detection asks sooner when the run is
 * repeating itself, which is the case the old ceiling was really standing in
 * for.
 */
export const DEFAULT_MAX_ITERATIONS = 100;
export const MIN_MAX_ITERATIONS = 1;
export const MAX_MAX_ITERATIONS = 500;
// What an unanswered wait does, and how long it lasts, live in timeouts.ts —
// the check-in ladder and the adaptive window are pure functions there, and
// the per-user choices come from `loadRunPrefs` below.
/**
 * The smallest number of prior messages the replay window is ever narrowed
 * to. It is a floor, not a fixed size — see `historyAnchor`.
 */
export const HISTORY_LIMIT = 50;

/**
 * How far the window's oldest edge jumps when it finally has to move.
 *
 * A window of exactly HISTORY_LIMIT messages that slides by one on every turn
 * destroys the backend's prompt cache: the prompt no longer *starts* with the
 * same tokens, so llama.cpp/LM Studio re-evaluate the entire history from
 * scratch, every single turn, for the life of the conversation. Measured on a
 * 14.5k-token thread against a local LM Studio: 312 ms when the window held
 * still versus 14,551 ms the turn one message fell off the front — a 45×
 * difference that grows with the conversation.
 *
 * So the window is allowed to *grow* from HISTORY_LIMIT up to
 * HISTORY_LIMIT + HISTORY_STEP - 1 messages, and only re-anchors — paying one
 * full prompt evaluation — once every HISTORY_STEP messages. Every turn in
 * between extends a prefix the backend already has cached.
 */
export const HISTORY_STEP = 25;

/**
 * The oldest message this turn replays, as an offset from the oldest message
 * available (0 = replay everything). Quantised to HISTORY_STEP so it is a
 * *stable* function of the conversation's length rather than a value that
 * drifts by one per message: it holds still for HISTORY_STEP messages at a
 * time, which is what keeps the prompt prefix — and so the backend's KV cache
 * — intact across turns.
 *
 * Exported for the tests that pin the quantisation; `loadHistory` is the only
 * caller.
 */
export function historyAnchor(total: number): number {
  if (total <= HISTORY_LIMIT) return 0;
  return Math.max(0, Math.floor((total - HISTORY_LIMIT) / HISTORY_STEP) * HISTORY_STEP);
}

/**
 * The next lamport value a run's own messages should take, given the last one
 * it used. `Date.now()` alone collides whenever two of a run's inserts land in
 * the same millisecond — a real occurrence for an iteration whose tool call
 * does no genuine work (todo_write, or a mock scenario step) — and a tied
 * lamport is a coin flip in `loadHistory`'s `ORDER BY lamport, createdAt`,
 * which is a prompt-prefix break the moment it lands the wrong way. Exported
 * for the unit test; `runToolLoop` holds the running `previous` value itself.
 */
export function monotonicLamport(previous: number, now: number = Date.now()): number {
  return Math.max(now, previous + 1);
}

/**
 * The wire shapes for a tool exchange — built here and nowhere else.
 *
 * The live loop appends these to `chatMessages` as a run proceeds; `loadHistory`
 * rebuilds them from stored blocks on the next turn. If the two ever differ by
 * so much as a key, the next prompt is not a prefix of the last one, the
 * backend re-evaluates from the first tool call in the window, and
 * `reusable_tokens` records 0 for every turn after it — the anchored-window
 * work upstream undone by a serialisation mismatch.
 *
 * They *did* differ, in two ways. The loop sent the model's verbatim
 * `arguments` string and a `name` on the tool message; the replay sent
 * `JSON.stringify` of the parsed args and no `name`.
 *
 * Matching the code was not sufficient on its own: the replayed args come back
 * through Postgres **jsonb, which does not preserve key order** — it re-sorts
 * by key length and bytes — so `{"command":…,"cwd":…}` returns as
 * `{"cwd":…,"command":…}` and re-serialises to different bytes no matter how
 * carefully both call sites are written. Hence `canonicalJson`: order the keys
 * deterministically on both paths and the round-trip stops mattering. The JSON
 * is semantically identical either way, so the model is unaffected.
 */
function canonicalJson(value: unknown): string {
  // undefined can't reach here: object entries are filtered below, and the
  // top-level caller always passes an object.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function toolCallsForPrompt(calls: { id: string; name: string; args: unknown }[]): ToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: canonicalJson(c.args ?? {}) },
  }));
}

export function assistantMessageForPrompt(text: string, calls: ToolCall[]): ChatMessage {
  // Trimmed *here*, in the shared builder, rather than by one caller.
  // `loadHistory` reads assistant text through `textOf`, which trims; the live
  // loop passes the raw accumulated deltas, which do not. A model ending its
  // text with "\n" before a tool call — routine — therefore sent
  // `content: "Running it.\n"` during the run and `content: "Running it."` on
  // the next one, breaking the prefix at that message and recording
  // reusable_tokens: 0 for the turn after it. Whitespace-only text was worse:
  // live sent "\n" (truthy) where the replay sent null.
  const content = text.trim();
  // Key order matters as well as content: prompt fingerprints hash each
  // message with JSON.stringify, so two objects that differ only in key order
  // hash differently.
  return { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function toolResultMessageForPrompt(callId: string, name: string | undefined, output: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, ...(name === undefined ? {} : { name }), content: output };
}

/**
 * The `user_prefs` fields a run needs up front, in one read.
 *
 * `maxIterations` is clamped on read as well as on write: the column is plain
 * data, and a value that arrived any other way (a migration, a hand-edited
 * row, a future admin tool) must not be able to remove the only brake auto
 * mode has. A failed lookup falls back to the default, never to "unlimited".
 */
export function clampMaxIterations(value: number): number {
  return Math.min(MAX_MAX_ITERATIONS, Math.max(MIN_MAX_ITERATIONS, value));
}

/**
 * How long this run waits for a person, and what it does when nobody comes.
 *
 * The two windows are `null` when the user has not chosen one, and resolved
 * against the server default at the moment of the wait — not here — so an
 * operator's `APPROVAL_TIMEOUT_MS` read at call time keeps working for tests
 * and deployments alike.
 */
export interface RunWaitPrefs {
  checkinTimeoutMs: number | null;
  approvalTimeoutMs: number | null;
  adaptive: boolean;
  autoContinues: number;
  loopSensitivity: LoopSensitivity;
}

async function loadRunPrefs(
  userId: string,
): Promise<{ maxIterations: number; allowlist: Set<string>; waits: RunWaitPrefs }> {
  try {
    const row = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, userId),
      columns: {
        maxIterations: true,
        toolAllowlist: true,
        checkinTimeoutMs: true,
        approvalTimeoutMs: true,
        adaptiveTimeout: true,
        checkinAutoContinues: true,
        loopSensitivity: true,
      },
    });
    return {
      maxIterations: clampMaxIterations(row?.maxIterations ?? DEFAULT_MAX_ITERATIONS),
      allowlist: new Set(Array.isArray(row?.toolAllowlist) ? row.toolAllowlist.map(String) : []),
      waits: {
        checkinTimeoutMs: clampWaitTimeoutMs(row?.checkinTimeoutMs),
        approvalTimeoutMs: clampWaitTimeoutMs(row?.approvalTimeoutMs),
        adaptive: row?.adaptiveTimeout ?? true,
        autoContinues: clampAutoContinues(row?.checkinAutoContinues) ?? DEFAULT_CHECKIN_AUTO_CONTINUES,
        loopSensitivity: isLoopSensitivity(row?.loopSensitivity) ? row.loopSensitivity : DEFAULT_LOOP_SENSITIVITY,
      },
    };
  } catch {
    // Every half fails safe: the default ceiling rather than "unlimited", and
    // an empty allowlist, which means every write tool asks rather than none.
    // And **no** auto-continues: a run whose preferences could not be read
    // must not be granted unattended work windows on a guess — it answers on
    // the first unanswered check-in, as it always used to.
    return {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      allowlist: new Set(),
      waits: {
        checkinTimeoutMs: null,
        approvalTimeoutMs: null,
        adaptive: true,
        autoContinues: 0,
        loopSensitivity: DEFAULT_LOOP_SENSITIVITY,
      },
    };
  }
}

/**
 * The deadline for one wait, as the event announces it and the timer enforces
 * it. Computed once and used for both, so the countdown a person sees cannot
 * disagree with when the run actually gives up.
 */
export interface WaitDeadline {
  ms: number;
  basis: TimeoutBasis;
  expiresAt: number;
}

/** True when `reuse` is an exact measurement: the previous request's whole
 * message list is a prefix of this one, so `tokens` is that request's measured
 * size. Any other figure is a floor or a guess. */
function isStrictExtension(reuse: PromptReuse): reuse is PromptReuse & { tokens: number } {
  return reuse.tokens != null && reuse.tokens > 0 && reuse.previousMessages > 0 && reuse.sharedMessages === reuse.previousMessages;
}

/**
 * The `prompt.stats` a request announces before it goes out. Reads only what
 * the engine has already measured for this request — nothing here may touch
 * the prompt itself.
 */
export function promptStatsFor(input: {
  messageId: string;
  model: string;
  tally: ContextTally;
  chatMessages: ChatMessage[];
  reuse: PromptReuse;
  windowTokens: number | null;
  loadingModel: boolean;
  startedAt: number;
}): PromptStats {
  const { reuse } = input;
  const extension = isStrictExtension(reuse);
  // On a strict extension the front of the prompt has a measured size, so
  // only what was appended is estimated — far closer than estimating the
  // whole thing from characters. The appended messages carry no tool schemas
  // (those are in the measured prefix).
  const estimate = extension
    ? reuse.tokens + estimateTallyTokens(tallyChatMessages(input.chatMessages.slice(reuse.previousMessages)))
    : estimateTallyTokens(input.tally);
  // Unknown reuse is treated as none, so the ETA is an upper bound ("up to
  // about") rather than an optimistic guess.
  const toEvaluate = Math.max(0, estimate - (extension ? reuse.tokens : 0));
  const rate = input.loadingModel ? null : prefillRate(input.model);
  return {
    message_id: input.messageId,
    prompt_tokens_est: estimate,
    est_basis: extension ? "measured_prefix" : "estimate",
    reusable_tokens: reuse.tokens,
    window_tokens: input.windowTokens,
    eta_ms: rate ? Math.round((toEvaluate / rate) * 1000) : null,
    started_at: input.startedAt,
  };
}

/**
 * What one finished model request cost, as the wire carries it. One builder
 * for every place that reports it — the per-request `message.usage`, the
 * deferred `message.end` of a tool-calling message, and the turn's final
 * `message.end` — so the context meter reads the same figure however it
 * arrived, and the same as a reload rebuilds from `usage_records`.
 *
 * `tally` and `result` must describe the same request, which is why this is
 * built per iteration and never carried across one.
 */
export function turnUsageFor(input: {
  result: CompletionResult;
  reuse: PromptReuse;
  tally: ContextTally;
  omittedAttachments: AttachmentRef[];
  meta: Parameters<typeof apportion>[3];
}): TurnUsage {
  const { result } = input;
  return {
    prompt_tokens: result.usage.prompt_tokens,
    completion_tokens: result.usage.completion_tokens,
    total_tokens: result.usage.total_tokens,
    prompt_tps: result.promptTps,
    gen_tps: result.genTps,
    total_ms: result.totalMs,
    ttft_ms: result.ttftMs,
    cached_tokens: result.cachedTokens,
    reusable_tokens: input.reuse.tokens,
    ...(input.omittedAttachments.length ? { omitted_attachments: input.omittedAttachments } : {}),
    context: apportion(input.tally, result.usage.prompt_tokens, result.usage.completion_tokens, input.meta),
  };
}

/** At most one progress re-emit per this many ms. */
export const PROGRESS_EMIT_INTERVAL_MS = 1_000;

/**
 * Re-emits a request's `prompt.stats` with the backend's measured progress
 * merged in — throttled, because every non-delta event forces a stream-log
 * flush and is kept for `STREAM_TTL_SECONDS`, and llama.cpp reports once per
 * decoded batch, which with a small `n_batch` is many times a second. The
 * first report always goes (it is the proof the backend has started), and so
 * does the first to reach 100%, so the bar does not stall short of full —
 * the *first*, latched: a backend that finishes the prompt and then stalls
 * before its first token keeps reporting `processed == total`, and exempting
 * every one of those would remove the bound exactly when a request can run
 * to the hour-long ceiling. Emit-only: nothing here touches the prompt.
 */
export function promptProgressEmitter(
  stats: PromptStats,
  emit: (event: StreamEventKind) => void,
  now: () => number = Date.now,
): (progress: PromptProgress) => void {
  let lastAt: number | null = null;
  let sentComplete = false;
  return (progress) => {
    const t = now();
    const complete = progress.processed_tokens >= progress.total_tokens;
    const forced = complete && !sentComplete;
    if (lastAt !== null && !forced && t - lastAt < PROGRESS_EMIT_INTERVAL_MS) return;
    if (complete) sentComplete = true;
    lastAt = t;
    emit({ kind: "prompt.stats", ...stats, progress });
  };
}

function waitDeadline(chosenMs: number | null, adaptive: boolean, slowestTurnMs: number): WaitDeadline {
  const { ms, basis } = effectiveTimeoutMs({
    baseMs: chosenMs ?? serverDefaultTimeoutMs(),
    adaptive,
    slowestTurnMs,
  });
  return { ms, basis, expiresAt: Date.now() + ms };
}

/**
 * A plain function call rather than a direct `abort.signal.aborted` read:
 * the signal can flip true at any point during the awaits that follow an
 * earlier check in the same iteration, but the type checker doesn't model
 * that, so a direct re-read gets narrowed to a stale "still false" — this
 * indirection is what keeps that narrowing from applying.
 */
function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

/** Skip cards are `summary`-authored but textless, and must never act as a
 * compaction cutoff — hence a bounded lookback rather than "the newest". */
const SUMMARY_LOOKBACK = 20;

/**
 * The run's system prompt: the surface's base prompt, plus whichever
 * untrusted-content addenda this turn actually needs.
 *
 * Pure and exported so the addenda can be asserted directly — the same reason
 * `stripImagesForCompaction` is extracted in compactRun.ts. Driving a whole
 * run through the mock cannot show what the system prompt contained, and that
 * blind spot is exactly how DOCUMENT_SYSTEM_ADDENDUM came to be defined,
 * documented in AGENTS.md as the document path's prompt-injection defence,
 * and never once appended to a prompt.
 */
export function assembleSystemPrompt(
  basePrompt: string | null,
  toolAddendum: string | null,
  hasDocuments: boolean,
): string | null {
  const parts = [basePrompt, toolAddendum, hasDocuments ? DOCUMENT_SYSTEM_ADDENDUM : null].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * The shared tool loop behind both surfaces. The starter (startChatRun /
 * startAgentRun) has already created the conversation, persisted the user
 * message, opened the producer, and registered the run; this drives the
 * model ↔ tool round-trips until the model answers without calling a tool.
 */
export async function runToolLoop(ctx: {
  streamId: string;
  convId: string;
  userId: string;
  userMsgId: string;
  /** The user message's lamport, so the run's own inserts are ordered
   * strictly after it — see `lastLamport` below. */
  userLamport?: number;
  model: string;
  mode: PermissionMode;
  /** Surface-appropriate system prompt, or null for none. The engine appends
   * the MCP untrusted-content addendum when MCP tools are offered. */
  basePrompt: string | null;
  /** Which surface started this run. Only needed so an automatic compaction
   * opens its stream on the same one. */
  surface: "chat" | "agent";
  abort: AbortController;
  producer: StreamProducer;
}): Promise<void> {
  const { streamId, convId, userId, model, mode, abort, producer } = ctx;

  // Decided inside the loop, acted on outside it: startCompactRun takes the
  // per-conversation lock this run is still holding until `finally` releases
  // it, so triggering in place would refuse itself with "already in progress".
  let autoCompact = false;

  // Held from just before the first model call until the run ends, and handed
  // back only while waiting on a human — see acquireRunSlot.
  let slot: RunSlot | null = null;

  try {
    // One read for both: the iteration ceiling and the builtin allowlist live
    // in the same `user_prefs` row, and buildToolset would otherwise fetch it
    // again on the next line. (`userAllowsAutoCompact` is a third reader, and
    // deliberately not folded in — it is deferred until the compaction
    // threshold is actually crossed, so most turns never pay for it.)
    const { maxIterations, allowlist, waits } = await loadRunPrefs(userId);
    const toolset = await buildToolset(userId, { mode, conversationId: convId, allowlist });
    const tools = toolset.openAiTools;
    // History is loaded before the system prompt is assembled, because whether
    // this turn carries a document decides whether the document addendum goes
    // in — the same pairing MCP has, where wrapResult's markers are only
    // meaningful alongside an addendum saying what they mean.
    const history = await loadHistory(convId);
    const hasDocuments = history.messages.some(
      (m) => m.role === "user" && countDocumentParts(m.content) > 0,
    );
    const systemPrompt = assembleSystemPrompt(ctx.basePrompt, toolset.systemPromptAddendum, hasDocuments);
    // The compaction summary rides as a second system message, after the real
    // system prompt and before the replayed turns — everything older than it
    // stays in Postgres and on screen but is no longer sent.
    const summaryMsg = history.summaryText ? summaryMessage(history.summaryText) : null;
    const chatMessages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt } as ChatMessage] : []),
      ...(summaryMsg ? [summaryMsg] : []),
      ...history.messages,
    ];
    // Only user turns ever carry image parts, and the loop below only appends
    // assistant and tool messages — so this holds for every iteration.
    const hadImages = chatMessages.some((m) => m.role === "user" && countImageParts(m.content) > 0);

    // Per-message hashes from the previous iteration; safe to reuse because
    // `chatMessages` is only ever appended to below.
    let carriedHashes: readonly string[] | undefined;

    // Two messages persisted less than a millisecond apart both take
    // Date.now() as their lamport, and loadHistory's ORDER BY lamport (then
    // createdAt) breaks the tie arbitrarily rather than by insertion order.
    // Not hypothetical: an iteration whose tool call does no real work (e.g.
    // two todo_write calls back to back, as a mock scenario step can) reliably
    // lands that iteration's tool-result message and the next iteration's
    // assistant message in the same millisecond, and a swap there is a genuine
    // prompt-prefix break on the conversation's very next turn. Scoped to this
    // one run — only the two inserts below share this counter — so it changes
    // nothing about the cross-device LWW ordering packages/sync relies on.
    // Seeded from the user message rather than zero: with a zero seed the
    // first insert was a bare Date.now(), unguarded against the user message
    // that had just been written with one — the same tie, at the one
    // boundary the counter did not cover.
    let lastLamport = ctx.userLamport ?? 0;
    const nextLamport = (): number => {
      lastLamport = monotonicLamport(lastLamport);
      return lastLamport;
    };

    // Which backend this run's model lives on, for the queue it joins and the
    // cache it invalidates. A reference that cannot be resolved queues on the
    // built-in backend's queue and fails on its first request with the reason
    // — the starters refuse it before any of this, so reaching here means the
    // provider was deleted mid-run, which is exactly a run that should end.
    const providerId = await resolveModelRef(model)
      .then((r) => r.provider.id)
      .catch(() => DEFAULT_PROVIDER_ID);

    // Everything above is database and bookkeeping work that touches no
    // backend, so it happens before queueing: a run should not hold a slot
    // while it loads its own history.
    //
    // The slot covers the whole run rather than each model call. Rotating
    // between runs per call would keep the queue fair and destroy the prompt
    // cache on every iteration, which is the entire problem — see
    // inference/scheduler.ts.
    //
    // The trade-off, stated plainly: the slot is held across everything
    // *between* the model calls too — every sandboxed `bash`, up to
    // max_iterations of them — and is only handed back while a human is
    // asked for approval. At concurrency 1 (LM Studio, llama.cpp without
    // --parallel: the common case) one auto-mode run can therefore hold a
    // shared deployment for the length of its tool work with the backend
    // idle. Yielding around tool execution would not recover that for free:
    // another run admitted in the gap evicts the prefix, and this run then
    // pays a full re-evaluation when it comes back, which is the cost the
    // queue exists to avoid. Fairness beyond FIFO is a follow-up.
    slot = await acquireRunSlot({
      signal: abort.signal,
      onQueued: (position) => { producer.emit({ kind: "run.queued", position }); },
      // Each backend has its own queue: the prefix cache being protected is
      // one backend's, and a run on a hosted provider with sixteen slots
      // should not wait behind a local run's tool work.
      providerId,
    });
    if (!slot) {
      // Stopped while waiting in line. Nothing ran, so there is nothing to
      // record beyond ending the stream the way any cancelled turn ends.
      await producer.end("cancelled");
      return;
    }

    let parentId = ctx.userMsgId;
    // The end of the *current* step window, absolute rather than relative:
    // each "keep going" pushes it out by another `maxIterations`, so the
    // client can render "7/100" and then "104/200" without having to track
    // how many windows have been granted.
    let budgetEnd = maxIterations;
    const detector = new LoopDetector(loopDetectorOptions(waits.loopSensitivity));
    // Iteration key -> the calls that produced it, so a loop check-in can name
    // what is repeating. Bounded: only the last few keys can ever be part of a
    // hit, and a 500-step run must not accumulate every argument string it saw.
    const recentCalls = new Map<string, string[]>();
    // Set once the user asks for a final answer: the next request goes out
    // with `tool_choice: "none"` and the loop ends after it either way.
    let answerNow = false;
    // Planning mode ends every turn in a plan or questions (#199). A model that
    // answers in prose anyway is asked once, and that one follow-up request is
    // sent with `tool_choice: "required"`; prose a second time ends the turn.
    let planNudged = false;
    let requireTool = false;
    // The longest a single model request has taken in this run, send to done.
    // The adaptive wait floor is built on it — see effectiveTimeoutMs.
    let slowestTurnMs = 0;
    // Check-ins in a row that nobody answered. A person answering resets it;
    // it is what walks an abandoned run down the ladder in unattendedDecision.
    let unattended = 0;

    if (isAborted(abort)) {
      // Stopped between getting the slot and the first iteration. This used to
      // `break` into the tail below, which ended the stream as an *error*
      // reporting a step limit the run had not come near.
      await producer.end("cancelled");
      return;
    }

    // Unbounded: the window is a checkpoint, not a ceiling — every exit from
    // this loop now returns or breaks deliberately.
    for (let iteration = 1; ; iteration++) {
      producer.emit({ kind: "iteration", n: iteration, max: budgetEnd });

      const assistantMsgId = uuid();
      const assistantLamport = nextLamport();
      await db.insert(messages).values({
        id: assistantMsgId,
        conversationId: convId,
        parentId,
        authorType: "assistant",
        origin: "server",
        model,
        lamport: assistantLamport,
        content: [] as ContentBlock[],
        status: "streaming",
        createdAt: new Date(),
      });
      producer.emit({
        kind: "message.start",
        message_id: assistantMsgId,
        author_type: "assistant",
        parent_id: parentId,
        lamport: assistantLamport,
        model,
      });

      let text = "";
      let thinking = "";
      let toolCalls: ToolCall[] = [];
      let doneResult: CompletionResult | null = null;

      let windowTokens: number | null = null;
      // A load inside this request's TTFT: no ETA can account for it, and the
      // request's timing must not become a prefill-rate sample.
      let loadingModel = false;
      // Whether to ask the backend for prompt progress — see modelRunInfo.
      let reportProgress = false;
      try {
        // This model's own provider, never the whole fan-out: searching every
        // provider's list here would put an unreachable one's timeout in front
        // of every tool iteration of a run that has nothing to do with it —
        // while that run holds an inference slot that may be the deployment's
        // only one.
        const info = await modelRunInfo(model);
        windowTokens = info?.windowTokens ?? null;
        reportProgress = info?.nativeRuntime ?? false;
        if (info && !info.loaded) {
          loadingModel = true;
          producer.emit({ kind: "model.loading", message_id: assistantMsgId });
        }
      } catch {
        // Best-effort — fall back to the generic "thinking" indicator.
      }

      // Snapshot what this iteration is actually sending. `chatMessages` grows
      // as tool calls and results are appended, so it has to be measured here
      // rather than once per run — and `tools` is measured with it, since the
      // schemas ride in `body.tools` and appear nowhere in the message list.
      // The summary message is tallied separately: tallyChatMessages would
      // classify its system role as `system` and silently fold the compacted
      // history into the system-prompt row.
      const tally = tallyChatMessages(
        summaryMsg ? chatMessages.filter((m) => m !== summaryMsg) : chatMessages,
        tools,
      );
      // Fingerprint the exact payload about to go out — same reason the tally
      // is taken here rather than once per run: `chatMessages` grows as tool
      // calls and results are appended, and each iteration is its own request
      // with its own prefix relationship to the one before it.
      //
      // Hashes from the previous iteration are carried forward: `chatMessages`
      // is append-only within a run, and re-hashing it whole each time meant
      // re-reading every inlined image data URI on every iteration. See
      // fingerprintPrompt for the guarantee this relies on.
      const fingerprint = fingerprintPrompt(model, chatMessages, tools, carriedHashes);
      carriedHashes = fingerprint.messageHashes;
      const reuse = measureReuse(convId, fingerprint);
      if (summaryMsg) addChars(tally, "summary", summaryMsg.content);
      const breakdownMeta = {
        historyMessages: history.messages.length,
        historyLimit: HISTORY_LIMIT,
        historyTruncated: history.truncated,
        windowTokens,
      };

      // Timed around the request alone. Not the iteration: that also holds
      // tool execution and approval waits, and an approval nobody answered
      // for an hour must not stretch every later wait to two.
      const requestStartedAt = Date.now();
      const stats = promptStatsFor({
        messageId: assistantMsgId,
        model,
        tally,
        chatMessages,
        reuse,
        windowTokens,
        loadingModel,
        startedAt: requestStartedAt,
      });
      producer.emit({ kind: "prompt.stats", ...stats });
      const emitProgress = promptProgressEmitter(stats, (e) => {
        producer.emit(e);
      });
      try {
        // markBackendErrors is what separates the backend's words from ours:
        // only what the stream itself throws is stored as the reason, since
        // that text is re-served to everyone who can read the thread.
        for await (const event of markBackendErrors(
          streamCompletion(model, chatMessages, {
            tools,
            signal: abort.signal,
            // Tools stay in the request even when they may not be called —
            // see StreamOptions.toolChoice for why dropping them would cost a
            // full prompt re-evaluation on exactly the wrong request.
            ...(answerNow
              ? { toolChoice: "none" as const }
              : requireTool
                ? { toolChoice: "required" as const }
                : {}),
            reportProgress,
          }),
        )) {
          if (event.type === "delta") {
            text += event.content;
            producer.emit({ kind: "text.delta", message_id: assistantMsgId, text: event.content });
          } else if (event.type === "thinking") {
            thinking += event.content;
            producer.emit({ kind: "thinking.delta", message_id: assistantMsgId, text: event.content });
          } else if (event.type === "progress") {
            emitProgress(event.progress);
          } else {
            toolCalls = event.result.toolCalls;
            doneResult = event.result;
            recordPrompt(convId, fingerprint, event.result.usage.prompt_tokens);
            slowestTurnMs = Math.max(slowestTurnMs, Date.now() - requestStartedAt);
            recordPrefill(model, {
              promptTps: event.result.promptTps,
              promptTokens: event.result.usage.prompt_tokens,
              exactReusableTokens: isStrictExtension(reuse) ? reuse.tokens : null,
              ttftMs: event.result.ttftMs,
              loadedModel: loadingModel,
            });
          }
        }
      } catch (err) {
        const isAbort = (err as Error).name === "AbortError" || abort.signal.aborted;
        const status = isAbort ? "cancelled" : "error";
        // A text-only model choking on image parts is a user-fixable
        // situation, not an outage — say so instead of relaying the backend's
        // phrasing, which is different for every runtime.
        const raw = (err as Error).message;
        const backendText = hadImages ? (visionErrorMessage(raw) ?? raw) : raw;
        const blocks: ContentBlock[] = [];
        if (thinking) blocks.push({ kind: "thinking", text: thinking });
        if (text) blocks.push({ kind: "text", text });
        // Stored as well as emitted: the event reaches only the clients
        // watching right now, and a reload used to show a bare empty reply.
        // A cancel stores nothing — a user stop is not an error.
        const eventError = isAbort ? undefined : turnErrorText(err, `turn failed in ${convId}`, backendText);
        await db
          .update(messages)
          .set({ content: blocks, status, error: eventError ?? null })
          .where(eq(messages.id, assistantMsgId))
          .catch(() => undefined);
        producer.emit({ kind: "message.end", message_id: assistantMsgId, status, error: eventError });
        await producer.end(status, { error: eventError }).catch(() => undefined);
        return;
      }

      // A window read before a JIT load is the model's max, not what the
      // backend allocated. Re-read it as soon as the request that caused the
      // load is done — not at the end of the turn — since every usage figure
      // from here on reports against it, and later iterations would otherwise
      // keep reading the cached pre-load answer. Per request, not latched once
      // per turn, on purpose: a backend that unloads on an idle TTL can load
      // again after a long approval wait, and that load allocates the window
      // anew — so each one re-invalidates, at the cost of refetching this
      // provider's model list once per load.
      if (loadingModel && doneResult) {
        // Only this model's provider: a load on one backend says nothing
        // about another's catalogue, and dropping a hosted provider's
        // several-hundred-entry list would cost a round trip to rebuild it.
        invalidateBackendModels(providerId);
        breakdownMeta.windowTokens = (await resolveWindow(model).catch(() => null)) ?? breakdownMeta.windowTokens;
      }

      // Built once per request, before any tool runs: the context meter reads
      // the newest message that has usage, and a tool-calling message's
      // `message.end` waits on its tools — an approval nobody has answered
      // yet, a long `bash` — so emitting only there left the meter blank for
      // the whole turn (#193). Emitted before the usage row is written for the
      // same reason: a slow insert should not hold back what we already know.
      let iterationUsage: TurnUsage | undefined;
      if (doneResult) {
        iterationUsage = turnUsageFor({
          result: doneResult,
          reuse,
          tally,
          omittedAttachments: history.omittedAttachments,
          meta: breakdownMeta,
        });
        producer.emit({ kind: "message.usage", message_id: assistantMsgId, usage: iterationUsage });
        // Never allowed to fail the turn: a reply the model finished is not
        // undone because its usage row could not be written, and a database
        // error is not a reason the model failed.
        await recordUsage({
          runId: streamId,
          userId,
          convId,
          messageId: assistantMsgId,
          model,
          result: doneResult,
          reuse,
          context: iterationUsage.context,
        }).catch((err: unknown) => {
          console.error(`recording usage failed for ${convId}:`, err);
        });
      }

      // Persist the assistant turn as ordered blocks: thinking, prose, calls.
      const blocks: ContentBlock[] = [];
      if (thinking) blocks.push({ kind: "thinking", text: thinking });
      if (text) blocks.push({ kind: "text", text });
      for (const call of toolCalls) {
        blocks.push({
          kind: "tool_call",
          call_id: call.id,
          tool: call.function.name,
          args: safeParseArgs(call.function.arguments),
        });
        producer.emit({
          kind: "tool.call",
          message_id: assistantMsgId,
          call_id: call.id,
          tool: call.function.name,
          args: safeParseArgs(call.function.arguments),
        });
      }
      await db
        .update(messages)
        .set({ content: blocks.length ? blocks : [{ kind: "text", text: "" }], status: "complete" })
        .where(eq(messages.id, assistantMsgId));

      /**
       * Ends the turn as a success, from whichever branch got there.
       *
       * One closure rather than two copies because the two callers must stay
       * identical in everything a client or the compaction policy can see:
       * the usage on `message.end`, the compaction verdict from the measured
       * prompt, and `producer.end` carrying that usage. The verdict is
       * *returned* and assigned by the caller, not assigned in here: an
       * assignment inside a closure is invisible to control-flow analysis,
       * so the trigger past the `finally` would read `autoCompact` as the
       * literal `false` it was declared with and lint it as never-true —
       * correct at runtime, and exactly the kind of thing that stops being
       * correct on the next refactor. The "answer now"
       * fallback used to end with `producer.end("complete")` and a bare
       * `return` — a successful turn that reported no token counts, dropped
       * the omitted-attachments notice, and skipped the compaction check
       * entirely, so a turn over the threshold left the *next* one to
       * assemble an over-size prompt with nothing having intervened.
       *
       * Callers `break` afterwards, never `return`: the auto-compaction trigger
       * sits past the `finally`, and only a `break` reaches it.
       */
      const endTurnComplete = async (leafId: string, messageEnded = false): Promise<boolean> => {
        await db
          .update(conversations)
          .set({ activeLeafId: leafId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
        const usage = iterationUsage;
        // Checked here rather than before the next turn starts: this is the
        // one point where the *measured* size of the prompt and the window it
        // was assembled against are both in hand. The threshold leaves room
        // for the turn that follows, which is what makes acting after the
        // fact safe.
        const compact = shouldAutoCompact({
          usedTokens: doneResult ? doneResult.usage.prompt_tokens + doneResult.usage.completion_tokens : 0,
          windowTokens: breakdownMeta.windowTokens ?? null,
          historyMessages: history.messages.length,
        });
        // A turn ended by a handed-over plan has already sent this: its tools
        // ran first, and message.end follows their results.
        if (!messageEnded) {
          producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage });
        }
        await producer.end("complete", { usage });
        return compact;
      };

      if (toolCalls.length === 0) {
        // A planning turn that answered in prose is asked, once, to finish
        // with a plan or questions (#199). Never after "answer now" — that is
        // the user asking for exactly this prose.
        if (mode === "planning" && !answerNow && !planNudged) {
          planNudged = true;
          requireTool = true;
          producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage: iterationUsage });
          // The prose goes into the live prompt exactly as the replay will
          // put it back — including skipping an empty one, which loadHistory
          // does — or the next turn's prefix breaks at this message.
          if (text.trim()) chatMessages.push(assistantMessageForPrompt(text, []));
          // Persisted rather than injected, for the reason the check-in nudge
          // is (CHECKIN_ANSWER_NUDGE below): the next turn has to replay the
          // same bytes. Null author — nobody typed it.
          const nudgeId = uuid();
          const nudgeLamport = nextLamport();
          await db.insert(messages).values({
            id: nudgeId,
            conversationId: convId,
            parentId: assistantMsgId,
            authorType: "user",
            authorUserId: null,
            origin: "server",
            lamport: nudgeLamport,
            content: [{ kind: "text", text: PLAN_REQUIRED_NUDGE }] as ContentBlock[],
            status: "complete",
            createdAt: new Date(),
          });
          producer.emit({
            kind: "message.start",
            message_id: nudgeId,
            author_type: "user",
            parent_id: assistantMsgId,
            lamport: nudgeLamport,
            text: PLAN_REQUIRED_NUDGE,
            author_user_id: null,
          });
          producer.emit({ kind: "message.end", message_id: nudgeId, status: "complete" });
          chatMessages.push({ role: "user", content: PLAN_REQUIRED_NUDGE });
          parentId = nudgeId;
          budgetEnd = Math.max(budgetEnd, iteration + 1);
          continue;
        }
        autoCompact = await endTurnComplete(assistantMsgId);
        break;
      }

      // toolCalls.length > 0: message.end is deferred — the run continues
      // (tool results still need to land on this message before it's done).
      // Normalised through the same builder the replay uses — see
      // toolCallsForPrompt for what drifting apart costs.
      const promptCalls = toolCallsForPrompt(
        toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: safeParseArgs(c.function.arguments) })),
      );
      chatMessages.push(assistantMessageForPrompt(text, promptCalls));
      parentId = assistantMsgId;

      if (answerNow) {
        // The request went out with `tool_choice: "none"` and the backend
        // called a tool anyway. Running it would ignore what the user actually
        // asked for, but simply dropping the calls is not an option either: an
        // assistant `tool_call` with no partner is the orphan `loadHistory` has
        // to strip and most backends reject. So each one is answered, and the
        // turn ends with whatever text the model did produce.
        const refusedBlocks: ContentBlock[] = [];
        for (const call of toolCalls) {
          producer.emit({
            kind: "tool.result",
            message_id: assistantMsgId,
            call_id: call.id,
            tool: call.function.name,
            output: ANSWER_NOW_NOT_RUN,
            ok: false,
          });
          refusedBlocks.push({ kind: "tool_result", call_id: call.id, output: ANSWER_NOW_NOT_RUN, ok: false });
        }
        const refusedMsgId = uuid();
        await db.insert(messages).values({
          id: refusedMsgId,
          conversationId: convId,
          parentId: assistantMsgId,
          authorType: "tool",
          origin: "server",
          lamport: nextLamport(),
          content: refusedBlocks,
          status: "complete",
          createdAt: new Date(),
        });
        // A successful turn, ended exactly like every other one — with its
        // usage, and through `break` so the compaction check still runs.
        autoCompact = await endTurnComplete(refusedMsgId);
        break;
      }

      // ── Run each requested tool ───────────────────────────
      const resultBlocks: ContentBlock[] = [];
      // Set once a plan or questions have been handed over in this message —
      // see the end of the turn below.
      let handedOver = false;
      for (const call of toolCalls) {
        // Nothing runs after a plan or questions in the same message. The turn
        // ends on them, so the user is looking at them; a write queued behind it would
        // otherwise put an approval in front of them for work nobody has
        // agreed to. Recorded rather than dropped — every tool_call needs its
        // tool_result partner, or the next replay carries an orphan.
        if (handedOver) {
          producer.emit({
            kind: "tool.result",
            message_id: assistantMsgId,
            call_id: call.id,
            tool: call.function.name,
            output: HANDOVER_ALREADY_SUBMITTED,
            ok: false,
          });
          resultBlocks.push({ kind: "tool_result", call_id: call.id, output: HANDOVER_ALREADY_SUBMITTED, ok: false });
          chatMessages.push(toolResultMessageForPrompt(call.id, call.function.name, HANDOVER_ALREADY_SUBMITTED));
          continue;
        }
        // Checked per call, not just per iteration. A model routinely emits
        // several calls in one message — five was an ordinary turn in the
        // session that prompted #113 — and they run in series, `bash` capped
        // at 60s each. Without this, Stop pressed on the first of them still
        // ran the other four: 6m39s of a button that visibly does nothing.
        //
        // Still emitted and persisted rather than dropped: every tool_call
        // needs its tool_result partner, or the next turn's replay carries an
        // orphan that most backends reject outright.
        if (isAborted(abort)) {
          const output = "Stopped by the user before this tool call ran.";
          producer.emit({
            kind: "tool.result",
            message_id: assistantMsgId,
            call_id: call.id,
            tool: call.function.name,
            output,
            ok: false,
          });
          resultBlocks.push({ kind: "tool_result", call_id: call.id, output, ok: false });
          chatMessages.push(toolResultMessageForPrompt(call.id, call.function.name, output));
          continue;
        }
        let outcome: Awaited<ReturnType<typeof runOneToolCall>>;
        try {
          outcome = await runOneToolCall(
            {
              streamId,
              convId,
              userId,
              mode,
              toolset,
              producer,
              assistantMsgId,
              slot,
              signal: abort.signal,
              // A getter, not a value: each approval in a batch starts its own
              // wait, and gets a deadline measured from its own start.
              approvalDeadline: () => waitDeadline(waits.approvalTimeoutMs, waits.adaptive, slowestTurnMs),
            },
            call,
          );
        } catch (err) {
          if (!(err instanceof RunSlotAbortedError)) throw err;
          // Stopped at this call's approval prompt: the approval handed the
          // inference slot back, and re-entering the queue for an aborted run
          // throws. Nothing ran for *this* call, so it is recorded exactly
          // like a skipped one — which is what keeps the calls before it,
          // which did run and did write, in the transcript and the prompt.
          // Letting the throw escape the loop used to skip the insert below
          // and discard those results: the model then had no record that a
          // file it had written existed, and the user watched a result
          // arrive live that was gone after a reload. The per-call check
          // above skips the rest; the abort branch after the insert ends the
          // turn.
          const output = "Stopped by the user before this tool call ran.";
          producer.emit({
            kind: "tool.result",
            message_id: assistantMsgId,
            call_id: call.id,
            tool: call.function.name,
            output,
            ok: false,
          });
          resultBlocks.push({ kind: "tool_result", call_id: call.id, output, ok: false });
          chatMessages.push(toolResultMessageForPrompt(call.id, call.function.name, output));
          continue;
        }
        // Persisted alongside the output, not just emitted: the live event is
        // gone the moment the stream ends, and without this the transcript
        // could not tell a failed call from a successful one after a reload.
        resultBlocks.push({
          kind: "tool_result",
          call_id: call.id,
          output: outcome.output,
          ok: outcome.ok,
          ...(outcome.diff ? { diff: outcome.diff } : {}),
        });
        chatMessages.push(toolResultMessageForPrompt(call.id, call.function.name, outcome.output));
        if (HANDOVER_TOOL_NAMES.has(call.function.name) && outcome.ok) handedOver = true;
      }
      producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage: iterationUsage });

      const toolMsgId = uuid();
      await db.insert(messages).values({
        id: toolMsgId,
        conversationId: convId,
        parentId: assistantMsgId,
        authorType: "tool",
        origin: "server",
        lamport: nextLamport(),
        content: resultBlocks,
        status: "complete",
        createdAt: new Date(),
      });
      parentId = toolMsgId;

      if (isAborted(abort)) {
        // This iteration's tools already ran and its message.end already
        // went out above as "complete" — the tool results are real and
        // stay. What stops here is the *run continuing to another
        // iteration*, so the stream itself ends cancelled without touching
        // an already-finished message.
        await db
          .update(conversations)
          .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
        await producer.end("cancelled");
        return;
      }

      // ── A handed-over plan or questions end the turn ───────
      //
      // No further model request: what happens next is the user's decision on
      // the plan, and it arrives as their next message (#199). Letting the loop
      // run on would have the model restate the plan, or start on one nobody
      // accepted. Before the check-in, so a plan is never followed by a
      // question about whether to keep going; after the abort check, so a stop
      // pressed during the plan's own call still ends the turn cancelled.
      if (handedOver) {
        autoCompact = await endTurnComplete(toolMsgId, true);
        break;
      }

      // ── Check in, if this iteration earned one ─────────────
      //
      // Deliberately here: after the tool row is persisted (so a run stopped
      // at the question keeps a complete transcript) and after the abort check
      // (so a stop pressed during the last tool is not answered with a
      // question), but before the next assistant row exists.
      const executed = toolCalls.map((c) => ({
        tool: c.function.name,
        args: safeParseArgs(c.function.arguments),
      }));
      const iterationKey = sha(executed.map((c) => sha(`${c.tool}\0${canonicalJson(c.args)}`)).join("|"));
      // Names only. The args went into the key above and are not needed
      // again; keeping them here would put an `fs_write` loop's file content
      // into the check-in event — see the `pattern` type for why not.
      recentCalls.set(iterationKey, executed.map((c) => c.tool));
      // Only the last few keys can be part of a hit; anything older is dead
      // weight in a run that may take hundreds of steps.
      if (recentCalls.size > 8) {
        const oldest = recentCalls.keys().next().value;
        if (oldest !== undefined) recentCalls.delete(oldest);
      }
      const hit = detector.push(iterationKey);
      const reason: CheckinReason | null = hit ? "loop" : iteration >= budgetEnd ? "budget" : null;
      if (!reason) continue;

      // One deadline, used for both the event and the timer, so the countdown a
      // person sees is exactly when the run gives up waiting.
      const deadline = waitDeadline(waits.checkinTimeoutMs, waits.adaptive, slowestTurnMs);
      const onTimeout = unattendedDecision(unattended, waits.autoContinues, "timeout");
      producer.emit({
        kind: "steps.checkin",
        n: iteration,
        max: budgetEnd,
        reason,
        ...(hit ? { pattern: hit.unit.flatMap((k) => (recentCalls.get(k) ?? []).map((tool) => ({ tool }))) } : {}),
        timeout_ms: deadline.ms,
        expires_at: deadline.expiresAt,
        timeout_basis: deadline.basis,
        on_timeout: onTimeout,
        unattended,
        auto_continues: waits.autoContinues,
      });

      let outcome: { decision: StepsDecision; byUserId: string | null };
      try {
        outcome = await slot.yieldWhile(async () => {
          const answered = await waitForStepsDecision(streamId, abort.signal, deadline.ms);
          const byPerson = answered.kind === "continue" || answered.kind === "answer";
          // The ladder: nobody answered, so this is decided by how many in a
          // row have gone unanswered — carry on for the first few, then wrap
          // up. `aborted` never reaches a decision (re-entering the queue for
          // an aborted run throws); `gone` always wraps up.
          const decision: StepsDecision = byPerson
            ? answered.kind
            : unattendedDecision(unattended, waits.autoContinues, answered.kind === "gone" ? "gone" : "timeout");
          if (byPerson) {
            unattended = 0;
          } else if (answered.kind !== "aborted") {
            unattended += 1;
          }
          // Emitted from inside `yieldWhile`, before the run re-enters the
          // queue. A decision emitted after re-entry would leave a client
          // catching up mid-wait showing "Queued" *and* the check-in bar for
          // however long the queue took.
          if (answered.kind !== "aborted") {
            producer.emit({
              kind: "steps.decision",
              decision,
              by: byPerson ? "user" : "timeout",
              n: iteration,
              ...(byPerson ? {} : { unattended, auto_continues: waits.autoContinues }),
            });
          }
          return { decision, byUserId: byPerson ? answered.byUserId : null };
        });
      } catch (err) {
        // Stopped while parked. Re-entering the queue for an aborted run
        // throws, which is how an abort at an approval unwinds too — the
        // difference is only that there is no tool result to record here,
        // because nothing was mid-flight.
        if (!(err instanceof RunSlotAbortedError)) throw err;
        await db
          .update(conversations)
          .set({ activeLeafId: toolMsgId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
        await producer.end("cancelled");
        return;
      }

      if (outcome.decision === "continue") {
        budgetEnd = iteration + maxIterations;
        detector.reset();
        continue;
      }

      // "Answer now". The instruction is persisted as a user message rather
      // than injected only into the live prompt: the next turn's replay has to
      // produce byte-identical bytes at this position or the whole prefix — and
      // with it the backend's cache for this conversation — is lost. A `system`
      // row would need a new branch in `loadHistory` *and* in the client, and
      // several chat templates reject a system message that is not first.
      const nudgeId = uuid();
      const nudgeLamport = nextLamport();
      await db.insert(messages).values({
        id: nudgeId,
        conversationId: convId,
        parentId: toolMsgId,
        authorType: "user",
        // Null when the timeout decided: nobody asked for this, and recording
        // a user who did not press the button would be a lie the transcript
        // keeps forever.
        authorUserId: outcome.byUserId,
        origin: "server",
        lamport: nudgeLamport,
        content: [{ kind: "text", text: CHECKIN_ANSWER_NUDGE }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      });
      producer.emit({
        kind: "message.start",
        message_id: nudgeId,
        author_type: "user",
        parent_id: toolMsgId,
        lamport: nudgeLamport,
        text: CHECKIN_ANSWER_NUDGE,
        // The same fact the row records, on the wire: without it a client could
        // only match the text, and printed "You asked for an answer" when
        // nobody had.
        author_user_id: outcome.byUserId,
      });
      producer.emit({ kind: "message.end", message_id: nudgeId, status: "complete" });
      // Key order matches loadHistory's own `{ role, content }` — see
      // prompt-prefix.test.ts for what a mismatch here costs.
      chatMessages.push({ role: "user", content: CHECKIN_ANSWER_NUDGE });
      parentId = nudgeId;
      // The answer is one more iteration, and the window genuinely grants it:
      // without this a budget check-in at 100/100 answered here would emit
      // the final turn as `101/100`, and the header, the banner's "Step N of
      // M" and the numbers the user just reasoned about would all disagree.
      budgetEnd = Math.max(budgetEnd, iteration + 1);
      answerNow = true;
    }
  } catch (err) {
    // The one error this function is allowed to expect. It means the user
    // pressed stop while the run was waiting to get back into the queue after
    // an approval, and the right response is the same one every other cancel
    // gets. Anything else keeps propagating rather than being flattened into a
    // cancelled turn that hides a real fault.
    if (!(err instanceof RunSlotAbortedError)) throw err;
    await producer.end("cancelled").catch(() => undefined);
    return;
  } finally {
    // Before unregisterRun, so the next run in line starts against a registry
    // that no longer thinks this conversation is busy.
    slot?.release();
    unregisterRun(streamId);
  }

  // Past the `finally`, so the lock is free. Deliberately not reached by the
  // error and cancel paths above, which `return` — a run that failed has not
  // established what the prompt costs, and compacting after a user pressed
  // stop would be the opposite of what they asked for.
  // The pref is checked here rather than beside shouldAutoCompact so an
  // ordinary turn never pays for the query — only a turn that has already
  // decided it wants to compact asks whether it may.
  if (autoCompact && (await userAllowsAutoCompact(userId))) {
    try {
      // Dynamic on purpose: compactRun imports this module's history loader,
      // so a static import here would close a cycle between the two. See
      // auto-compact.ts.
      const { startCompactRun } = await import("./compactRun.ts");
      await startCompactRun({ userId, conversationId: convId, model, surface: ctx.surface, auto: true });
    } catch (err) {
      // Best-effort. A refused lock (the user sent again the instant the turn
      // ended) or a backend hiccup must not surface as a failure of the turn
      // that already succeeded — the threshold will simply be met again next
      // time.
      console.warn(`auto-compaction skipped for ${convId}: ${(err as Error).message}`);
    }
  }
}

/** Approval gate + execution for a single model-requested tool call. */
async function runOneToolCall(
  ctx: {
    streamId: string;
    convId: string;
    userId: string;
    mode: PermissionMode;
    toolset: Toolset;
    producer: StreamProducer;
    assistantMsgId: string;
    slot: RunSlot;
    /** The run's abort signal, so a stop reaches the approval wait. */
    signal: AbortSignal;
    /** This approval's deadline, measured from the moment it starts. */
    approvalDeadline: () => WaitDeadline;
  },
  call: ToolCall,
): Promise<{
  output: string;
  /** Mirrors the `ok` on the `tool.result` event this function emits, so the
   * caller can persist the same verdict rather than inferring one from the
   * output text. Every return path sets it explicitly. */
  ok: boolean;
  diff?: { path: string; oldContent: string | null; newContent: string | null }[];
}> {
  const { convId, userId, mode, toolset, producer, assistantMsgId } = ctx;
  const toolName = call.function.name;
  const args = safeParseArgs(call.function.arguments);

  const resolved = toolset.get(toolName);
  if (!resolved) {
    const output = `Unknown tool "${toolName}". Available tools: see the tool list.`;
    producer.emit({
      kind: "tool.result",
      message_id: assistantMsgId,
      call_id: call.id,
      tool: toolName,
      output,
      ok: false,
    });
    return { output, ok: false };
  }

  if (toolset.requiresApproval(resolved, mode)) {
    const deadline = ctx.approvalDeadline();
    producer.emit({
      kind: "approval.request",
      call_id: call.id,
      tool: toolName,
      args,
      timeout_ms: deadline.ms,
      expires_at: deadline.expiresAt,
      timeout_basis: deadline.basis,
    });
    // The slot goes back while the question is on screen. A manual-mode
    // approval routinely sits for minutes, and holding an inference slot
    // through it would stall every other conversation on the deployment for
    // exactly as long as the user takes to click. Re-taken at the front of the
    // queue afterwards, so approving does not cost the user their place.
    const outcome = await ctx.slot.yieldWhile(() => waitForApproval(ctx.streamId, call.id, ctx.signal, deadline.ms));
    if (outcome !== "approved") {
      const output = approvalRefusalText(outcome);
      producer.emit({
        kind: "tool.result",
        message_id: assistantMsgId,
        call_id: call.id,
        tool: toolName,
        output,
        ok: false,
      });
      return { output, ok: false };
    }
  }

  if (resolved.source.kind === "mcp") {
    // No sandbox involvement: MCP dispatch validates args, calls the server,
    // and returns wrapped untrusted output. Failures are ok:false results.
    const result = await toolset.dispatchMcp(resolved, args);
    producer.emit({
      kind: "tool.result",
      message_id: assistantMsgId,
      call_id: call.id,
      tool: toolName,
      output: result.output,
      ok: result.ok,
    });
    return { output: result.output, ok: result.ok };
  }

  // The MCP branch returned above, so this is a builtin by construction — and
  // builtin names come from TOOLS, so the ToolName narrowing is sound.
  const builtinName = resolved.name as ToolName;

  let handle = null;
  if (toolNeedsSandbox(builtinName)) {
    try {
      handle = await getConversationSandbox(userId, convId);
    } catch (err) {
      // The underlying error usually already names what was tried and how to
      // fix it — see container-provider.ts's requireDocker(). A GitHub
      // permission refusal is the exception, and it lands here: it arrives as
      // git's own stderr, which says "Write access to repository not granted"
      // even for a read-only clone it refused. That string is also what the
      // *model* reads, so until it was translated the agent dutifully told
      // people to grant write access to fix a missing read permission.
      const raw = (err as Error).message;
      const permission = describeGithubPermissionFailure({ message: raw, need: "contents-read" });
      const output = `Could not start a sandbox: ${permission ?? raw}`;
      producer.emit({
        kind: "tool.result",
        message_id: assistantMsgId,
        call_id: call.id,
        tool: toolName,
        output,
        ok: false,
      });
      return { output, ok: false };
    }
  }

  const result: ToolResult = await executeTool(handle, builtinName, args, ctx.signal);
  if (result.todos) producer.emit({ kind: "todos", todos: result.todos });
  producer.emit({
    kind: "tool.result",
    message_id: assistantMsgId,
    call_id: call.id,
    tool: toolName,
    output: result.output,
    ok: result.ok,
    ...(result.diff ? { diff: result.diff } : {}),
  });
  return { output: result.output, ok: result.ok, diff: result.diff };
}

/**
 * Why an approval wait ended.
 *
 * These four used to be a single `false`, and the caller rendered every one of
 * them as "User denied this tool call." Three of them cannot support that
 * sentence: `timeout` means nobody answered, `aborted` means the run was
 * stopped, and `gone` is our own bookkeeping losing the run. The distinction
 * is not cosmetic — the model reads this text and reasons about it. Told it
 * was refused, it apologises and argues its case; a real session had it
 * conclude the user had denied the same call twice, five minutes apart, when
 * they had never been shown a prompt at all.
 */
type ApprovalOutcome = "approved" | "denied" | "timeout" | "aborted" | "gone";

/**
 * What the model and the transcript are told when a tool call did not run.
 *
 * `denied` keeps its original wording exactly: a person really did refuse, and
 * that is the one case the old sentence was right about. `aborted` reuses the
 * per-call stop wording verbatim, so a stop reads identically wherever in the
 * loop it lands.
 *
 * The timeout names the timeout and says plainly that nobody refused — and
 * stops there. It deliberately does *not* suggest allowlisting the tool.
 * "Allow always" is not one thing: for an MCP tool it patches that server's
 * own per-tool policy, but for a builtin it patches `user_prefs.tool_allowlist`,
 * which is global and mode-independent — so on `bash` or `fs_write` that
 * sentence had the model lobbying for a deployment-wide write gate to be
 * removed permanently. And `timeout` is precisely the outcome carrying *no*
 * information about what the user wanted, since by definition nobody saw the
 * prompt. The branch with the weakest evidence must not carry the strongest
 * recommendation.
 */
function approvalRefusalText(outcome: Exclude<ApprovalOutcome, "approved">): string {
  switch (outcome) {
    case "denied":
      return "User denied this tool call.";
    case "aborted":
      return "Stopped by the user before this tool call ran.";
    case "timeout":
      return (
        "The approval request went unanswered, so this tool call did not run. " +
        "Nobody refused it — the request simply expired. Ask the user to approve it."
      );
    case "gone":
      return "This run was no longer active when the tool call asked for approval, so it did not run.";
  }
}

/**
 * Recorded against a tool call the model made *after* being told to answer
 * without tools.
 *
 * `tool_choice: "none"` is supposed to prevent this, and on a backend that
 * honours it this text is never written. It exists because a request that is
 * ignored must not leave an assistant `tool_call` with no matching result:
 * that is the orphan pair `loadHistory` has to strip, and most backends reject
 * it outright on the next turn.
 */
const ANSWER_NOW_NOT_RUN = "Not run — the user asked for a final answer without tools.";

/** A call made after a plan or questions in the same message. Fixed text — it
 * is replayed in every later prompt. */
export const HANDOVER_ALREADY_SUBMITTED =
  "Not run — a plan or questions were submitted earlier in the same message, which ends the turn.";

/** How a step check-in ended. `continue`/`answer` are a person's answer;
 * `timeout` and `gone` are decided by `unattendedDecision`, and `aborted` is a
 * stop, which unwinds through the slot rather than being answered. */
type CheckinOutcome =
  | { kind: "continue" | "answer"; byUserId: string | null }
  | { kind: "timeout" | "aborted" | "gone" };

/**
 * Waits for someone to answer a step check-in.
 *
 * Deliberately shaped like `waitForApproval` below — same `settle` teardown,
 * same abort listener, a window the caller computes, registered after the
 * `aborted` re-check so an abort landing mid-setup cannot be missed. A check-in
 * is the same kind of pause as an approval (a run parked on a human), so the
 * two should fail in the same ways rather than each inventing its own.
 *
 * The one difference is the key: this registers a single resolver on the run
 * rather than an entry in a per-call map, because a run has at most one
 * check-in outstanding and it is addressed by `stream_id` — ours and unique,
 * unlike the model-supplied `call_id` an approval has to tolerate colliding.
 */
function waitForStepsDecision(streamId: string, signal: AbortSignal, timeoutMs: number): Promise<CheckinOutcome> {
  return new Promise<CheckinOutcome>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    const run = getRun(streamId);
    if (!run) {
      resolve({ kind: "gone" });
      return;
    }
    let done = false;
    const settle = (outcome: CheckinOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run.stepsDecision = undefined;
      resolve(outcome);
    };
    const onAbort = () => { settle({ kind: "aborted" }); };
    const timer = setTimeout(() => { settle({ kind: "timeout" }); }, timeoutMs);
    run.stepsDecision = (decision, byUserId) => { settle({ kind: decision, byUserId }); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Approvals are run-scoped (registry), not connection-scoped — a different
 * device/socket than the one that started the run can approve or deny. */
/**
 * Waits for a human to approve or deny one tool call.
 *
 * Takes the run's abort signal, and that is the whole point: without it, Stop
 * pressed at a permission prompt flipped `aborted` and then changed nothing
 * observable, because this promise only ever settled on approve/deny or the
 * approval timeout. Manual mode is the default, so "the stop button does
 * nothing" was the *ordinary* experience of stopping an agent that was
 * waiting on you — see #113.
 *
 * It reports *why* the wait ended, rather than a boolean. Four different
 * endings used to collapse into one `false`, and the caller turned every one
 * of them into "User denied this tool call." — a claim about a person that
 * three of the four cannot support. Registered after the `aborted` re-check
 * rather than before, so an abort that fired while this was being set up
 * cannot be missed.
 */
function waitForApproval(
  streamId: string,
  callId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    const run = getRun(streamId);
    if (!run) {
      resolve("gone");
      return;
    }
    // Every path below goes through `settle`, so the timer and the abort
    // listener are always torn down — a listener left on a long-lived signal
    // is a leak, and a stray timer would delete a *later* call's approval.
    let done = false;
    const settle = (outcome: ApprovalOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run.approvals.delete(callId);
      resolve(outcome);
    };
    const onAbort = () => { settle("aborted"); };
    const timer = setTimeout(() => { settle("timeout"); }, timeoutMs);
    // The registry's resolver stays `(approved: boolean) => void`, so the two
    // WebSocket handlers that answer an approval need no change: only this
    // function knows the difference between a person saying no and nobody
    // answering at all.
    run.approvals.set(callId, (approved: boolean) => { settle(approved ? "approved" : "denied"); });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function recordUsage(input: {
  runId: string;
  userId: string;
  convId: string;
  messageId: string;
  model: string;
  result: CompletionResult;
  reuse: PromptReuse;
  context?: ContextBreakdown;
}): Promise<void> {
  const { result } = input;
  // Guard against writing an all-zero row when a provider reports nothing.
  if (result.usage.total_tokens <= 0 && !result.timings) return;
  await db.insert(usageRecords).values({
    id: uuid(),
    userId: input.userId,
    conversationId: input.convId,
    messageId: input.messageId,
    runId: input.runId,
    model: input.model,
    origin: "server",
    inputTokens: result.usage.prompt_tokens,
    // Null, not 0, when the backend says nothing — see the column's comment.
    cachedTokens: result.cachedTokens,
    reusableTokens: input.reuse.tokens,
    outputTokens: result.usage.completion_tokens,
    ttftMs: result.ttftMs,
    promptMs: result.timings?.prompt_ms ?? null,
    predictMs: result.timings?.predicted_ms ?? null,
    totalMs: result.totalMs,
    promptTps: result.promptTps,
    predictedTps: result.genTps,
    contextBreakdown: input.context ?? null,
  });
}

/**
 * Rebuilds the OpenAI message list from stored content blocks. Thinking
 * blocks are dropped (display-only), and tool calls and results that lost
 * their partner are stripped in both directions — an interrupted run leaves a
 * dangling call, and the window's oldest edge can orphan a result; most
 * servers reject either.
 *
 * The replayed window is anchored, not sliding: its oldest edge is quantised
 * to HISTORY_STEP so that consecutive turns send a prompt the previous turn's
 * prompt is a *prefix* of, which is the whole basis of the backend's KV
 * cache. See HISTORY_STEP for what a per-message slide costs.
 */
export async function loadHistory(
  conversationId: string,
): Promise<{
  messages: ChatMessage[];
  truncated: boolean;
  summaryText: string | null;
  /** Attachments this prompt left out because their class's budget was full.
   * The model is told (`attachmentContentParts` substitutes a marker), and
   * this is how the *user* gets told too — without it the thumbnail sits in
   * the transcript looking exactly like one the model can see. */
  omittedAttachments: AttachmentRef[];
}> {
  // The newest real compaction point, keyed on lamport — the same ordering
  // the main query below uses. Rows at or before it are represented by the
  // summary text and excluded from the replay.
  const summaryRows = await db.query.messages.findMany({
    where: and(
      eq(messages.conversationId, conversationId),
      eq(messages.authorType, "summary"),
      eq(messages.status, "complete"),
    ),
    orderBy: (msgs, { desc }) => [desc(messages.lamport), desc(msgs.createdAt)],
    columns: { content: true, lamport: true },
    limit: SUMMARY_LOOKBACK,
  });
  const summaryRow = summaryRows
    .map((r) => ({ text: textOf(r.content as ContentBlock[]), lamport: r.lamport }))
    .find((r) => r.text.length > 0);
  const summaryText = summaryRow?.text ?? null;

  const replayable = summaryRow
    ? and(eq(messages.conversationId, conversationId), gt(messages.lamport, summaryRow.lamport))
    : eq(messages.conversationId, conversationId);

  // A real COUNT(*), where the old code inferred "is there more?" from a
  // limit+1 fetch. The window's oldest edge has to be a stable function of
  // how long the conversation is (historyAnchor), and that needs the actual
  // length — an over-fetch by one can only answer the yes/no. One indexed
  // count per run (not per tool iteration) is a fair price for a prompt
  // prefix the backend can cache.
  const [{ total }] = await db
    .select({ total: count() })
    .from(messages)
    .where(replayable);

  const anchor = historyAnchor(total);
  const windowSize = total - anchor;
  const truncated = anchor > 0;

  const rows = windowSize > 0
    ? await db.query.messages.findMany({
        where: replayable,
        orderBy: (msgs, { desc }) => [desc(messages.lamport), desc(msgs.createdAt)],
        columns: { authorType: true, content: true, status: true, lamport: true },
        limit: windowSize,
      })
    : [];
  const ordered = rows.reverse();

  // Call ids in both directions. `resolvedCallIds` strips an assistant's
  // dangling tool_call (an interrupted run) — but the window's oldest edge
  // can equally cut the other way, leaving a tool_result whose assistant
  // tool_call fell outside it. A `role: "tool"` message with no preceding
  // call is rejected outright by most backends, so `presentCallIds` drops
  // those too. Both sets are collected before anything is emitted, because
  // the rows they describe are interleaved.
  const resolvedCallIds = new Set<string>();
  const presentCallIds = new Set<string>();
  // A tool_result block stores no tool name, but the live loop puts one on the
  // message it sends — so the name has to come from the assistant's matching
  // tool_call block or the two shapes diverge.
  const callNames = new Map<string, string>();
  for (const row of ordered) {
    for (const block of row.content as ContentBlock[]) {
      if (row.authorType === "tool" && block.kind === "tool_result") resolvedCallIds.add(block.call_id);
      if (row.authorType === "assistant" && block.kind === "tool_call") {
        presentCallIds.add(block.call_id);
        callNames.set(block.call_id, block.tool);
      }
    }
  }

  // Which attachments this prompt can afford, decided over the whole replay
  // before any of it is read off disk — see selectAffordableAttachments.
  // Skipping the walk when the thread has none keeps the common case free of
  // stats.
  const complete = ordered.filter((row) => row.status === "complete");
  const attachmentTurns = complete
    .filter((row) => row.authorType === "user")
    .map((row) => attachmentsOf((row.content ?? []) as ContentBlock[]));
  const affordable = attachmentTurns.some((t) => t.length > 0)
    ? await selectAffordableAttachments(attachmentTurns)
    : undefined;
  // Same verdict `attachmentContentParts` acts on below, so the two can't
  // disagree about what was sent. De-duplicated by ref: one file dropped is
  // one thing to tell the user, however many turns repeated it.
  const omittedAttachments = affordable
    ? [...new Map(
        attachmentTurns
          .flat()
          .filter((a) => !affordable.has(a.ref))
          .map((a) => [a.ref, a] as const),
      ).values()]
    : [];

  const out: ChatMessage[] = [];
  for (const row of complete) {
    const blocks = (row.content ?? []) as ContentBlock[];

    if (row.authorType === "user") {
      const text = textOf(blocks);
      const atts = attachmentsOf(blocks);
      // Image-only turns have no text at all, so the emptiness check can't
      // gate them the way it gates a genuinely blank message.
      if (atts.length > 0) {
        out.push({
          role: "user",
          content: await attachmentContentParts(atts, text, affordable, (a, fullText) =>
            writeOverflowToSandbox(conversationId, a, fullText),
          ),
        });
      } else if (text) {
        out.push({ role: "user", content: text });
      }
      continue;
    }

    if (row.authorType === "assistant") {
      const text = textOf(blocks);
      const calls = toolCallsForPrompt(
        blocks
          .filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call")
          .filter((b) => resolvedCallIds.has(b.call_id))
          .map((b) => ({ id: b.call_id, name: b.tool, args: b.args })),
      );
      if (!text && calls.length === 0) continue;
      out.push(assistantMessageForPrompt(text, calls));
      continue;
    }

    if (row.authorType === "tool") {
      for (const block of blocks) {
        if (block.kind !== "tool_result") continue;
        if (!presentCallIds.has(block.call_id)) continue;
        out.push(toolResultMessageForPrompt(block.call_id, callNames.get(block.call_id), block.output));
      }
    }
  }
  return { messages: out, truncated, summaryText, omittedAttachments };
}

/** Attachment blocks in stored order — which is the order they were sent in,
 * and the order they must reach the model in. */
function attachmentsOf(blocks: ContentBlock[]): AttachmentRef[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { kind: "attachment" }> => b.kind === "attachment")
    .map((b) => ({ ref: b.ref, mime: b.mime, ...(b.name === undefined ? {} : { name: b.name }) }));
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}

/**
 * Writes a truncated document's full extracted text into the conversation's
 * sandbox, if one is already running — see hasActiveSandbox/attachActiveSandbox
 * for why this never creates one. Both chat and agent share this tool loop
 * and can each have a sandbox, so the gate is "is one already live", not
 * which surface this run is.
 *
 * Uses writeFileBinary, not writeFile: the container provider's writeFile
 * passes its payload as a bash argv element, which a multi-megabyte document
 * (now that extraction caches up to MAX_CACHED_EXTRACTION_BYTES) would blow
 * past ARG_MAX on. writeFileBinary streams over stdin instead.
 */
async function writeOverflowToSandbox(
  convId: string,
  a: AttachmentRef,
  fullText: string,
): Promise<string | null> {
  if (!hasActiveSandbox(convId)) return null;
  try {
    const handle = await attachActiveSandbox(convId);
    if (!handle) return null;
    // Not into a local workspace. Its workdir is a folder the user chose in
    // their own repository (a container-isolated one mounts that same folder
    // at the workdir), and nothing ever cleans these up — stop() and
    // destroy() never touch the user's filesystem — so an `attachments/`
    // directory of extracted text would accumulate in a real checkout, where
    // it shows up in `git status` and can end up committed.
    if (handle.provider === "executor") return null;
    // This file's content is the extracted text, not the original bytes — a
    // PDF's overflow file is plain text, not a PDF. Stripping the original
    // extension before appending ".txt" keeps that honest (report.pdf ->
    // report.txt) and, as a side effect, avoids a doubled extension for a
    // source that was already named "*.txt".
    const baseName = sanitizeFilename(a.name ?? "file").replace(/\.[^./]+$/, "");
    const relPath = `attachments/${a.ref.slice(0, 8)}-${baseName}.txt`;
    // Written once per (sandbox, ref), not once per turn. loadHistory runs
    // before every model call, so without this a conversation carrying one
    // overflowing document would base64 and re-stream its whole cached text
    // (up to MAX_CACHED_EXTRACTION_BYTES, ~5.3 MB on the wire) into the
    // container on every single turn, for the life of the conversation. The
    // content is immutable — keyed on a.ref, and the sidecar never changes —
    // so re-writing it can only ever reproduce the same bytes.
    if (hasOverflowWrite(handle.ref, a.ref)) return `./${relPath}`;
    await handle.writeFileBinary(`${handle.workdir}/${relPath}`, Buffer.from(fullText, "utf8"));
    markOverflowWritten(handle.ref, a.ref);
    return `./${relPath}`;
  } catch {
    // Writing the overflow is a nicety, not a requirement — a failure here
    // (sandbox mid-stop, disk full) must degrade to the pathless note, never
    // fail the run.
    return null;
  }
}

