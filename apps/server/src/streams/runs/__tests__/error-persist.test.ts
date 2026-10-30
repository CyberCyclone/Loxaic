import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { and, asc, db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user } from "@loxaic/db/schema";
import type * as PromptReuse from "../../../inference/prompt-reuse.ts";
import { initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import { startChatRun } from "../chatRun.ts";
import { startCompactRun } from "../compactRun.ts";
import { capErrorText, MAX_ERROR_TEXT_CHARS, TURN_FAILED } from "../../error-text.ts";
import type * as Skills from "../../../skills/session.ts";
import type * as TodoStalenessModule from "../todo-staleness.ts";
import type * as UsageRecord from "../usage-record.ts";

/** A failure of our own inside the turn, standing in for the database write
 * that used to share the stream's `try`. `recordPrompt` runs in that loop body
 * on the completion's last event, so throwing from it is a non-backend error
 * reaching the same `catch` a backend one does. The message is shaped like a
 * Postgres one on purpose: it is exactly the kind of text that must not be
 * served as the model's reason. */
const ourOwnFailure = vi.hoisted(() => ({ on: false, message: 'relation "internal_billing_ledger" does not exist' }));
vi.mock("../../../inference/prompt-reuse.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof PromptReuse>();
  return {
    ...actual,
    recordPrompt: (...args: Parameters<typeof actual.recordPrompt>) => {
      if (ourOwnFailure.on) throw new Error(ourOwnFailure.message);
      actual.recordPrompt(...args);
    },
  };
});

/** Faults past the point a stream's own failure handling covers: one before a
 * step's row is finished, one after it and its tools are done. */
