import { v4 as uuid } from "uuid";
import { db, desc, eq } from "@loxaic/db";
import { conversations, messages, usageRecords } from "@loxaic/db/schema";
import type { CompactionStats, ContentBlock, ContextBreakdown, TurnUsage } from "@loxaic/types";
import { streamCompletion, textOfContent, type ChatMessage, type CompletionResult } from "../../inference/provider.ts";
import { invalidateBackendModels, listBackendModels, resolveWindow } from "../../inference/models.ts";
import { estimateTokens, summaryMessage } from "../../inference/context.ts";
import { assertConversationAccess } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { acquireRunSlot, type RunSlot } from "../../inference/scheduler.ts";
import { announceNewRun } from "../watchers.ts";
import { loadHistory, HISTORY_LIMIT } from "./engine.ts";

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

  if (getRunByConversation(convId)) {
    throw new Error("A response is already in progress for this conversation");
  }

  // Both surfaces now share one loader (tool turns included), so what gets
  // compacted is exactly what the next prompt would have replayed — starting
  // at any previous summary, which is what makes repeat compaction correct,
  // not cumulative.
  const history = await loadHistory(convId);
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
    await db.insert(messages).values({
      id: summaryMsgId,
      conversationId: convId,
      parentId,
      authorType: "summary",
      origin: "server",
      lamport: Date.now(),
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
    producer.emit({ kind: "message.start", message_id: summaryMsgId, author_type: "summary", parent_id: parentId });
    producer.emit({ kind: "compaction", message_id: summaryMsgId, ...stats });
    producer.emit({ kind: "message.end", message_id: summaryMsgId, status: "complete" });
    await producer.end("complete");
    return { streamId, conversationId: convId, summaryMessageId: summaryMsgId };
  }

  // ── Real compaction ───────────────────────────────────────
  await db.insert(messages).values({
    id: summaryMsgId,
    conversationId: convId,
    parentId,
    authorType: "summary",
    origin: "server",
    model,
    lamport: Date.now(),
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
    model,
  });

  const abort = new AbortController();
  registerRun({ streamId, conversationId: convId, userId, abort, approvals: new Map() });
  announceNewRun(convId, streamId);

  // The conversation as the surface would send it, with the summarisation
  // instruction as the final user turn. No agent system prompt and no tools:
  // this call summarises the conversation, it doesn't continue the loop.
  const instruction = buildInstruction(guidance);
  const textOnlyHistory: ChatMessage[] = stripImagesForCompaction(history.messages);
  const promptMessages: ChatMessage[] = [
    ...(history.summaryText ? [summaryMessage(history.summaryText)] : []),
    ...textOnlyHistory,
    { role: "user", content: instruction },
  ];

  void runCompactGeneration({
    streamId,
    convId,
    userId,
    summaryMsgId,
    model,
    abort,
    producer,
    promptMessages,
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
  promptMessages: ChatMessage[];
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

    try {
      const backendModels = await listBackendModels();
      const targetModel = backendModels.find((m) => m.id === model);
      windowTokens = targetModel?.loaded_context_tokens ?? targetModel?.context_tokens ?? null;
      if (targetModel && !targetModel.loaded) {
        jitLoaded = true;
        producer.emit({ kind: "model.loading", message_id: summaryMsgId });
      }
    } catch {
      // Best-effort — the generic indicator covers it.
    }

    // Read before generating: the compact call is about to write its own
    // usage record, which must not become its own "before".
    const before = await lastTurnTokens(convId);

    let doneResult: CompletionResult | null = null;
    for await (const event of streamCompletion(model, ctx.promptMessages, { signal: abort.signal })) {
      if (event.type === "delta") {
        summaryText += event.content;
        producer.emit({ kind: "text.delta", message_id: summaryMsgId, text: event.content });
      } else if (event.type === "done") {
        doneResult = event.result;
      }
      // Thinking deltas are dropped: the summary is the deliverable, and
      // replaying reasoning into the card (or the log) buys nothing.
    }

    if (jitLoaded) {
      invalidateBackendModels();
      windowTokens = (await resolveWindow(model)) ?? windowTokens;
    }

    const stats = computeCompactionStats({
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
      used_tokens: stats.after_tokens,
      parts: [{ category: "summary", tokens: stats.after_tokens }],
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
          { kind: "compaction", ...stats },
        ] as ContentBlock[],
        status: "complete",
      })
      .where(eq(messages.id, summaryMsgId));
    await db
      .update(conversations)
      .set({ activeLeafId: summaryMsgId, updatedAt: new Date() })
      .where(eq(conversations.id, convId));
    if (doneResult && (doneResult.usage.total_tokens > 0 || doneResult.timings)) {
      await db.insert(usageRecords).values({
        id: uuid(),
        userId,
        conversationId: convId,
        messageId: summaryMsgId,
        model,
        origin: "server",
        inputTokens: doneResult.usage.prompt_tokens,
        cachedTokens: doneResult.cachedTokens,
        outputTokens: doneResult.usage.completion_tokens,
        ttftMs: doneResult.ttftMs,
        promptMs: doneResult.timings?.prompt_ms ?? null,
        predictMs: doneResult.timings?.predicted_ms ?? null,
        totalMs: doneResult.totalMs,
        promptTps: doneResult.promptTps,
        predictedTps: doneResult.genTps,
        contextBreakdown: postBreakdown,
      });
    }

    producer.emit({ kind: "compaction", message_id: summaryMsgId, ...stats });
    producer.emit({ kind: "message.end", message_id: summaryMsgId, status: "complete", usage });
    await producer.end("complete", { usage });
  } catch (err) {
    const isAbort = (err as Error).name === "AbortError" || abort.signal.aborted;
    const status = isAbort ? "cancelled" : "error";
    const errorMessage = (err as Error).message;

    // A partial summary must never be mistaken for a compaction point, so it
    // is persisted with a non-complete status — which the loaders' summary
    // lookup already excludes.
    await db
      .update(messages)
      .set({ content: [{ kind: "text", text: summaryText }], status })
      .where(eq(messages.id, summaryMsgId))
      .catch(() => undefined);

    const eventError = isAbort ? undefined : errorMessage;
    producer.emit({ kind: "message.end", message_id: summaryMsgId, status, error: eventError });
    await producer.end(status, { error: eventError }).catch(() => undefined);
  } finally {
    slot?.release();
    unregisterRun(streamId);
  }
}
