import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { asc, db, eq, inArray } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import { CHECKIN_ANSWER_NUDGE, type ContentBlock } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { claimConversation, ConversationBusyError, getRunByConversation, unregisterRun } from "../../registry.ts";
import { retryChatRun, startChatRun } from "../chatRun.ts";
import { retryAgentRun } from "../agentRun.ts";
import { RewindError } from "../../../conversations/rewind.ts";
import { NotFoundError } from "../../authz.ts";
import { beginSendFor } from "../../../ws/send-outcomes.ts";

/**
 * Retry answers the conversation's newest message again (#166): the reply and
 * anything after it go, and a new run starts on the same stored message — no
 * second copy of it, so the prompt is the one the replaced reply answered.
 */
process.env.MOCK_INFERENCE = "true";
const MODEL = "llama-3.1-8b-instruct";

describe("retrying the newest reply", () => {
  const userId = `test-retry-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    process.env.DELETED_CHAT_RETENTION_ENABLED = "false";
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Retry",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    delete process.env.DELETED_CHAT_RETENTION_ENABLED;
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
  });

  async function waitForRun(convId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (getRunByConversation(convId)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run to end");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function send(content: string, conversationId?: string) {
    const started = await startChatRun({ userId, content, model: MODEL, conversationId });
    if (!conversationId) convIds.push(started.conversationId);
    await waitForRun(started.conversationId);
    return started;
  }

  const rowsOf = (convId: string) =>
    db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.lamport), asc(messages.createdAt));

  it("answers the same message again, replacing the reply and detaching its usage", async () => {
    const first = await send("first");
    const second = await send("second", first.conversationId);
    const convId = first.conversationId;
    const before = await rowsOf(convId);
    const oldReply = before.at(-1);
    expect(oldReply?.authorType).toBe("assistant");
    const oldUsage = await db.select().from(usageRecords).where(eq(usageRecords.messageId, oldReply?.id));
    expect(oldUsage.length).toBeGreaterThan(0);

    const retried = await retryChatRun({ userId, conversationId: convId, model: MODEL });
    expect(retried.userMessageId).toBe(second.userMessageId);
    expect(retried.streamId).not.toBe(second.streamId);
    await waitForRun(convId);

    const after = await rowsOf(convId);
    // The same four rows' shape, the reply a new one: one user row per turn.
    expect(after.map((r) => r.authorType)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(after.filter((r) => r.authorType === "user").map((r) => r.id)).toEqual([first.userMessageId, second.userMessageId]);
    expect(after.at(-1)?.id).not.toBe(oldReply?.id);
    expect(after.at(-1)?.status).toBe("complete");
    const detached = await db.select().from(usageRecords).where(inArray(usageRecords.id, oldUsage.map((u) => u.id)));
    expect(detached.every((u) => u.conversationId === null && u.messageId === null)).toBe(true);
    // The old run's log is gone with it; the first turn's stays.
    const streams = await getStreamBroker().driver.listConvStreams(convId);
    expect(streams).toEqual([first.streamId, retried.streamId]);
  });

  it("retries a failed reply", async () => {
    const failed = await send("please fail to load the model");
    const convId = failed.conversationId;
    const [oldReply] = (await rowsOf(convId)).filter((r) => r.authorType === "assistant");
    expect(oldReply.status).toBe("error");

    await retryChatRun({ userId, conversationId: convId, model: MODEL });
    await waitForRun(convId);

    const replies = (await rowsOf(convId)).filter((r) => r.authorType === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0].id).not.toBe(oldReply.id);
  });

  it("answers what the person typed, not a nudge the last run wrote after it", async () => {
    const started = await send("the real question");
    const convId = started.conversationId;
    const nudge = uuid();
    await db.insert(messages).values({
      id: nudge,
      conversationId: convId,
      authorType: "user",
      authorUserId: userId,
      origin: "server",
      lamport: Date.now() + 10_000,
      content: [{ kind: "text", text: CHECKIN_ANSWER_NUDGE }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });

    const retried = await retryChatRun({ userId, conversationId: convId, model: MODEL });
    expect(retried.userMessageId).toBe(started.userMessageId);
    await waitForRun(convId);
    expect((await rowsOf(convId)).some((r) => r.id === nudge)).toBe(false);
  });

  it("is refused while a run holds the conversation, on an empty one, and on the wrong surface", async () => {
    const started = await send("hello");
    const convId = started.conversationId;
    const busy = { streamId: uuid(), conversationId: convId, userId, abort: new AbortController(), approvals: new Map() };
    claimConversation(busy);
    try {
      await expect(retryChatRun({ userId, conversationId: convId, model: MODEL })).rejects.toBeInstanceOf(ConversationBusyError);
    } finally {
      unregisterRun(busy.streamId);
    }
    expect(await rowsOf(convId)).toHaveLength(2);

    const [empty] = await db.insert(conversations).values({ ownerId: userId, title: "empty" }).returning();
    convIds.push(empty.id);
    await expect(retryChatRun({ userId, conversationId: empty.id, model: MODEL })).rejects.toBeInstanceOf(RewindError);
    // The claim a refused retry took is given back.
    expect(getRunByConversation(empty.id)).toBeUndefined();

    await expect(retryAgentRun({ userId, conversationId: convId, model: MODEL, mode: "manual" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runs on the model the retry names", async () => {
    const started = await send("which model");
    const convId = started.conversationId;
    await retryChatRun({ userId, conversationId: convId, model: "qwen2.5-7b-instruct" });
    await waitForRun(convId);
    const reply = (await rowsOf(convId)).at(-1);
    expect(reply?.model).toBe("qwen2.5-7b-instruct");
  });

  it("is remembered like a send, so a replaced socket can ask what became of it", () => {
    expect(beginSendFor(userId, { type: "chat.retry", client_ref: "r1" } as never, "chat")).toBeDefined();
    expect(beginSendFor(userId, { type: "agent.retry", client_ref: "r2" } as never, "agent")).toBeDefined();
    expect(beginSendFor(userId, { type: "agent.retry", client_ref: "r3" } as never, "chat")).toBeUndefined();
  });
});
