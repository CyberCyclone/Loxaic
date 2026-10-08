import { v4 as uuid } from "uuid";
import { and, db, desc, eq, ne } from "@loxaic/db";
import { conversations, messages, usageRecords } from "@loxaic/db/schema";
import {
  COMPACTION_CONTINUE_NUDGE,
  DEFAULT_PROVIDER_ID,
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  type CompactionStats,
  type ContentBlock,
  type ContextBreakdown,
  type TurnUsage,
} from "@loxaic/types";
import {
  streamCompletion,
  textOfContent,
  type ChatMessage,
  type CompletionResult,
  type OpenAiTool,
} from "../../inference/provider.ts";
import { invalidateBackendModels, modelRunInfo, resolveWindow } from "../../inference/models.ts";
import { assertModelUsable, resolveModelRef } from "../../inference/providers.ts";
import { estimateTallyTokens, estimateTokens, summaryMessage, tallyChatMessages } from "../../inference/context.ts";
import { thinkingFields } from "../../inference/thinking.ts";
import { fingerprintPrompt, measureReuse } from "../../inference/prompt-reuse.ts";
import { assertConversationAccess } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { acquireRunSlot, type RunSlot } from "../../inference/scheduler.ts";
import { announceNewRun } from "../watchers.ts";
import { loadHistory, promptProgressEmitter, promptStatsFor } from "./engine.ts";
import { lastRequestShape, type RequestShape } from "./request-shape.ts";
import { usageRecordValues } from "./usage-record.ts";
import { markBackendErrors, turnErrorText } from "../error-text.ts";

/**
 * `/compact`: summarise the conversation into a `summary` message and continue
 * from it. Runs as a stream run exactly like chat — durable log, catch-up,
 * the per-conversation lock, multi-device fan-out — because it *is* a turn,
 * just one whose output is a summary instead of a reply.
 *
 * Nothing is deleted or hidden. Every message stays in Postgres and on
 * screen; the only thing that changes is where the history loaders start.
 */

/**
 * Mirrors Claude Code's compaction format: a structured document with fixed
 * sections. The structure is what makes full replacement safe — in particular
 * "all user messages", which exists precisely because no verbatim tail
 * survives.
 */
const COMPACT_INSTRUCTION = [
  "Summarize this conversation into a single structured document. The summary will REPLACE the",
  "conversation history in future prompts, so it must carry everything needed to continue the work",
  "seamlessly — err on the side of including technical detail rather than dropping it.",
  "",
  "Use exactly these sections:",
  "1. Primary Request and Intent — what the user is trying to achieve, in detail.",
  "2. Key Technical Concepts — technologies, approaches, and decisions in play.",
  "3. Files and Code Sections — specific files, functions, and code discussed, with the important fragments.",
  "4. Errors and Fixes — problems hit and how they were resolved, including feedback given.",
  "5. Problem Solving — what has been solved and any ongoing troubleshooting.",
  "6. All User Messages — every user message so far, condensed but none omitted.",
  "7. Pending Tasks — what was asked for but not yet done.",
  "8. Current Work — precisely what was in progress at the point of this summary.",
  "9. Optional Next Step — the immediate next action, only if one clearly follows from the above.",
  "",
  "Weight recency. The most recent exchanges are what the work is actually standing on, so keep",
  "them in near-full detail — exact file paths, function names, error text, numbers, and whatever",
  "was mid-flight. Compress older material harder the further back it goes, down to the decisions",
  "and conclusions that still constrain the work. Section 6 is the exception and stays exhaustive:",
  "every user message must appear, however tersely, because nothing else survives verbatim.",
  "",
  "Leave out the <project-instructions-update> notices: after this summary the system prompt carries",
  "the project's current instructions, so a copy here would only repeat them in a lossier form.",
  "",
  "Respond with ONLY the summary document. No preamble, no commentary, no questions.",
].join("\n");

/** How the user's steering text is framed: as instructions about the summary,
 * clearly separated so it can't read as conversation content to summarise. */
function buildInstruction(guidance: string | undefined): string {
  if (!guidance) return COMPACT_INSTRUCTION;
  return `${COMPACT_INSTRUCTION}\n\nAdditional instructions from the user for this summary — follow them when deciding what to emphasise or include:\n${guidance}`;
}

/**
 * Images don't need to survive compaction — the summary is a text document,
 * and sending them would risk the call failing on a non-vision model for no
 * benefit. Collapses any image-carrying user turn back to its text; every
 * other message is untouched. Pure and exported for tests, same as
 * computeCompactionStats below.
 */
export function stripImagesForCompaction(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "user" && Array.isArray(m.content) ? { ...m, content: textOfContent(m.content) } : m,
  );
}

/** Room a summary needs after the prompt: a quarter of the window, up to
 * 8k tokens. A compaction that reuses the conversation's prefix sends the
 * whole of it, system prompt and tools included, so it must still leave this
 * much for the reply — scaled, so a small window is not ruled out entirely. */
export function summaryHeadroomTokens(windowTokens: number): number {
  return Math.min(8192, Math.floor(windowTokens / 4));
}

/** A compaction that produced no summary text: stored with its own reason. */
class EmptySummaryError extends Error {}

