import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../index.ts";
import { recoverOrphanedStream } from "../recovery.ts";
import { INTERRUPTED_BY_RESTART } from "../error-text.ts";

/**
 * Boot-time recovery of a run log that outlived its process.
 *
 * A multi-iteration run's log holds every iteration, and only the last one was
 * still generating when the process died. The earlier ones are finished rows
 * with their tool calls. Recovery used to rewrite all of them: the finished
 * turns lost their tool_call blocks and were marked failed with a restart they
 * never saw. This drives `recoverOrphanedStream` directly rather than
 * `recoverOrphanedStreams`, whose Postgres sweep touches every stuck row in a
 * shared database.
 */
describe("recovering an orphaned run log", () => {
  const userId = `test-recovery-${uuid()}`;
  let convId = "";

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Recovery",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "recovery test" }).returning();
    convId = conv.id;
  });

  afterAll(async () => {
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(user).where(eq(user.id, userId));
  });

  it("finalizes only the iteration that was still streaming", async () => {
    const finishedId = uuid();
    const toolId = uuid();
    const cutOffId = uuid();
    const finishedContent: ContentBlock[] = [
      { kind: "text", text: "Running it." },
      { kind: "tool_call", call_id: "call-1", tool: "bash", args: { command: "echo hi" } },
    ];
    await db.insert(messages).values([
      {
        id: finishedId,
        conversationId: convId,
        authorType: "assistant",
        origin: "server",
        lamport: 1,
        content: finishedContent,
        status: "complete",
        createdAt: new Date(),
      },
      {
        id: toolId,
        conversationId: convId,
        parentId: finishedId,
        authorType: "tool",
        origin: "server",
        lamport: 2,
        content: [{ kind: "tool_result", call_id: "call-1", output: "hi" }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      },
      {
        id: cutOffId,
        conversationId: convId,
        parentId: toolId,
        authorType: "assistant",
        origin: "server",
        lamport: 3,
        content: [{ kind: "text", text: "" }],
        status: "streaming",
        createdAt: new Date(),
      },
    ]);

    const broker = getStreamBroker();
    const streamId = uuid();
    await broker.driver.createStream({ streamId, conversationId: convId, userId, surface: "agent", createdAt: Date.now() });
    await broker.driver.append(streamId, [
      { kind: "message.start", message_id: finishedId, author_type: "assistant", parent_id: null },
      { kind: "text.delta", message_id: finishedId, text: "Running it." },
      { kind: "tool.call", message_id: finishedId, call_id: "call-1", tool: "bash", args: { command: "echo hi" } },
      { kind: "message.end", message_id: finishedId, status: "complete" },
      { kind: "message.start", message_id: cutOffId, author_type: "assistant", parent_id: toolId },
      { kind: "text.delta", message_id: cutOffId, text: "Half an ans" },
    ]);
    const meta = await broker.driver.getMeta(streamId);
    if (!meta) throw new Error("stream meta missing");

    await recoverOrphanedStream(broker, meta);

    const [finished] = await db.select().from(messages).where(eq(messages.id, finishedId));
    expect(finished.status).toBe("complete");
    expect(finished.error).toBeNull();
    expect(finished.content).toEqual(finishedContent);

    const [cutOff] = await db.select().from(messages).where(eq(messages.id, cutOffId));
    expect(cutOff.status).toBe("error");
    expect(cutOff.error).toBe(INTERRUPTED_BY_RESTART);
    expect(cutOff.content).toEqual([{ kind: "text", text: "Half an ans" }]);

    expect((await broker.driver.getMeta(streamId))?.status).toBe("error");
  });
});
