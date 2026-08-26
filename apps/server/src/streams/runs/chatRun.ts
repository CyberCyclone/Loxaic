import { v4 as uuid } from "uuid";
import { and, db, eq, gt } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import type { ContentBlock, TurnUsage } from "@shannon/types";
import { streamCompletion, type ChatMessage, type CompletionResult } from "../../inference/provider.ts";
import { invalidateBackendModels, listBackendModels, resolveWindow } from "../../inference/models.ts";
import { addChars, apportion, SUMMARY_PREAMBLE, summaryMessage, type ContextTally } from "../../inference/context.ts";
import { assertConversationAccess, assertParentInConversation } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";

export interface StartChatRunResult {
  streamId: string;
  conversationId: string;
  userMessageId: string;
  incognito: boolean;
}

export async function startChatRun(input: {
  userId: string;
  content: string;
  model: string;
  conversationId?: string;
  parentId?: string;
  incognito?: boolean;
}): Promise<StartChatRunResult> {
  const { userId, content, model } = input;
  const broker = getStreamBroker();

  let convId = input.conversationId;
  let incognito = false;

  if (convId) {
    const access = await assertConversationAccess(userId, convId);
    incognito = access.incognito;
    if (input.parentId && !incognito) {
      await assertParentInConversation(convId, input.parentId);
    }
  } else if (input.incognito) {
    convId = uuid();
    await broker.driver.putEphemeralConv({
      id: convId,
      ownerId: userId,
      title: content.slice(0, 80),
      kind: "chat",
      createdAt: Date.now(),
    });
    incognito = true;
  } else {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: content.slice(0, 80) }).returning();
    convId = conv.id;
  }

  if (getRunByConversation(convId)) {
    throw new Error("A response is already in progress for this conversation");
  }

  const userMsgId = uuid();
  const assistantMsgId = uuid();

  if (!incognito) {
    await db.insert(messages).values({
      id: userMsgId,
      conversationId: convId,
      parentId: input.parentId ?? null,
      authorType: "user",
      authorUserId: userId,
      origin: "server",
      lamport: Date.now(),
      content: [{ kind: "text", text: content }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });
    await db.insert(messages).values({
      id: assistantMsgId,
      conversationId: convId,
      parentId: userMsgId,
      authorType: "assistant",
      origin: "server",
      model,
      lamport: Date.now() + 1,
      content: [{ kind: "text", text: "" }],
      status: "streaming",
      createdAt: new Date(),
    });
    await db
      .update(conversations)
      .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
      .where(eq(conversations.id, convId));
  } else {
    await broker.driver.touchEphemeralConv(convId);
  }

  const streamId = uuid();
  const producer = await broker.openProducer({
    streamId,
    conversationId: convId,
    userId,
    surface: "chat",
    incognito,
  });

  producer.emit({
    kind: "message.start",
    message_id: userMsgId,
    author_type: "user",
    parent_id: input.parentId ?? null,
    text: content,
  });
  producer.emit({ kind: "message.end", message_id: userMsgId, status: "complete" });
  producer.emit({
    kind: "message.start",
    message_id: assistantMsgId,
    author_type: "assistant",
    parent_id: userMsgId,
    model,
  });

  const abort = new AbortController();
  registerRun({ streamId, conversationId: convId, userId, abort, approvals: new Map() });
  announceNewRun(convId, streamId);

  // Detached: the caller gets turn.started immediately, and generation
  // continues independent of whatever socket happened to start it. The
  // internal try/catch means this never becomes an unhandled rejection.
  void runChatGeneration({
    streamId,
    convId,
    userId,
    assistantMsgId,
    model,
    incognito,
    abort,
    producer,
  });

  return { streamId, conversationId: convId, userMessageId: userMsgId, incognito };
}