/**
 * What a compaction sends.
 *
 * When this process still has the conversation's last request shape for the
 * same model, and the window has room for a summary after it, the request is
 * that run's own front — its system prompt and tool schemas — then the history
 * exactly as the next turn would replay it, then the instruction as the final
 * user turn. That is a strict extension of the last request, so a backend with
 * a prefix cache (llama.cpp, LM Studio, and hosted providers' own caching)
 * reads only the instruction. Tools stay in with `tool_choice: "none"`, as an
 * "answer now" does: dropping them would rewrite the front. Images stay in for
 * the same reason, and the same model already read them.
 *
 * Otherwise — a different model, no shape after a restart, or a window too
 * full — it falls back to the request compaction always made: no system
 * prompt, no tools, images collapsed to their text.
 */
export function compactionRequest(input: {
  shape: RequestShape | undefined;
  model: string;
  history: { messages: ChatMessage[]; summaryText: string | null };
  instruction: string;
  hasRoom: boolean;
}): {
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  toolChoice?: "none";
  /** The last run's thinking fields, when its front is reused: llama.cpp
   * renders the level into the system prompt, so a different one would
   * diverge from the cache at the first message. Absent otherwise. */
  thinking?: Record<string, unknown>;
  reusesPrefix: boolean;
} {
  const { shape, history } = input;
  const summary = history.summaryText ? [summaryMessage(history.summaryText)] : [];
  const instruction: ChatMessage = { role: "user", content: input.instruction };
  if (shape?.model === input.model && input.hasRoom) {
    return {
      messages: [
        ...(shape.system ? [{ role: "system", content: shape.system } as ChatMessage] : []),
        ...summary,
        ...history.messages,
        instruction,
      ],
      ...(shape.tools.length ? { tools: shape.tools, toolChoice: "none" as const } : {}),
      thinking: shape.thinking,
      reusesPrefix: true,
    };
  }
  return {
    messages: [...summary, ...stripImagesForCompaction(history.messages), instruction],
    reusesPrefix: false,
  };
}

/**
 * Whether the conversation's own request, plus the instruction, leaves room for
 * a summary. Both figures have to be known: without the last turn's size or the
 * window there is no telling, and the stripped request is the one more likely
 * to fit. That costs a cache miss on a cold thread rather than a compaction the
 * window cannot hold. It also keeps `computeCompactionStats`' fallback honest:
 * an unknown `before` always means the stripped request, whose prompt minus the
 * instruction really is the conversation.
 */
export function compactionHasRoom(input: {
  windowTokens: number | null;
  before: number | null;
  instructionTokens: number;
}): boolean {
  const { windowTokens, before } = input;
  if (windowTokens == null || before == null) return false;
  return before + input.instructionTokens + summaryHeadroomTokens(windowTokens) <= windowTokens;
}

/**
 * The savings arithmetic, pure and exported for tests.
 *
 * `after` is the backend's own completion count for the summary — exact.
 * `before` is the last recorded turn's prompt + completion: exactly what the
 * next prompt would have replayed, and exactly the figure the context ring
 * was showing. When either term had to be estimated (no usage record to read
 * `before` from; a backend that reported no completion count), the flag says
 * so and the UI renders a `~` instead of passing an estimate off as fact.
 */
export function computeCompactionStats(input: {
  messagesCompacted: number;
  /** prompt + completion of the conversation's newest usage record, or null
   * when there is none to read (cold thread). */
  lastTurnTokens: number | null;
  /** The compact call's own reported usage. */
  promptTokens: number;
  completionTokens: number;
  /** Estimated cost of the instruction we appended — it was in the compact
   * call's prompt but was never part of the conversation, so the fallback
   * subtracts it. The fallback only runs when `lastTurnTokens` is unknown, and
   * then the request was always the stripped one (`compactionHasRoom`): no
   * system prompt or tool schemas to subtract as well. */
  instructionTokens: number;
  summaryText: string;
  guidance?: string;
  auto?: boolean;
}): CompactionStats {
  const afterEstimated = input.completionTokens <= 0;
  const after = afterEstimated ? estimateTokens("summary", input.summaryText) : input.completionTokens;
  const { lastTurnTokens } = input;
  const beforeEstimated = lastTurnTokens == null;
  const before = beforeEstimated
    ? Math.max(0, input.promptTokens - input.instructionTokens)
    : lastTurnTokens;
  return {
    messages_compacted: input.messagesCompacted,
    before_tokens: before,
    after_tokens: after,
    saved_tokens: Math.max(0, before - after),
    before_estimated: beforeEstimated || afterEstimated,
    ...(input.guidance ? { guidance: input.guidance } : {}),
    ...(input.auto ? { auto: true } : {}),
  };
}

/** A conversation's history in pieces that each fit one summarising request.
 *
 * A compaction request is the history plus the instruction, so a history
 * larger than the window cannot be summarised in one request. That used to be
 * unreachable — the replay was cut to the newest 50–74 rows first — and is now
 * the ordinary case for every long thread from before history stopped being
 * dropped, and for any run one huge tool result pushed over. So the history is
 * summarised oldest-first in parts, each request carrying the summary so far.
 *
 * A part never separates an assistant's tool calls from their results: a
 * `role: "tool"` message whose call is in another request is one most
 * backends reject. A single message larger than a part — its text, or its tool
 * calls' arguments — is cut down inside the request only, with a marker saying
 * so; the stored row is untouched.
 *
 * Pure and exported for tests.
 */
