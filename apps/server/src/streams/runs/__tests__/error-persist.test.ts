import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { and, db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startChatRun } from "../chatRun.ts";
import { capErrorText, MAX_ERROR_TEXT_CHARS } from "../../error-text.ts";

/**
 * A failed turn's reason has to outlive the socket that watched it fail.
 *
 * It used to ride only on `message.end`: the row kept `status: "error"` and
 * nothing else, so a reload showed an empty reply with no reason. The mock's
 * "fail to load the model" prompt fails the way LM Studio does for a model it
 * cannot load — before any token — so this is the real engine's error path.
 */
process.env.MOCK_INFERENCE = "true";

describe("persisting why a turn failed", () => {
  const userId = `test-error-persist-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Error Persist",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    for (const id of convIds) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function assistantRow(convId: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, convId), eq(messages.authorType, "assistant")));
    return row;
  }

  it("stores the backend's reason on the failed assistant message", async () => {
    const { conversationId } = await startChatRun({
      userId,
      content: "please fail to load the model",
      model: "llama-3.1-8b-instruct",
    });
    convIds.push(conversationId);
    await waitFor("the run to end", () => getRunByConversation(conversationId) === undefined);

    const row = await assistantRow(conversationId);
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/^Failed to load model "mock-model"\. Error: /);
  });

  it("stores no error for a turn the user stopped", async () => {
    const { conversationId } = await startChatRun({
      userId,
      // The mock's slow path, so there is a run still going to stop.
      content: "take your time and think about this",
      model: "llama-3.1-8b-instruct",
    });
    convIds.push(conversationId);
    // Keyed on the assistant row, not the run registering: a stop that lands
    // before the row exists ends the run without one, and there would be
    // nothing here to assert against.
    await waitFor("the assistant message to start", async () => {
      const rows = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.authorType, "assistant")));
      return rows.length > 0;
    });
    // What the WS handler does for a `stream.stop` frame.
    getRunByConversation(conversationId)?.abort.abort();
    await waitFor("the run to end", () => getRunByConversation(conversationId) === undefined);

    const row = await assistantRow(conversationId);
    expect(row.status).toBe("cancelled");
    expect(row.error).toBeNull();
  });

  it("bounds what it stores, and stores nothing for an empty message", () => {
    const capped = capErrorText("x".repeat(MAX_ERROR_TEXT_CHARS * 5));
    expect(capped).toHaveLength(MAX_ERROR_TEXT_CHARS);
    expect(capped?.endsWith("…")).toBe(true);
    expect(capErrorText("short")).toBe("short");
    expect(capErrorText("")).toBeNull();
  });
});