async function runChatGeneration(ctx: {
  streamId: string;
  convId: string;
  userId: string;
  assistantMsgId: string;
  model: string;
  incognito: boolean;
  abort: AbortController;
  producer: StreamProducer;
}): Promise<void> {
  const { streamId, convId, userId, assistantMsgId, model, incognito, abort, producer } = ctx;
  let fullText = "";
  let fullThinking = "";

  // Hoisted out of the try below: the same lookup that tells us whether to
  // show a load indicator also tells us the window the prompt is being
  // assembled against, which the breakdown needs.
  let windowTokens: number | null = null;
  let jitLoaded = false;

  try {
    try {
      const backendModels = await listBackendModels();
      const targetModel = backendModels.find((m) => m.id === model);
      windowTokens = targetModel?.loaded_context_tokens ?? targetModel?.context_tokens ?? null;
      if (targetModel && !targetModel.loaded) {
        jitLoaded = true;
        producer.emit({ kind: "model.loading", message_id: assistantMsgId });
      }
    } catch {
      // Best-effort — fall back to the generic "thinking" indicator.
    }

    const history = await loadChatHistory(convId, incognito);
    // Everything before the newest compaction is represented by its summary,
    // replayed as a system message — the messages themselves stay in Postgres
    // and on screen, they just aren't sent.
    const chatMessages = history.summaryText
      ? [summaryMessage(history.summaryText), ...history.messages]
      : history.messages;
    let doneResult: CompletionResult | null = null;

    for await (const event of streamCompletion(model, chatMessages, { signal: abort.signal })) {
      if (event.type === "delta") {
        fullText += event.content;
        producer.emit({ kind: "text.delta", message_id: assistantMsgId, text: event.content });
      } else if (event.type === "thinking") {
        fullThinking += event.content;
        producer.emit({ kind: "thinking.delta", message_id: assistantMsgId, text: event.content });
      } else {
        doneResult = event.result;
      }
    }

    const blocks: ContentBlock[] = [];
    if (fullThinking) blocks.push({ kind: "thinking", text: fullThinking });
    blocks.push({ kind: "text", text: fullText });

    // The JIT load has finished by now. The window read before generating was
    // necessarily the model's max — nothing was loaded yet — so re-read it to
    // get what the backend actually allocated.
    if (jitLoaded) {
      invalidateBackendModels();
      windowTokens = (await resolveWindow(model)) ?? windowTokens;
    }

    const usage: TurnUsage | undefined = doneResult
      ? {
          prompt_tokens: doneResult.usage.prompt_tokens,
          completion_tokens: doneResult.usage.completion_tokens,
          total_tokens: doneResult.usage.total_tokens,
          prompt_tps: doneResult.promptTps,
          gen_tps: doneResult.genTps,
          total_ms: doneResult.totalMs,
          context: apportion(history.tally, doneResult.usage.prompt_tokens, doneResult.usage.completion_tokens, {
            historyMessages: history.historyMessages,
            historyLimit: HISTORY_LIMIT,
            historyTruncated: history.historyTruncated,
            windowTokens,
          }),
        }
      : undefined;

    if (!incognito) {
      await db.update(messages).set({ content: blocks, status: "complete" }).where(eq(messages.id, assistantMsgId));
      if (doneResult && (doneResult.usage.total_tokens > 0 || doneResult.timings)) {
        await db.insert(usageRecords).values({
          id: uuid(),
          userId,
          conversationId: convId,
          messageId: assistantMsgId,
          model,
          origin: "server",
          inputTokens: doneResult.usage.prompt_tokens,
          cachedTokens: doneResult.timings?.cache_n ?? 0,
          outputTokens: doneResult.usage.completion_tokens,
          ttftMs: doneResult.ttftMs,
          promptMs: doneResult.timings?.prompt_ms ?? null,
          predictMs: doneResult.timings?.predicted_ms ?? null,
          totalMs: doneResult.totalMs,
          promptTps: doneResult.promptTps,
          predictedTps: doneResult.genTps,
          contextBreakdown: usage?.context ?? null,
        });
      }
    }

    producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage });
    await producer.end("complete", { usage });
  } catch (err) {
    const isAbort = (err as Error).name === "AbortError" || abort.signal.aborted;
    const status = isAbort ? "cancelled" : "error";
    const errorMessage = (err as Error).message;

    // Whatever text/thinking had accumulated is kept — unlike the old
    // handler, which discarded partial content on error.
    const blocks: ContentBlock[] = [];
    if (fullThinking) blocks.push({ kind: "thinking", text: fullThinking });
    blocks.push({ kind: "text", text: fullText });

    if (!incognito) {
      await db.update(messages).set({ content: blocks, status }).where(eq(messages.id, assistantMsgId)).catch(() => undefined);
    }

    const eventError = isAbort ? undefined : errorMessage;
    producer.emit({ kind: "message.end", message_id: assistantMsgId, status, error: eventError });
    await producer.end(status, { error: eventError }).catch(() => undefined);
  } finally {
    unregisterRun(streamId);
  }
}

export const HISTORY_LIMIT = 50;

/** How many trailing `summary` rows to inspect when looking for the newest
 * real compaction point. Skipped-compaction cards are also `summary`-authored
 * but carry no text — they must never act as a cutoff, so the search skips
 * them. A spam of more than this many consecutive skip cards just means the
 * cutoff is missed and the full (capped) history is sent — safe, only wasteful. */
const SUMMARY_LOOKBACK = 20;

export interface LoadedHistory {
  /** WITHOUT the summary — the caller composes it via summaryMessage(), so
   * chat and the compact run assemble prompts from the same parts. */
  messages: ChatMessage[];
  /** The newest compaction summary's text, or null if never compacted. */
  summaryText: string | null;
  /** Includes the summary's share when one exists. */
  tally: ContextTally;
  historyMessages: number;
  historyTruncated: boolean;
}