export function summaryParts(messages: ChatMessage[], budgetTokens: number): ChatMessage[][] {
  // Units: an assistant message with tool calls together with the results that
  // follow it, every other message alone.
  const units: ChatMessage[][] = [];
  for (const m of messages) {
    const open = units.at(-1);
    if (m.role === "tool" && open?.[0]?.role === "assistant" && open[0].tool_calls?.length) open.push(m);
    else units.push([m]);
  }
  const parts: ChatMessage[][] = [];
  let part: ChatMessage[] = [];
  let used = 0;
  const budget = Math.max(1, budgetTokens);
  for (const unit of units) {
    const size = unit.reduce((sum, m) => sum + messageTokens(m), 0);
    if (part.length && used + size > budget) {
      parts.push(part);
      part = [];
      used = 0;
    }
    if (size > budget) {
      // Alone and still too large: shared out between its messages.
      const each = Math.max(1, Math.floor(budget / unit.length));
      parts.push(unit.map((m) => fitMessage(m, each)));
      continue;
    }
    part.push(...unit);
    used += size;
  }
  if (part.length) parts.push(part);
  return parts;
}

function messageTokens(m: ChatMessage): number {
  return estimateTallyTokens(tallyChatMessages([m]));
}

/** Said in place of what was cut from a message too large for one request. */
export const SUMMARY_CUT_MARKER = "\n\n[… cut here: too long to summarise in one request …]";

/**
 * A message cut down to at most `tokens`, each piece kept from its start: the
 * text, and every tool call's arguments. Arguments are what make an agent's
 * message large (an `fs_write` carries the whole file), so cutting only the
 * text left such a message over budget and its summary unable to run. A cut
 * argument becomes a small JSON object holding the start of the original, so
 * it still parses — templates parse arguments — and says it was cut. The
 * call's id and name stay, so its results still pair with it.
 */
function fitMessage(m: ChatMessage, tokens: number): ChatMessage {
  if (messageTokens(m) <= tokens) return m;
  const text = textOfContent(m.content ?? "");
  const calls = m.role === "assistant" ? (m.tool_calls ?? []) : [];
  // Characters per token as the estimate counts them, shared equally between
  // the pieces; escaping and the call's own fields can still push it over,
  // so the share shrinks until it fits.
  let share = Math.floor((tokens * 3) / (1 + calls.length));
  for (;;) {
    const keep = Math.max(0, share - SUMMARY_CUT_MARKER.length);
    const content = text.length > share ? text.slice(0, keep) + SUMMARY_CUT_MARKER : text;
    const fitted: ChatMessage =
      m.role === "assistant"
        ? {
            ...m,
            content: m.content === null && !content ? null : content,
            ...(calls.length
              ? {
                  tool_calls: calls.map((c) =>
                    c.function.arguments.length > share
                      ? {
                          ...c,
                          function: {
                            ...c.function,
                            arguments: JSON.stringify({ cut: c.function.arguments.slice(0, keep) + SUMMARY_CUT_MARKER }),
                          },
                        }
                      : c,
                  ),
                }
              : {}),
          }
        : { ...m, content };
    if (share <= 0 || messageTokens(fitted) <= tokens) return fitted;
    share = Math.floor(share * 0.8);
  }
}

export interface StartCompactRunResult {
  streamId: string;
  conversationId: string;
  summaryMessageId: string;
}

