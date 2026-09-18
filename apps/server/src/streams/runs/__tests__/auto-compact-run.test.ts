import "./force-auto-compact.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import type { CompactionStats, ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../index.ts";
import { startChatRun } from "../chatRun.ts";
import { DEFAULT_MAX_ITERATIONS, loadHistory } from "../engine.ts";
import { getRunByConversation } from "../../registry.ts";

/**
 * The *wiring* of automatic compaction, which the pure policy test can't
 * reach. Three things only a real run proves:
 *
 *   1. It fires at all. The trigger sits past `runToolLoop`'s `finally`,
 *      because `startCompactRun` takes the same per-conversation lock the run
 *      is still holding until then — trigger it one line earlier and it
 *      refuses itself with "already in progress", silently, forever.
 *   2. `startCompactRun` is reached through a dynamic import (compactRun
 *      imports the engine's history loader, so a static import would close a
 *      cycle). A broken specifier there fails only at runtime.
 *   3. The summary actually becomes the cutoff, so the next prompt is short.
 *
 * Integration against the real dev Postgres and the mock inference loop,
 * matching compaction-history.test.ts.
 */
describe("automatic compaction", () => {
  const userId = `test-autocompact-${uuid()}`;
  const convIds: string[] = [];

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test AutoCompact",
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
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    // See force-auto-compact.ts: process.env is shared across the worker.
    delete process.env.AUTO_COMPACT_THRESHOLD;
  });

  async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = await fn();
      if (value !== null) return value;
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** A conversation already long enough to clear AUTO_COMPACT_MIN_MESSAGES. */
  async function seedConversation(turns: number): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "auto compact test" })
      .returning();
    convIds.push(conv.id);
    const rows: (typeof messages.$inferInsert)[] = [];
    for (let i = 0; i < turns; i++) {
      rows.push({
        id: uuid(),
        conversationId: conv.id,
        authorType: i % 2 === 0 ? "user" : "assistant",
        origin: "server",
        lamport: 1000 + i,
        content: [{ kind: "text", text: `seeded message ${String(i)}` }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(1_700_000_000_000 + i),
      });
    }
    await db.insert(messages).values(rows);
    return conv.id;
  }

  /** The newest completed summary row, or null while none exists yet. */
  async function summaryRow(convId: string) {
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { desc }) => [desc(m.lamport)],
    });
    const row = rows.find((r) => r.authorType === "summary" && r.status === "complete");
    return row ?? null;
  }

  const compactionOf = (row: { content: unknown }): CompactionStats | undefined =>
    (row.content as ContentBlock[]).find(
      (b): b is Extract<ContentBlock, { kind: "compaction" }> => b.kind === "compaction",
    );

  it("compacts on its own once a turn crosses the threshold, and says it was automatic", async () => {
    const convId = await seedConversation(8);
    await startChatRun({ userId, content: "another question", model: "llama-3.1-8b-instruct", conversationId: convId });

    const row = await waitFor(() => summaryRow(convId));
    const stats = compactionOf(row);
    expect(stats).toBeDefined();
    // The flag the card reads to explain a summary nobody asked for.
    expect(stats?.auto).toBe(true);
    // A real compaction, not the no-op skip card.
    expect(stats?.skipped).toBeUndefined();
    expect(stats?.messages_compacted).toBeGreaterThan(0);
  });

  it("makes the summary the cutoff, so the next prompt replays almost nothing", async () => {
    const convId = await seedConversation(8);
    const before = await loadHistory(convId);
    expect(before.messages).toHaveLength(8);
    expect(before.summaryText).toBeNull();

    await startChatRun({ userId, content: "another question", model: "llama-3.1-8b-instruct", conversationId: convId });
    await waitFor(() => summaryRow(convId));

    const after = await loadHistory(convId);
    expect(after.summaryText).not.toBeNull();
    // Everything before the summary is still in Postgres and still on screen —
    // it is simply no longer replayed.
    expect(after.messages.length).toBeLessThan(before.messages.length);
  });

  it("does not compact for a user who turned it off", async () => {
    // The gate is a per-user preference, checked only once the threshold has
    // already been crossed — so this conversation is identical to the one in
    // the first case, and the only difference is the row below.
    await db
      .insert(userPrefs)
      .values({ userId, autoCompact: false, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { autoCompact: false } });
    try {
      const convId = await seedConversation(8);
      await startChatRun({ userId, content: "another question", model: "llama-3.1-8b-instruct", conversationId: convId });

      await waitFor(async () => {
        const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
        const assistants = rows.filter((r) => r.authorType === "assistant" && r.status === "complete");
        return assistants.length > 0 ? assistants : null;
      });
      // The turn finished; give the trigger (which runs after the run's
      // `finally`) room to have fired if the pref were being ignored.
      await new Promise((r) => setTimeout(r, 1000));
      expect(await summaryRow(convId)).toBeNull();
    } finally {
      await db.update(userPrefs).set({ autoCompact: true }).where(eq(userPrefs.userId, userId));
    }
  });

  it("checks in at the user's step cadence rather than the built-in default", async () => {
    // The cadence used to be a constant, and used to be a *ceiling* — the run
    // died at it. Now it pauses and asks (see step-checkin.test.ts for the
    // three answers); what this case is about is whose number decides when,
    // not what happens next. So the same prompt is run twice and compared: one
    // run gets its answer, the other is parked with a question.
    const promptText = "make a todo list";

    const withDefault = await seedConversation(2);
    await startChatRun({ userId, content: promptText, model: "llama-3.1-8b-instruct", conversationId: withDefault });
    await waitFor(async () => {
      // `model` is set only on assistant rows the tool loop created, which is
      // what separates them from the seeded ones this conversation starts with.
      const done = (await db.query.messages.findMany({ where: eq(messages.conversationId, withDefault) }))
        .filter((r) => r.authorType === "assistant" && r.model !== null && r.status === "complete");
      // The loop takes a second iteration to turn the tool result into an
      // answer, so an unbounded run produces two assistant turns.
      return done.length >= 2 ? done : null;
    });

    await db
      .insert(userPrefs)
      .values({ userId, maxIterations: 1, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { maxIterations: 1 } });
    try {
      const limited = await seedConversation(2);
      await startChatRun({ userId, content: promptText, model: "llama-3.1-8b-instruct", conversationId: limited });
      // Parked, not finished: the run holds a resolver nobody has answered.
      // Waiting on that rather than on a sleep is also what keeps this honest
      // — a loop ignoring the pref would sail past and end the run instead.
      await waitFor(() => Promise.resolve(getRunByConversation(limited)?.stepsDecision ?? null));

      const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, limited) });
      // One iteration's worth: the tool ran, and the loop stopped to ask
      // before turning the result into an answer.
      expect(rows.filter((r) => r.authorType === "assistant" && r.model !== null)).toHaveLength(1);
      expect(rows.some((r) => r.authorType === "tool")).toBe(true);

      // Answer it, so the run gives its inference slot back before the suite
      // moves on — a parked run at concurrency 1 would stall everything after.
      getRunByConversation(limited)?.stepsDecision?.("answer", userId);
      await waitFor(() => Promise.resolve(getRunByConversation(limited) ? null : true));
    } finally {
      await db
        .update(userPrefs)
        .set({ maxIterations: DEFAULT_MAX_ITERATIONS })
        .where(eq(userPrefs.userId, userId));
    }
  });

  it("leaves a short conversation alone even when it is proportionally full", async () => {
    // AUTO_COMPACT_MIN_MESSAGES is what stops a thread whose summary alone
    // sits near the threshold from re-compacting on every single turn.
    const convId = await seedConversation(2);
    await startChatRun({ userId, content: "a question", model: "llama-3.1-8b-instruct", conversationId: convId });

    // Wait for the turn itself to finish, then confirm nothing compacted.
    await waitFor(async () => {
      const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
      const assistants = rows.filter((r) => r.authorType === "assistant" && r.status === "complete");
      return assistants.length > 0 ? assistants : null;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(await summaryRow(convId)).toBeNull();
  });
});
