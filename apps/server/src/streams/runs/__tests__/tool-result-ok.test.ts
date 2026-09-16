import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";

/**
 * A failed tool call has to still read as failed after a reload.
 *
 * The `tool.result` stream event has carried `ok` since the GitHub permission
 * work, and the card tints on it — but the event is gone the moment the stream
 * ends, and the persisted `tool_result` block carried no such field. So a
 * conversation reopened from REST rendered a refused clone, a denied approval
 * and a stopped call identically to a success, which is the failure the tint
 * was added to prevent, merely deferred by one reload.
 *
 * Asserted against the stored rows rather than the live stream, deliberately:
 * the stream was already right. What was lost was everything after it.
 *
 * Both cases are sandbox-free — `todo_write` needs no container, and a denial
 * is refused before execution — so this runs on a machine with no Docker.
 */
process.env.MOCK_INFERENCE = "true";

describe("a persisted tool result records whether it succeeded", () => {
  const userId = `test-tool-ok-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Tool Ok",
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

  async function newConversation(): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "tool ok test", kind: "agent" })
      .returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** The stored blocks, which is all a client rebuilding from REST ever sees. */
  async function storedResults(convId: string) {
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    return rows
      .flatMap((r) => r.content as ContentBlock[])
      .filter((b): b is Extract<ContentBlock, { kind: "tool_result" }> => b.kind === "tool_result");
  }

  it("records ok on a call that succeeded", async () => {
    const convId = await newConversation();
    // `todo_write` rather than a file tool: it is the one builtin the mock
    // triggers that needs no sandbox, so the success case does not depend on
    // Docker being present. Auto mode, so nothing asks for approval.
    await startAgentRun({
      userId,
      content: "make a plan for this work",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, 30_000);

    const results = await storedResults(convId);
    expect(results).toHaveLength(1);
    // Explicitly true, not merely "not false": absence is what every row
    // written before this field looks like, and the client is required to read
    // that as "we were not told" rather than as success.
    expect(results[0].ok).toBe(true);
  });

  it("records the failure of a call the user denied, so a reload still shows it failed", async () => {
    const convId = await newConversation();
    // Manual mode: fs_write asks, and a denial is the cheapest real failure —
    // refused before execution, so no sandbox is created.
    await startAgentRun({
      userId,
      content: "write a file called notes",
      model: "llama-3.1-8b-instruct",
      mode: "manual",
      conversationId: convId,
    });

    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
    const run = getRunByConversation(convId);
    if (!run) throw new Error("run vanished");
    await waitFor("the approval to be pending", () => run.approvals.size > 0);
    const [, decide] = [...run.approvals.entries()][0];
    decide(false);

    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, 30_000);

    const results = await storedResults(convId);
    expect(results).toHaveLength(1);
    expect(results[0].output).toContain("denied");
    // The whole point: the verdict outlives the stream that reported it.
    expect(results[0].ok).toBe(false);
  });
});