export async function startCompactRun(input: {
  userId: string;
  conversationId: string;
  model: string;
  args?: string;
  surface: "chat" | "agent";
  /** Set by the engine's threshold check, not by any client command. */
  auto?: boolean;
}): Promise<StartCompactRunResult> {
  const { userId, conversationId: convId, model, surface } = input;
  const guidance = input.args?.trim();
  const broker = getStreamBroker();

  // /compact rewrites the conversation's replayed history, so it is an
  // editor action rather than a reader's convenience.
  await assertConversationAccess(userId, convId, "editor");

  // Before the summary row is inserted: a compaction that cannot reach a
  // backend must not leave a `streaming` summary in the transcript. Automatic
  // compaction inherits the turn's model, so this only fires when the provider
  // went away between that turn and this one.
  await assertModelUsable(model);

  if (getRunByConversation(convId)) {
    throw new Error("A response is already in progress for this conversation");
  }

  // Both surfaces now share one loader (tool turns included), so what gets
  // compacted is exactly what the next prompt would have replayed — starting
  // at any previous summary, which is what makes repeat compaction correct,
  // not cumulative.
  // Instructions notices included: the compaction request replays the history
  // exactly as the last run sent it (see compactionRequest), and leaving them
  // out would break the cached prefix at the first one. The instruction keeps
  // them out of the summary instead.
  const history = await loadHistory(convId);
  const hasSummary = !!history.summaryText;
  const count = history.messages.length;

  // ── No-op guard: refuse without calling the model ─────────
  // The card still lands in the transcript (and in Postgres) so it survives a
  // reload and reads the same on every device — but it costs zero tokens to
  // produce.
  const skipped: CompactionStats["skipped"] | null =
    hasSummary && count === 0 ? "already_compacted" : count < 2 ? "too_short" : null;

  const summaryMsgId = uuid();
  const parentId = await currentLeafId(convId);
  // After every row the conversation already has, whatever clock wrote them:
  // the summary is a cutoff by lamport, and one that sorted before the run's
  // last tool row would replay that row after it (see nextConversationLamport).
  const summaryLamport = await nextConversationLamport(convId);

  if (skipped) {
    const stats: CompactionStats = {
      messages_compacted: 0,
      before_tokens: 0,
      after_tokens: 0,
      saved_tokens: 0,
      before_estimated: false,
      skipped,
      ...(input.auto ? { auto: true } : {}),
    };
    await db.insert(messages).values({
      id: summaryMsgId,
      conversationId: convId,
      parentId,
      authorType: "summary",
      origin: "server",
      lamport: summaryLamport,
      // No text block, deliberately: a textless summary row is what marks a
      // skip card, and the history loader relies on that to never treat one
      // as a compaction cutoff.
      content: [{ kind: "compaction", ...stats }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });

    const streamId = uuid();
    const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface });
    announceNewRun(convId, streamId);
    producer.emit({
      kind: "message.start",
      message_id: summaryMsgId,
      author_type: "summary",
      parent_id: parentId,
      lamport: summaryLamport,
    });
    producer.emit({ kind: "compaction", message_id: summaryMsgId, ...stats });
    producer.emit({ kind: "message.end", message_id: summaryMsgId, status: "complete" });
    await producer.end("complete");
    return { streamId, conversationId: convId, summaryMessageId: summaryMsgId };
  }

  // ── Real compaction ───────────────────────────────────────
  const streamId = uuid();
  const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface });
  await openSummaryRow({ convId, summaryMsgId, parentId, lamport: summaryLamport, model, producer });

  const abort = new AbortController();
  registerRun({ streamId, conversationId: convId, userId, abort, approvals: new Map(), model });
  announceNewRun(convId, streamId);

  // The conversation as its last run sent it, with the summarisation
  // instruction as the final user turn — see compactionRequest.
  const instruction = buildInstruction(guidance);
  const before = await lastTurnTokens(convId);
  const window = await resolveWindow(model).catch(() => null);
  const hasRoom = compactionHasRoom({
    windowTokens: window,
    before,
    instructionTokens: estimateTokens("current", instruction),
  });
  const request = compactionRequest({ shape: lastRequestShape(convId), model, history, instruction, hasRoom });

  void runCompactGeneration({
    streamId,
    convId,
    userId,
    summaryMsgId,
    model,
    abort,
    producer,
    request,
    history,
    before,
    instruction,
    guidance,
    messagesCompacted: count + (hasSummary ? 1 : 0),
    auto: input.auto ?? false,
  });

  return { streamId, conversationId: convId, summaryMessageId: summaryMsgId };
}

/**
 * A lamport after every row the conversation already has.
 *
 * A summary is a cutoff — the replay starts after its lamport — so it has to
 * sort after everything it summarises. `Date.now()` alone does not promise
 * that: a run's own rows take `monotonicLamport`, which runs ahead of the clock
 * after inserts in the same millisecond, and a client's message can carry a
 * lamport from a clock ahead of ours. A summary that sorted before the run's
 * last tool row would replay that row after it — and, when only one half of a
 * tool exchange landed past the cutoff, an orphan.
 */
export async function nextConversationLamport(convId: string): Promise<number> {
  const rows = await db
    .select({ lamport: messages.lamport })
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.lamport))
    .limit(1);
  const newest = rows.at(0)?.lamport ?? 0;
  return Math.max(Date.now(), newest + 1);
}

/** The newest usage record is what the next prompt would have replayed — and
 * what the context ring was showing. Null when nothing was ever recorded. */
async function lastTurnTokens(convId: string): Promise<number | null> {
  const rows = await db
    .select({ inputTokens: usageRecords.inputTokens, outputTokens: usageRecords.outputTokens })
    .from(usageRecords)
    .where(eq(usageRecords.conversationId, convId))
    .orderBy(desc(usageRecords.createdAt))
    .limit(1);
  // `.at(0)` rather than destructuring `[row]`: TS types array destructuring
  // as always-defined here, but `.limit(1)` doesn't guarantee a row exists
  // (a conversation with no usage yet gets none) — `.at()` keeps that
  // `| undefined` honest so the check below isn't type-checked away.
  const row = rows.at(0);
  return row ? row.inputTokens + row.outputTokens : null;
}

async function currentLeafId(convId: string): Promise<string | null> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, convId),
    columns: { activeLeafId: true },
  });
  return conv?.activeLeafId ?? null;
}

/** The summary row, streaming and empty, and the event that puts its card on screen. */
async function openSummaryRow(input: {
  convId: string;
  summaryMsgId: string;
  parentId: string | null;
  lamport: number;
  model: string;
  producer: StreamProducer;
}): Promise<void> {
  await db.insert(messages).values({
    id: input.summaryMsgId,
    conversationId: input.convId,
    parentId: input.parentId,
    authorType: "summary",
    origin: "server",
    model: input.model,
    lamport: input.lamport,
    content: [{ kind: "text", text: "" }],
    status: "streaming",
    createdAt: new Date(),
  });
  input.producer.emit({
    kind: "message.start",
    message_id: input.summaryMsgId,
    author_type: "summary",
    parent_id: input.parentId,
    lamport: input.lamport,
    model: input.model,
  });
}

