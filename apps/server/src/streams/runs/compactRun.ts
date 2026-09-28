import { v4 as uuid } from "uuid";
import { db, desc, eq } from "@loxaic/db";
import { conversations, messages, usageRecords } from "@loxaic/db/schema";
import {
  DEFAULT_PROVIDER_ID,
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
import { estimateTokens, summaryMessage, tallyChatMessages } from "../../inference/context.ts";
import { fingerprintPrompt, measureReuse } from "../../inference/prompt-reuse.ts";
import { assertConversationAccess } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { acquireRunSlot, type RunSlot } from "../../inference/scheduler.ts";
import { announceNewRun } from "../watchers.ts";
import { loadHistory, HISTORY_LIMIT, promptProgressEmitter, promptStatsFor } from "./engine.ts";
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
}): { messages: ChatMessage[]; tools?: OpenAiTool[]; toolChoice?: "none"; reusesPrefix: boolean } {
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
      reusesPrefix: true,
    };
  }
  return {
    messages: [...summary, ...stripImagesForCompaction(history.messages), instruction],
    reusesPrefix: false,
  };
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
   * subtracts it. */
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
  const history = await loadHistory(convId, { forCompaction: true });
  const historyLimit = HISTORY_LIMIT;
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
    const skipLamport = Date.now();
    await db.insert(messages).values({
      id: summaryMsgId,
      conversationId: convId,
      parentId,
      authorType: "summary",
      origin: "server",
      lamport: skipLamport,
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
      lamport: skipLamport,
    });
    producer.emit({ kind: "compaction", message_id: summaryMsgId, ...stats });
    producer.emit({ kind: "message.end", message_id: summaryMsgId, status: "complete" });
    await producer.end("complete");
    return { streamId, conversationId: convId, summaryMessageId: summaryMsgId };
  }

  // ── Real compaction ───────────────────────────────────────
  const summaryLamport = Date.now();
  await db.insert(messages).values({
    id: summaryMsgId,
    conversationId: convId,
    parentId,
    authorType: "summary",
    origin: "server",
    model,
    lamport: summaryLamport,
    content: [{ kind: "text", text: "" }],
    status: "streaming",
    createdAt: new Date(),
  });

  const streamId = uuid();
  const producer = await broker.openProducer({ streamId, conversationId: convId, userId, surface });
  producer.emit({
    kind: "message.start",
    message_id: summaryMsgId,
    author_type: "summary",
    parent_id: parentId,
    lamport: summaryLamport,
    model,
  });

  const abort = new AbortController();
  registerRun({ streamId, conversationId: convId, userId, abort, approvals: new Map() });
  announceNewRun(convId, streamId);

  // The conversation as its last run sent it, with the summarisation
  // instruction as the final user turn — see compactionRequest.
  const instruction = buildInstruction(guidance);
  const before = await lastTurnTokens(convId);
  const window = await resolveWindow(model).catch(() => null);
  const hasRoom =
    window == null ||
    before == null ||
    before + estimateTokens("current", instruction) + summaryHeadroomTokens(window) <= window;
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
    before,
    instruction,
    guidance,
    messagesCompacted: count + (hasSummary ? 1 : 0),
    historyLimit,
    auto: input.auto ?? false,
  });

  return { streamId, conversationId: convId, summaryMessageId: summaryMsgId };
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