/**
 * Prior reasoning is deliberately dropped. This used to fold `thinking` blocks
 * back into the content string alongside `text`, which meant every past turn's
 * chain-of-thought was replayed into every subsequent prompt — often the
 * single largest slice of a small window, and not how reasoning models are
 * meant to be prompted. (The agent's own `textOf` never did this.)
 *
 * It is also, deliberately, not tallied: `apportion` splits the backend's real
 * prompt_tokens across whatever categories it's given, so including a category
 * that contributes nothing to the actual prompt would silently understate
 * every other row.
 */
function splitBlocks(blocks: ContentBlock[]): { text: string } {
  const text: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") text.push(b.text);
  }
  return { text: text.join("\n") };
}

/** Non-incognito: the usual Postgres history query. Incognito: rebuilt from
 * the stream log's folded snapshots — there's no Postgres row to query
 * instead, since none was ever written.
 *
 * Tallies as it goes rather than walking the returned ChatMessages: by then
 * the blocks are flattened to strings and `reasoning` can no longer be told
 * apart from `history`. */
export async function loadChatHistory(conversationId: string, incognito: boolean): Promise<LoadedHistory> {
  const tally: ContextTally = {};
  const out: ChatMessage[] = [];

  if (!incognito) {
    // The newest real compaction point, if any. Everything at or before it is
    // represented by its summary text and excluded from the replay below.
    const summaryRows = await db.query.messages.findMany({
      where: and(
        eq(messages.conversationId, conversationId),
        eq(messages.authorType, "summary"),
        eq(messages.status, "complete"),
      ),
      orderBy: (msgs, { desc }) => [desc(msgs.createdAt)],
      columns: { content: true, createdAt: true },
      limit: SUMMARY_LOOKBACK,
    });
    const summaryRow = summaryRows
      .map((r) => ({ text: splitBlocks(r.content as ContentBlock[]).text, createdAt: r.createdAt }))
      .find((r) => r.text.trim().length > 0);
    const summaryText = summaryRow?.text ?? null;
    if (summaryText) addChars(tally, "summary", SUMMARY_PREAMBLE + summaryText);

    // One over the limit: if the extra row comes back, older turns are being
    // dropped and the UI should say so. Cheaper than a second COUNT(*).
    const rows = await db.query.messages.findMany({
      where: summaryRow
        ? and(eq(messages.conversationId, conversationId), gt(messages.createdAt, summaryRow.createdAt))
        : eq(messages.conversationId, conversationId),
      orderBy: (msgs, { desc }) => [desc(msgs.createdAt)],
      columns: { authorType: true, content: true },
      limit: HISTORY_LIMIT + 1,
    });
    const truncated = rows.length > HISTORY_LIMIT;
    const history = rows.slice(0, HISTORY_LIMIT).reverse();

    for (const h of history) {
      if (h.authorType !== "user" && h.authorType !== "assistant") continue;
      const { text } = splitBlocks(h.content as ContentBlock[]);
      out.push({ role: h.authorType, content: text });
    }
    tallyHistoryRoles(tally, out);
    return { messages: out, summaryText, tally, historyMessages: out.length, historyTruncated: truncated };
  }

  // Incognito: rebuilt from the stream log's folded snapshots. The newest
  // summary (a compact run's message) lives in that same log, so find it and
  // replay only what came after — same cutoff rule as the Postgres path.
  const broker = getStreamBroker();
  const runIds = (await broker.driver.listConvStreams(conversationId)).slice(-HISTORY_LIMIT);
  const entries: { author: "user" | "assistant" | "summary"; text: string }[] = [];
  for (const runId of runIds) {
    const records = await broker.readFrom(runId, 0);
    const snapshot = broker.foldSnapshot(records);
    for (const m of snapshot.messages) {
      if (m.author_type !== "user" && m.author_type !== "assistant" && m.author_type !== "summary") continue;
      if (!m.text) continue;
      // Skip cards have no text, so they never land here — an entry with
      // author "summary" is always a real compaction point.
      entries.push({ author: m.author_type, text: m.text });
    }
  }
  const lastSummaryIdx = entries.map((e) => e.author).lastIndexOf("summary");
  const summaryText = lastSummaryIdx >= 0 ? entries[lastSummaryIdx].text : null;
  if (summaryText) addChars(tally, "summary", SUMMARY_PREAMBLE + summaryText);
  for (const e of entries.slice(lastSummaryIdx + 1)) {
    if (e.author === "summary") continue;
    out.push({ role: e.author, content: e.text });
  }
  const truncated = out.length > HISTORY_LIMIT;
  const capped = out.slice(-HISTORY_LIMIT);
  tallyHistoryRoles(tally, capped);
  return { messages: capped, summaryText, tally, historyMessages: capped.length, historyTruncated: truncated };
}

/** The trailing user message is this turn's prompt; everything before it is
 * history. Chat sends no system prompt and no tools, so those categories
 * simply never appear on this surface. */
function tallyHistoryRoles(tally: ContextTally, msgs: ChatMessage[]): void {
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  msgs.forEach((m, i) => {
    addChars(tally, m.role === "user" && i === lastUserIdx ? "current" : "history", m.content);
  });
}