interface GeneratedSummary {
  summaryText: string;
  /** The last request's result: the summary's own usage. */
  doneResult: CompletionResult | null;
  windowTokens: number | null;
  /** What the history cost to read, when it was read in parts: the parts'
   * prompts less what each carried that was not the conversation. Null for a
   * single request, whose own prompt the stats already read. */
  partsPromptTokens: number | null;
}

/**
 * Generates a summary on the caller's stream, for the summary row already
 * opened. Takes no inference slot and registers no run: a compaction of its
 * own holds both, and one inside a run already does.
 */
async function generateSummary(input: {
  convId: string;
  summaryMsgId: string;
  model: string;
  signal: AbortSignal;
  producer: StreamProducer;
  request: ReturnType<typeof compactionRequest>;
  history: { messages: ChatMessage[]; summaryText: string | null };
  instruction: string;
}): Promise<GeneratedSummary> {
  const { convId, summaryMsgId, model, producer, signal } = input;
  let windowTokens: number | null = null;
  let jitLoaded = false;
  let reportProgress = false;
  // A stripped request has no prefix to match: it takes the level the
  // conversation's last run recorded, or the default when none did — never
  // the model's own default (Qwen3.8's is its highest).
  let thinking = input.request.thinking;
  const recorded = thinking
    ? null
    : await db
        .select({ level: conversations.thinkingLevel })
        .from(conversations)
        .where(eq(conversations.id, convId))
        .then((rows) => rows.at(0)?.level ?? null)
        .catch(() => null);
  const fallbackLevel = isThinkingLevel(recorded) ? recorded : DEFAULT_THINKING_LEVEL;
  try {
    // This model's own provider only — see the same lookup in engine.ts.
    const info = await modelRunInfo(model);
    windowTokens = info?.windowTokens ?? null;
    reportProgress = info?.nativeRuntime ?? false;
    thinking ??= thinkingFields(info?.thinking, fallbackLevel);
    if (info && !info.loaded) {
      jitLoaded = true;
      producer.emit({ kind: "model.loading", message_id: summaryMsgId });
    }
  } catch {
    // Best-effort — the generic indicator covers it.
  }

  /** One summarising request. `live` streams its text into the card. */
  const ask = async (promptMessages: ChatMessage[], tools: OpenAiTool[] | undefined, toolChoice: "none" | undefined, live: boolean) => {
    // What the prompt is and how much of it the backend already holds, the
    // way the tool loop announces each request — and the backend's measured
    // progress as it reads it. A compaction that re-read 235k tokens used to
    // show a bare spinner for twelve minutes.
    const stats = promptStatsFor({
      messageId: summaryMsgId,
      model,
      tally: tallyChatMessages(promptMessages, tools),
      chatMessages: promptMessages,
      reuse: measureReuse(convId, fingerprintPrompt(model, promptMessages, tools ?? [])),
      windowTokens,
      loadingModel: jitLoaded,
      startedAt: Date.now(),
    });
    producer.emit({ kind: "prompt.stats", ...stats });
    const emitProgress = promptProgressEmitter(stats, (e) => {
      producer.emit(e);
    });
    let text = "";
    let doneResult: CompletionResult | null = null;
    // The same split the engine makes: only what the stream throws is stored
    // as the reason.
    for await (const event of markBackendErrors(
      streamCompletion(model, promptMessages, {
        signal,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { toolChoice } : {}),
        ...(thinking ? { thinking } : {}),
        reportProgress,
      }),
    )) {
      if (event.type === "delta") {
        text += event.content;
        if (live) producer.emit({ kind: "text.delta", message_id: summaryMsgId, text: event.content });
      } else if (event.type === "progress") {
        emitProgress(event.progress);
      } else if (event.type === "done") {
        doneResult = event.result;
      }
      // Thinking deltas are dropped: the summary is the deliverable, and
      // replaying reasoning into the card (or the log) buys nothing.
    }
    if (!text.trim()) {
      // Nothing to replace the history with. Committed as complete, this row
      // would be skipped as a cutoff by loadHistory (it looks for a summary
      // with text), so nothing would be compacted while the card claimed the
      // whole saving — and the next turn would cross the threshold and pay for
      // another compaction. A backend that ignored `tool_choice: "none"` and
      // answered with a call is the likely way here.
      throw new EmptySummaryError(
        doneResult?.toolCalls.length
          ? "The model called a tool instead of writing the summary, so nothing was compacted."
          : "The model returned no summary, so nothing was compacted.",
      );
    }
    return { text, doneResult: doneResult };
  };

  const { request } = input;
  const instructionTokens = estimateTokens("current", input.instruction);
  // The whole history in one request, unless that cannot fit the window: then
  // in parts (summaryParts). Only a stripped request is ever split — one that
  // reuses the conversation's prefix was already judged to fit.
  const parts =
    !request.reusesPrefix && windowTokens != null && estimateTallyTokens(tallyChatMessages(request.messages)) + summaryHeadroomTokens(windowTokens) > windowTokens
      ? summaryParts(
          stripImagesForCompaction(input.history.messages),
          // Room for the instruction, the reply, and the summary so far.
          windowTokens - 2 * summaryHeadroomTokens(windowTokens) - instructionTokens,
        )
      : null;

  let generated: { text: string; doneResult: CompletionResult | null };
  let partsPromptTokens: number | null = null;
  if (parts && parts.length > 1) {
    let running = input.history.summaryText;
    partsPromptTokens = 0;
    generated = { text: "", doneResult: null };
    for (const [i, part] of parts.entries()) {
      const carried = running ? estimateTokens("summary", running) : 0;
      generated = await ask(
        [...(running ? [summaryMessage(running)] : []), ...part, { role: "user", content: input.instruction }],
        undefined,
        undefined,
        i === parts.length - 1,
      );
      partsPromptTokens += Math.max(0, (generated.doneResult?.usage.prompt_tokens ?? 0) - instructionTokens - carried);
      running = generated.text;
    }
  } else {
    generated = await ask(request.messages, request.tools, request.toolChoice, true);
  }

  if (jitLoaded) {
    invalidateBackendModels(await resolveModelRef(model).then((r) => r.provider.id).catch(() => undefined));
    windowTokens = (await resolveWindow(model)) ?? windowTokens;
  }
  return { summaryText: generated.text, doneResult: generated.doneResult, windowTokens, partsPromptTokens };
}

