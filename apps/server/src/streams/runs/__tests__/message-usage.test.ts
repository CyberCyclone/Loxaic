import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { StreamEventKind } from "@loxaic/types";

/**
 * #193: the context meter showed nothing for a whole tool-calling turn.
 *
 * The meter reads the newest message carrying usage, and usage used to ride
 * only on the turn's *final* `message.end`. A tool-calling message's
 * `message.end` is deferred until its tools have run — which in manual mode
 * means until somebody answers the approval — so the figure the server had
 * measured the moment the request finished sat unreported for as long as the
 * turn lasted.
 *
 * So this parks a run at an approval, which is the longest such gap there is,
 * and asserts the usage is already in the log, and in the snapshot a
 * reconnecting client would be sent, before anyone has answered.
 */
process.env.MOCK_INFERENCE = "true";

const { startAgentRun } = await import("../agentRun.ts");
const { getRunByConversation } = await import("../../registry.ts");
const { initStreamBroker, getStreamBroker } = await import("../../index.ts");

type Ev<K extends StreamEventKind["kind"]> = Extract<StreamEventKind, { kind: K }>;

describe("usage is reported per request, not per turn", () => {
  const userId = `test-message-usage-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Message Usage",
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

  async function waitFor(label: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("reports a request's usage before its tool call is approved, and again on its message.end", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "message usage", kind: "agent" })
      .returning();
    convIds.push(conv.id);

    // Manual mode: fs_write asks, so the run parks between the request that
    // produced the call and that message's message.end.
    const { streamId } = await startAgentRun({
      userId,
      content: "write a file called notes",
      model: "llama-3.1-8b-instruct",
      mode: "manual",
      conversationId: conv.id,
    });
    await waitFor("the run to register", () => getRunByConversation(conv.id) !== undefined);
    const run = getRunByConversation(conv.id);
    if (!run) throw new Error("run vanished");
    await waitFor("the approval to be pending", () => run.approvals.size > 0);

    const broker = getStreamBroker();
    const parked = await broker.readFrom(streamId, 0);
    const events = parked.map((r) => r.event);
    const call = events.find((e): e is Ev<"tool.call"> => e.kind === "tool.call");
    if (!call) throw new Error("no tool call before the approval");

    const reported = events.find((e): e is Ev<"message.usage"> => e.kind === "message.usage" && e.message_id === call.message_id);
    expect(reported).toBeDefined();
    expect(reported?.usage.prompt_tokens).toBeGreaterThan(0);
    // The breakdown is what the meter actually draws, so it has to come with it.
    expect(reported?.usage.context?.used_tokens).toBe(
      (reported?.usage.prompt_tokens ?? 0) + (reported?.usage.completion_tokens ?? 0),
    );
    // Before the fix, this was the only place usage could have come from — and
    // it has not happened yet.
    expect(events.some((e) => e.kind === "message.end" && e.message_id === call.message_id)).toBe(false);

    // A client that connects now is sent a snapshot, not the log.
    const snapshot = broker.foldSnapshot(parked);
    expect(snapshot.messages.find((m) => m.message_id === call.message_id)?.usage).toEqual(reported?.usage);

    // Deny, so nothing needs a sandbox; the run then answers and finishes.
    const [, resolve] = [...run.approvals.entries()][0];
    resolve(false);
    await waitFor("the run to finish", () => getRunByConversation(conv.id) === undefined);

    const all = (await broker.readFrom(streamId, 0)).map((r) => r.event);
    const ends = all.filter((e): e is Ev<"message.end"> => e.kind === "message.end");
    // The deferred message.end repeats it, for a client that predates message.usage.
    expect(ends.find((e) => e.message_id === call.message_id)?.usage).toEqual(reported?.usage);
    // And every assistant request in the turn reported, the final one included.
    const usageIds = all.filter((e): e is Ev<"message.usage"> => e.kind === "message.usage").map((e) => e.message_id);
    const assistantIds = all
      .filter((e): e is Ev<"message.start"> => e.kind === "message.start" && e.author_type === "assistant")
      .map((e) => e.message_id);
    expect(assistantIds.length).toBeGreaterThan(1);
    expect(usageIds).toEqual(assistantIds);
    expect(ends.at(-1)?.usage).toBeDefined();
  });
});
