import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import type { ContentBlock, TurnUsage } from "@shannon/types";
import { streamCompletion, type ChatMessage, type CompletionResult } from "../../inference/provider.ts";
import { listBackendModels } from "../../inference/models.ts";
import { assertConversationAccess, assertParentInConversation } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";

export type StartChatRunResult = {
  streamId: string;
  conversationId: string;
  userMessageId: string;
  incognito: boolean;
};

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
      parentId: input.parentId || null,
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

  try {
    try {
      const backendModels = await listBackendModels();
      const targetModel = backendModels.find((m) => m.id === model);
      if (targetModel && !targetModel.loaded) {
        producer.emit({ kind: "model.loading", message_id: assistantMsgId });
      }
    } catch {
      // Best-effort — fall back to the generic "thinking" indicator.
    }

    const chatMessages = await loadChatHistory(convId, incognito);
    let doneResult: CompletionResult | null = null;

    for await (const event of streamCompletion(model, chatMessages, { signal: abort.signal })) {
      if (event.type === "delta") {
        fullText += event.content;
        producer.emit({ kind: "text.delta", message_id: assistantMsgId, text: event.content });
      } else if (event.type === "thinking") {
        fullThinking += event.content;
        producer.emit({ kind: "thinking.delta", message_id: assistantMsgId, text: event.content });
      } else if (event.type === "done") {
        doneResult = event.result;
      }
    }

    const blocks: ContentBlock[] = [];
    if (fullThinking) blocks.push({ kind: "thinking", text: fullThinking });
    blocks.push({ kind: "text", text: fullText });

    const usage: TurnUsage | undefined = doneResult
      ? {
          prompt_tokens: doneResult.usage.prompt_tokens,
          completion_tokens: doneResult.usage.completion_tokens,
          total_tokens: doneResult.usage.total_tokens,
          prompt_tps: doneResult.promptTps,
          gen_tps: doneResult.genTps,
          total_ms: doneResult.totalMs,
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
          cachedTokens: doneResult.timings?.cache_n || 0,
          outputTokens: doneResult.usage.completion_tokens,
          ttftMs: doneResult.ttftMs,
          promptMs: doneResult.timings?.prompt_ms || null,
          predictMs: doneResult.timings?.predicted_ms || null,
          totalMs: doneResult.totalMs,
          promptTps: doneResult.promptTps,
          predictedTps: doneResult.genTps,
        });
      }
    }

    producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage });
    await producer.end("complete", { usage });
  } catch (err) {
    const isAbort = (err as Error)?.name === "AbortError" || abort.signal.aborted;
    const status = isAbort ? "cancelled" : "error";
    const errorMessage = (err as Error).message;

    // Whatever text/thinking had accumulated is kept — unlike the old
    // handler, which discarded partial content on error.
    const blocks: ContentBlock[] = [];
    if (fullThinking) blocks.push({ kind: "thinking", text: fullThinking });
    blocks.push({ kind: "text", text: fullText });

    if (!incognito) {
      await db.update(messages).set({ content: blocks, status }).where(eq(messages.id, assistantMsgId)).catch(() => {});
    }

    const eventError = isAbort ? undefined : errorMessage;
    producer.emit({ kind: "message.end", message_id: assistantMsgId, status, error: eventError });
    await producer.end(status, { error: eventError }).catch(() => {});
  } finally {
    unregisterRun(streamId);
  }
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text" || b.kind === "thinking")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/** Non-incognito: the usual Postgres history query. Incognito: rebuilt from
 * the stream log's folded snapshots — there's no Postgres row to query
 * instead, since none was ever written. */
async function loadChatHistory(conversationId: string, incognito: boolean): Promise<ChatMessage[]> {
  if (!incognito) {
    const history = await db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: (msgs, { desc }) => [desc(msgs.createdAt)],
      columns: { authorType: true, content: true },
      limit: 50,
    });
    history.reverse();
    return history
      .filter((h) => h.authorType === "user" || h.authorType === "assistant")
      .map((h) => ({
        role: (h.authorType === "user" ? "user" : "assistant") as "user" | "assistant",
        content: extractText(h.content as ContentBlock[]),
      }));
  }

  const broker = getStreamBroker();
  const runIds = (await broker.driver.listConvStreams(conversationId)).slice(-50);
  const out: ChatMessage[] = [];
  for (const runId of runIds) {
    const records = await broker.readFrom(runId, 0);
    const snapshot = broker.foldSnapshot(records);
    for (const m of snapshot.messages) {
      if (m.author_type !== "user" && m.author_type !== "assistant") continue;
      if (!m.text) continue;
      out.push({ role: m.author_type, content: m.text });
    }
  }
  return out.slice(-50);
}