/**
 * Commits a generated summary: the row becomes the compaction point, the
 * conversation's leaf moves to `leafId`, the usage is recorded, and the card
 * gets its stats. Ends the summary message, never the stream — the caller owns
 * that, since a compaction inside a run goes on with the run.
 */
async function commitSummary(input: {
  convId: string;
  userId: string;
  summaryMsgId: string;
  model: string;
  producer: StreamProducer;
  generated: GeneratedSummary;
  before: number | null;
  /** `before` is an estimate rather than a measurement: the card says `~`. */
  beforeEstimated?: boolean;
  instruction: string;
  guidance?: string;
  messagesCompacted: number;
  auto: boolean;
  leafId: string;
  /** A row that only means anything with this summary in front of it (the
   * run's continue nudge), written in the same transaction as the summary's
   * completion: one without the other would leave an unexplained "continue"
   * in the history, replayed on every turn after. */
  follow?: typeof messages.$inferInsert;
}): Promise<TurnUsage | undefined> {
  const { convId, userId, summaryMsgId, model, producer, generated } = input;
  const { summaryText, doneResult, windowTokens } = generated;
  const compaction = computeCompactionStats({
    messagesCompacted: input.messagesCompacted,
    // Read in parts, the conversation's size is what the parts read — when the
    // last turn's own measurement is not there to say it.
    lastTurnTokens: input.before ?? generated.partsPromptTokens,
    promptTokens: doneResult?.usage.prompt_tokens ?? 0,
    completionTokens: doneResult?.usage.completion_tokens ?? 0,
    instructionTokens: estimateTokens("current", input.instruction),
    summaryText,
    guidance: input.guidance,
    auto: input.auto,
  });
  if (input.before == null && generated.partsPromptTokens != null) compaction.before_estimated = true;
  if (input.beforeEstimated) compaction.before_estimated = true;

  // The breakdown describes the window AFTER compaction — the summary is
  // now the entire replayed context. Without this, the ring would jump UP
  // after compacting: the compact call's own prompt_tokens is the whole
  // pre-compaction history.
  const postBreakdown: ContextBreakdown = {
    used_tokens: compaction.after_tokens,
    parts: [{ category: "summary", tokens: compaction.after_tokens }],
    history_messages: 0,
    window_tokens: windowTokens,
  };

  const usage: TurnUsage | undefined = doneResult
    ? {
        prompt_tokens: doneResult.usage.prompt_tokens,
        completion_tokens: doneResult.usage.completion_tokens,
        total_tokens: doneResult.usage.total_tokens,
        prompt_tps: doneResult.promptTps,
        gen_tps: doneResult.genTps,
        total_ms: doneResult.totalMs,
        context: postBreakdown,
      }
    : undefined;

  await db.transaction(async (tx) => {
    if (input.follow) await tx.insert(messages).values(input.follow);
    await tx
      .update(messages)
      .set({
        content: [
          { kind: "text", text: summaryText },
          { kind: "compaction", ...compaction },
        ] as ContentBlock[],
        status: "complete",
      })
      .where(eq(messages.id, summaryMsgId));
    await tx
      .update(conversations)
      .set({ activeLeafId: input.leafId, updatedAt: new Date() })
      .where(eq(conversations.id, convId));
  });
  if (doneResult && (doneResult.usage.total_tokens > 0 || doneResult.timings)) {
    // Best-effort, as the tool loop's is: the summary above is already
    // complete and is the compaction. A usage row that cannot be written is
    // a missing statistic, never a reason to throw the summary away — which
    // is exactly what happened on the beta, twelve minutes of work in.
    await db
      .insert(usageRecords)
      .values(
        usageRecordValues({
          userId,
          conversationId: convId,
          messageId: summaryMsgId,
          model,
          result: doneResult,
          context: postBreakdown,
        }),
      )
      .catch((err: unknown) => {
        console.error(`recording compaction usage failed for ${convId}:`, err);
      });
  }

  producer.emit({ kind: "compaction", message_id: summaryMsgId, ...compaction });
  producer.emit({ kind: "message.end", message_id: summaryMsgId, status: "complete", usage });
  return usage;
}

/**
 * Persists a summary that failed or was stopped, and ends its message. Never
 * the stream: the caller owns that.
 */