const laterFault = vi.hoisted(() => ({ inSetup: false, beforeRowDone: false, betweenSteps: false, message: 'relation "internal_billing_ledger" does not exist' }));
vi.mock("../../../skills/session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Skills>();
  return {
    ...actual,
    prepareRunSkills: (...args: Parameters<typeof actual.prepareRunSkills>) => {
      if (laterFault.inSetup) throw new Error(laterFault.message);
      return actual.prepareRunSkills(...args);
    },
  };
});
vi.mock("../usage-record.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof UsageRecord>();
  return {
    ...actual,
    turnDraftUsage: (...args: Parameters<typeof actual.turnDraftUsage>) => {
      if (laterFault.beforeRowDone) throw new Error(laterFault.message);
      return actual.turnDraftUsage(...args);
    },
  };
});
vi.mock("../todo-staleness.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof TodoStalenessModule>();
  // Through the static: it is where the engine gets its instance.
  const fromHistory = actual.TodoStaleness.fromHistory.bind(actual.TodoStaleness);
  actual.TodoStaleness.fromHistory = (...args) => {
    const tracker = fromHistory(...args);
    const endIteration = tracker.endIteration.bind(tracker);
    tracker.endIteration = () => {
      if (laterFault.betweenSteps) throw new Error(laterFault.message);
      endIteration();
    };
    return tracker;
  };
  return actual;
});

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

  it("stores a generic reason, not our own error text, when the backend did not fail", async () => {
    ourOwnFailure.on = true;
    let conversationId = "";
    try {
      ({ conversationId } = await startChatRun({
        userId,
        content: "an ordinary question",
        model: "llama-3.1-8b-instruct",
      }));
      convIds.push(conversationId);
      await waitFor("the run to end", () => getRunByConversation(conversationId) === undefined);
    } finally {
      ourOwnFailure.on = false;
    }

    const row = await assistantRow(conversationId);
    expect(row.status).toBe("error");
    expect(row.error).toBe(TURN_FAILED);
    expect(row.error).not.toContain("internal_billing_ledger");
  });

  async function agentRunThatDies(fault: "inSetup" | "beforeRowDone" | "betweenSteps") {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "dying run", kind: "agent" }).returning();
    convIds.push(conv.id);
    laterFault[fault] = true;
    try {
      await startAgentRun({
        userId,
        content: "make a plan for this work",
        model: "llama-3.1-8b-instruct",
        mode: "auto",
        conversationId: conv.id,
      });
      await waitFor("the run to register", () => getRunByConversation(conv.id) !== undefined);
      await waitFor("the run to end", () => getRunByConversation(conv.id) === undefined);
    } finally {
      laterFault[fault] = false;
    }
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(asc(messages.lamport), asc(messages.createdAt));
  }

  it("leaves a run that died between steps saying so in the thread", async () => {
    const rows = await agentRunThatDies("betweenSteps");
    const replies = rows.filter((r) => r.authorType === "assistant");
    // The step stays as it finished; the failure is the reply after it.
    expect(replies[0].status).toBe("complete");
    expect(rows.at(-1)).toMatchObject({ authorType: "assistant", status: "error", error: TURN_FAILED, content: [] });
    expect(JSON.stringify(rows)).not.toContain("internal_billing_ledger");
  });

  it("answers the message of a run that died before its first request", async () => {
    const rows = await agentRunThatDies("inSetup");
    expect(rows.map((r) => r.authorType)).toEqual(["user", "assistant"]);
    expect(rows[1]).toMatchObject({ status: "error", error: TURN_FAILED, content: [] });
  });

  it("marks the row that was streaming rather than leaving it streaming for good", async () => {
    const rows = await agentRunThatDies("beforeRowDone");
    const replies = rows.filter((r) => r.authorType === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: "error", error: TURN_FAILED });
  });

  it("stores the backend's reason on a failed compaction", async () => {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "failed compaction" }).returning();
    convIds.push(conv.id);
    await db.insert(messages).values([
      { id: uuid(), conversationId: conv.id, authorType: "user", origin: "server", lamport: 1, content: [{ kind: "text", text: "hello" }], status: "complete", createdAt: new Date() },
      { id: uuid(), conversationId: conv.id, authorType: "assistant", origin: "server", lamport: 2, content: [{ kind: "text", text: "hi" }], status: "complete", createdAt: new Date() },
    ]);

    // Guidance rides in the instruction, which is the compaction prompt's last
    // user turn — the one the mock's failure trigger reads.
    const { summaryMessageId } = await startCompactRun({
      userId,
      conversationId: conv.id,
      model: "llama-3.1-8b-instruct",
      args: "please fail to load the model",
      surface: "chat",
    });
    await waitFor("the compaction to end", () => getRunByConversation(conv.id) === undefined);

    const [row] = await db.select().from(messages).where(eq(messages.id, summaryMessageId));
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/^Failed to load model "mock-model"\. Error: /);
  });

  it("fails a compaction that produced no summary, rather than committing an empty one", async () => {
    // Committed as complete, an empty summary is skipped as a cutoff, so
    // nothing is compacted while the card claims the whole saving — and the
    // next turn crosses the threshold and compacts again.
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "empty compaction" }).returning();
    convIds.push(conv.id);
    await db.insert(messages).values([
      { id: uuid(), conversationId: conv.id, authorType: "user", origin: "server", lamport: 1, content: [{ kind: "text", text: "hello" }], status: "complete", createdAt: new Date() },
      { id: uuid(), conversationId: conv.id, authorType: "assistant", origin: "server", lamport: 2, content: [{ kind: "text", text: "hi" }], status: "complete", createdAt: new Date() },
    ]);

    const { summaryMessageId } = await startCompactRun({
      userId,
      conversationId: conv.id,
      model: "llama-3.1-8b-instruct",
      args: "say nothing",
      surface: "chat",
    });
    await waitFor("the compaction to end", () => getRunByConversation(conv.id) === undefined);

    const [row] = await db.select().from(messages).where(eq(messages.id, summaryMessageId));
    expect(row.status).toBe("error");
    expect(row.error).toBe("The model returned no summary, so nothing was compacted.");
    expect(row.content).not.toContainEqual(expect.objectContaining({ kind: "compaction" }));
  });

  it("bounds what it stores, strips control characters, and stores nothing for an empty message", () => {
    const capped = capErrorText("x".repeat(MAX_ERROR_TEXT_CHARS * 5));
    expect(capped).toHaveLength(MAX_ERROR_TEXT_CHARS);
    expect(capped?.endsWith("…")).toBe(true);
    expect(capErrorText("short")).toBe("short");
    expect(capErrorText("\u001b[31mred\u001b[0m\u0000 alert\nline two")).toBe("red alert\nline two");
    expect(capErrorText("")).toBeNull();
    expect(capErrorText("\u0000\u0007")).toBeNull();
  });
});