async function runCompactGeneration(ctx: {
  streamId: string;
  convId: string;
  userId: string;
  summaryMsgId: string;
  model: string;
  abort: AbortController;
  producer: StreamProducer;
  request: ReturnType<typeof compactionRequest>;
  /** The last turn's prompt + completion, read before this call records its own. */
  before: number | null;
  instruction: string;
  guidance?: string;
  messagesCompacted: number;
  historyLimit: number;
  auto: boolean;
}): Promise<void> {
  const { streamId, convId, userId, summaryMsgId, model, abort, producer } = ctx;
  let summaryText = "";

  // Same shape as chatRun: the pre-generation window read is the model's max
  // if a JIT load is about to happen, so re-resolve afterwards.
  let windowTokens: number | null = null;
  let jitLoaded = false;
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

    let reportProgress = false;
    try {
      // This model's own provider only — see the same lookup in engine.ts.
      const info = await modelRunInfo(model);
      windowTokens = info?.windowTokens ?? null;
      reportProgress = info?.nativeRuntime ?? false;
      if (info && !info.loaded) {
        jitLoaded = true;
        producer.emit({ kind: "model.loading", message_id: summaryMsgId });
      }
    } catch {
      // Best-effort — the generic indicator covers it.
    }

    const before = ctx.before;
    const { messages: promptMessages, tools, toolChoice } = ctx.request;

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

    let doneResult: CompletionResult | null = null;
    // The same split the engine makes: only what the stream throws is stored
    // as the reason. This try also spans database writes whose errors are ours.
    for await (const event of markBackendErrors(
      streamCompletion(model, promptMessages, {
        signal: abort.signal,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { toolChoice } : {}),
        reportProgress,
      }),
    )) {
      if (event.type === "delta") {
        summaryText += event.content;
        producer.emit({ kind: "text.delta", message_id: summaryMsgId, text: event.content });
      } else if (event.type === "progress") {
        emitProgress(event.progress);
      } else if (event.type === "done") {
        doneResult = event.result;
      }
      // Thinking deltas are dropped: the summary is the deliverable, and
      // replaying reasoning into the card (or the log) buys nothing.
    }

    if (jitLoaded) {
      invalidateBackendModels(await resolveModelRef(model).then((r) => r.provider.id).catch(() => undefined));
      windowTokens = (await resolveWindow(model)) ?? windowTokens;
    }

    const compaction = computeCompactionStats({
      messagesCompacted: ctx.messagesCompacted,
      lastTurnTokens: before,
      promptTokens: doneResult?.usage.prompt_tokens ?? 0,
      completionTokens: doneResult?.usage.completion_tokens ?? 0,
      instructionTokens: estimateTokens("current", ctx.instruction),
      summaryText,
      guidance: ctx.guidance,
      auto: ctx.auto,
    });

    // The breakdown describes the window AFTER compaction — the summary is
    // now the entire replayed context. Without this, the ring would jump UP
    // after compacting: the compact call's own prompt_tokens is the whole
    // pre-compaction history.
    const postBreakdown: ContextBreakdown = {
      used_tokens: compaction.after_tokens,
      parts: [{ category: "summary", tokens: compaction.after_tokens }],
      history_messages: 0,
      history_limit: ctx.historyLimit,
      history_truncated: false,
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

    await db
      .update(messages)
      .set({
        content: [
          { kind: "text", text: summaryText },
          { kind: "compaction", ...compaction },
        ] as ContentBlock[],
        status: "complete",
      })
      .where(eq(messages.id, summaryMsgId));
    await db
      .update(conversations)
      .set({ activeLeafId: summaryMsgId, updatedAt: new Date() })
      .where(eq(conversations.id, convId));
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
    await producer.end("complete", { usage });
  } catch (err) {
    const isAbort = (err as Error).name === "AbortError" || abort.signal.aborted;
    const status = isAbort ? "cancelled" : "error";
    const eventError = isAbort ? undefined : turnErrorText(err, `compaction failed in ${convId}`);

    // A partial summary must never be mistaken for a compaction point, so it
    // is persisted with a non-complete status — which the loaders' summary
    // lookup already excludes. The reason is kept for the same reload the
    // chat engine's is, and the client's CompactionCard renders it as a
    // failed card: without that a failed summary row reloaded as a card
    // spinning on "Compacting…" forever.
    await db
      .update(messages)
      .set({ content: [{ kind: "text", text: summaryText }], status, error: eventError ?? null })
      .where(eq(messages.id, summaryMsgId))
      .catch(() => undefined);

    producer.emit({ kind: "message.end", message_id: summaryMsgId, status, error: eventError });
    await producer.end(status, { error: eventError }).catch(() => undefined);
  } finally {
    slot?.release();
    unregisterRun(streamId);
  }
}