async function failSummary(input: {
  convId: string;
  summaryMsgId: string;
  err: unknown;
  signal: AbortSignal;
  producer: StreamProducer;
}): Promise<{ status: "error" | "cancelled"; error: string | undefined }> {
  const { err } = input;
  const isAbort = (err as Error).name === "AbortError" || input.signal.aborted;
  const status = isAbort ? "cancelled" : "error";
  const error = isAbort
    ? undefined
    : err instanceof EmptySummaryError
      ? err.message
      : turnErrorText(err, `compaction failed in ${input.convId}`);

  // A partial summary must never be mistaken for a compaction point, so it
  // is persisted with a non-complete status — which the loaders' summary
  // lookup already excludes. The reason is kept for the same reload the
  // chat engine's is, and the client's CompactionCard renders it as a
  // failed card: without that a failed summary row reloaded as a card
  // spinning on "Compacting…" forever. The text is not kept: a part of a
  // summary read in parts would be the summary of only its oldest part.
  await db
    .update(messages)
    .set({ content: [{ kind: "text", text: "" }], status, error: error ?? null })
    .where(eq(messages.id, input.summaryMsgId))
    .catch(() => undefined);

  input.producer.emit({ kind: "message.end", message_id: input.summaryMsgId, status, error });
  return { status, error };
}

async function runCompactGeneration(ctx: {
  streamId: string;
  convId: string;
  userId: string;
  summaryMsgId: string;
  model: string;
  abort: AbortController;
  producer: StreamProducer;
  request: ReturnType<typeof compactionRequest>;
  history: { messages: ChatMessage[]; summaryText: string | null };
  /** The last turn's prompt + completion, read before this call records its own. */
  before: number | null;
  instruction: string;
  guidance?: string;
  messagesCompacted: number;
  auto: boolean;
}): Promise<void> {
  const { streamId, convId, model, abort, producer } = ctx;
  let slot: RunSlot | null = null;

  try {
    // Compaction is an ordinary inference request and queues like one. It is
    // also the one run a user did not ask for (auto-compaction), so jumping
    // the queue with it would let a background job stall somebody's chat.
    slot = await acquireRunSlot({
      signal: abort.signal,
      onQueued: (position) => { producer.emit({ kind: "run.queued", position }); },
      // The queue belonging to the backend this summary will actually be
      // generated on — not the built-in one, which may be busy with the very
      // conversation being compacted.
      providerId: await resolveModelRef(model)
        .then((r) => r.provider.id)
        .catch(() => DEFAULT_PROVIDER_ID),
    });
    if (!slot) {
      // Stopped while waiting in line. Unlike the engine's equivalent, a row
      // already exists here — the summary was inserted as `streaming` before
      // this function started — so this cannot simply end the stream: the
      // catch below is what persists a terminal status and emits message.end,
      // and without it the thread renders an empty summary bubble stuck
      // mid-stream on every later load.
      throw Object.assign(new Error("compaction was stopped while it waited for an inference slot"), {
        name: "AbortError",
      });
    }

    const generated = await generateSummary({
      convId,
      summaryMsgId: ctx.summaryMsgId,
      model,
      signal: abort.signal,
      producer,
      request: ctx.request,
      history: ctx.history,
      instruction: ctx.instruction,
    });
    const usage = await commitSummary({
      convId,
      userId: ctx.userId,
      summaryMsgId: ctx.summaryMsgId,
      model,
      producer,
      generated,
      before: ctx.before,
      instruction: ctx.instruction,
      guidance: ctx.guidance,
      messagesCompacted: ctx.messagesCompacted,
      auto: ctx.auto,
      leafId: ctx.summaryMsgId,
    });
    await producer.end("complete", { usage });
  } catch (err) {
    const failed = await failSummary({ convId, summaryMsgId: ctx.summaryMsgId, err, signal: abort.signal, producer });
    await producer.end(failed.status, { error: failed.error }).catch(() => undefined);
  } finally {
    slot?.release();
    unregisterRun(streamId);
  }
}

/** What a compaction inside a run leaves the run to continue from. */
export type InRunCompaction =
  | {
      ok: true;
      summaryText: string;
      summaryMsgId: string;
      /** The row the run's next request ends on, after the summary: the
       * message it has yet to answer, or the persisted continue nudge. */
      continueFrom: { id: string; lamport: number; message: ChatMessage };
    }
  /** `stopped`: the run was stopped during it, which the run ends on. */
  | { ok: false; stopped: boolean };

/** A stored row the run has not answered yet: its own user message before
 * the first request, or a nudge it wrote since its last reply. */
export interface UnansweredRow {
  id: string;
  lamport: number;
}

/**
 * Where a summary goes so that `row` stays after it: one below `row`'s
 * lamport, provided nothing else in the conversation is above that. The cutoff
 * is `lamport > summary`, so everything at or below it is summarised and `row`
 * alone is replayed. Null when another row sorts at or above `row` (a client
 * clock ahead of ours can do that), and the caller falls back to summarising
 * everything.
 */
async function cutoffBefore(convId: string, row: UnansweredRow): Promise<{ lamport: number; parentId: string | null } | null> {
  const lamport = row.lamport - 1;
  const [own, other] = await Promise.all([
    db.select({ parentId: messages.parentId }).from(messages).where(eq(messages.id, row.id)).limit(1),
    db
      .select({ lamport: messages.lamport })
      .from(messages)
      .where(and(eq(messages.conversationId, convId), ne(messages.id, row.id)))
      .orderBy(desc(messages.lamport))
      .limit(1),
  ]);
  if (own.length === 0) return null;
  if ((other.at(0)?.lamport ?? 0) > lamport) return null;
  return { lamport, parentId: own[0].parentId };
}

/**
 * Compacts a conversation in the middle of a run, between two of its
 * requests, so the next one fits the window.
 *
 * Under the run, not beside it: on the run's own stream (the card lands in
 * place in the thread), and under the inference slot the run already holds (a
 * compaction queueing for one behind the run that is waiting for it would
 * never start).
 *
 * **A message the run has not answered stays after the summary.** Before a
 * run's first request the replay ends on the person's own new message, and
 * after a check-in or plan nudge it ends on that. Summarised with the rest, it
 * would be answered as a line in a summary, and the model would be told to
 * "continue the task" instead of being asked what the person just asked. So
 * the summary takes the lamport just below that row (`cutoffBefore`) and the
 * run goes on from the row itself, unchanged.
 *
 * Otherwise (the replay ends on a tool result, or no such lamport is free) the
 * summary takes the run's next lamport, after every row it wrote, and is
 * followed by `COMPACTION_CONTINUE_NUDGE`, a persisted user row, so the next
 * request does not end on a system message (several chat templates refuse
 * that) and the run after this one replays the same bytes. The nudge is
 * written in the same transaction that completes the summary.
 *
 * Never throws for the summary's own failure: the failed card is persisted
 * and shown, and `{ ok: false }` lets the run decide whether its request can
 * still be sent.
 */
export async function compactWithinRun(input: {
  convId: string;
  userId: string;
  model: string;
  producer: StreamProducer;
  signal: AbortSignal;
  /** The run's fixed front: what a compaction reusing its prefix sends. */
  shape: RequestShape;
  /** Everything after the system prompt and any summary, as the run holds it. */
  replay: ChatMessage[];
  summaryText: string | null;
  /** The estimated size of the request the run was about to send. An
   * estimate, so the card says `~`; also what judges whether the compaction
   * can reuse the run's prefix. */
  estimate: number | null;
  windowTokens: number | null;
  nextLamport: () => number;
  parentId: string;
  /** The row the replay ends on when the run has not answered it yet. */
  unanswered: UnansweredRow | null;
}): Promise<InRunCompaction> {
  const { convId, model, producer, signal } = input;
  if (input.replay.length < 2) return { ok: false, stopped: false };
  const last = input.replay.at(-1);
  const row = input.unanswered;
  const cutoff = row && last?.role === "user" ? await cutoffBefore(convId, row).catch(() => null) : null;
  const kept = cutoff && row && last ? { ...cutoff, row, message: last } : null;
  const summarised = kept ? input.replay.slice(0, -1) : input.replay;
  const summaryMsgId = uuid();
  const summaryLamport = kept ? kept.lamport : input.nextLamport();
  await openSummaryRow({
    convId,
    summaryMsgId,
    parentId: kept ? kept.parentId : input.parentId,
    lamport: summaryLamport,
    model,
    producer,
  });
  const instruction = buildInstruction(undefined);
  const history = { messages: summarised, summaryText: input.summaryText };
  const hasRoom = compactionHasRoom({
    windowTokens: input.windowTokens,
    before: input.estimate,
    instructionTokens: estimateTokens("current", instruction),
  });
  try {
    const generated = await generateSummary({
      convId,
      summaryMsgId,
      model,
      signal,
      producer,
      request: compactionRequest({ shape: input.shape, model, history, instruction, hasRoom }),
      history,
      instruction,
    });
    // Minted after the summary, so it sorts after it.
    const continueFrom = kept
      ? { id: kept.row.id, lamport: kept.row.lamport, message: kept.message }
      : { id: uuid(), lamport: input.nextLamport(), message: { role: "user", content: COMPACTION_CONTINUE_NUDGE } as ChatMessage };
    await commitSummary({
      convId,
      userId: input.userId,
      summaryMsgId,
      model,
      producer,
      generated,
      before: input.estimate,
      beforeEstimated: input.estimate != null,
      instruction,
      messagesCompacted: summarised.length + (input.summaryText ? 1 : 0),
      auto: true,
      leafId: continueFrom.id,
      ...(kept
        ? {}
        : {
            follow: {
              id: continueFrom.id,
              conversationId: convId,
              parentId: summaryMsgId,
              authorType: "user",
              // Nobody typed it.
              authorUserId: null,
              origin: "server",
              lamport: continueFrom.lamport,
              content: [{ kind: "text", text: COMPACTION_CONTINUE_NUDGE }] as ContentBlock[],
              status: "complete",
              createdAt: new Date(),
            },
          }),
    });
    if (!kept) {
      producer.emit({
        kind: "message.start",
        message_id: continueFrom.id,
        author_type: "user",
        parent_id: summaryMsgId,
        lamport: continueFrom.lamport,
        text: COMPACTION_CONTINUE_NUDGE,
        author_user_id: null,
      });
      producer.emit({ kind: "message.end", message_id: continueFrom.id, status: "complete" });
    }
    return { ok: true, summaryText: generated.summaryText, summaryMsgId, continueFrom };
  } catch (err) {
    const failed = await failSummary({ convId, summaryMsgId, err, signal, producer });
    // A stop is the run's to act on, not a compaction that failed.
    return { ok: false, stopped: failed.status === "cancelled" };
  }
}
