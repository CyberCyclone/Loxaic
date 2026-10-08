import "./force-auto-compact.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { db, eq, sql } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import { COMPACTION_CONTINUE_NUDGE, type CompactionStats, type ContentBlock } from "@loxaic/types";
import { initStreamBroker } from "../../index.ts";
import { startChatRun } from "../chatRun.ts";
import { DEFAULT_MAX_ITERATIONS, loadHistory } from "../engine.ts";
import { getRunByConversation } from "../../registry.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";
import { nextConversationLamport } from "../compactRun.ts";
import { SUMMARY_PREAMBLE, estimateTallyTokens, tallyChatMessages } from "../../../inference/context.ts";
import type { ChatMessage } from "../../../inference/provider.ts";

/** Every request's messages, in call order — so a case can see how a
 * compaction was actually sent, not just that one landed. */
const requests: ChatMessage[][] = [];
vi.mock("../../../inference/provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../inference/provider.ts")>();
  return {
    ...actual,
    streamCompletion: (model: string, msgs: ChatMessage[], options?: unknown) => {
      // A copy at call time: the tool loop keeps appending to the array it passes.
      requests.push([...msgs]);
      return actual.streamCompletion(model, msgs, options as never);
    },
  };
});

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
    if (rows.length) await db.insert(messages).values(rows);
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

  describe("in the middle of a run", () => {
    // Four tool steps in one turn. The threshold here is 0.001, so every
    // request reads as full; AUTO_COMPACT_MIN_MESSAGES is then what decides
    // when there is enough to summarise. Two seeded messages and the request
    // make three, each step adds two, so the room check before the fourth
    // request (nine messages since any summary) is the one that compacts —
    // between the third step's result and the fourth step's call.
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "mock-scenarios-"));
      const file = path.join(dir, "scenarios.json");
      const step = (n: number) => ({ tool: "todo_write", args: { todos: [{ id: "1", text: `step ${String(n)}`, status: "in_progress" }] } });
      writeFileSync(
        file,
        JSON.stringify([{ match: "work in four steps", steps: [step(1), step(2), step(3), step(4)], finalText: "[Mock] four steps done.\n" }]),
      );
      process.env.MOCK_SCENARIOS_FILE = file;
      __resetMockScenariosForTest();
    });
    afterAll(() => {
      delete process.env.MOCK_SCENARIOS_FILE;
      __resetMockScenariosForTest();
      rmSync(dir, { recursive: true, force: true });
    });

    it("compacts between two requests of the run, and the run carries on from the summary", async () => {
      const convId = await seedConversation(2);
      await startChatRun({ userId, content: "work in four steps", model: "llama-3.1-8b-instruct", conversationId: convId });
      await waitFor(() => Promise.resolve(getRunByConversation(convId) ? null : true), 30_000);

      const rows = await db.query.messages.findMany({
        where: eq(messages.conversationId, convId),
        orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
      });
      const summaries = rows.filter((r) => r.authorType === "summary");
      // One: the floor stops a second straight after it.
      expect(summaries).toHaveLength(1);
      const [summary] = summaries;
      expect(summary.status).toBe("complete");
      expect(compactionOf(summary)?.auto).toBe(true);
      // The size before was the run's estimate of its next request, not a
      // measurement: the card says `~`.
      expect(compactionOf(summary)?.before_estimated).toBe(true);

      // In the run, between a tool result and the next call: the row before
      // the summary is a tool row, the one after is the nudge the run went on
      // from, and the run's next reply follows that.
      const at = rows.indexOf(summary);
      expect(rows[at - 1].authorType).toBe("tool");
      expect(rows[at + 1].authorType).toBe("user");
      expect((rows[at + 1].content as ContentBlock[])[0]).toEqual({ kind: "text", text: COMPACTION_CONTINUE_NUDGE });
      expect(rows[at + 1].authorUserId).toBeNull();
      expect(rows.slice(at + 2).some((r) => r.authorType === "assistant" && r.status === "complete")).toBe(true);

      // The next turn replays from the summary: the nudge first, nothing older.
      const history = await loadHistory(convId);
      expect(history.summaryText).not.toBeNull();
      expect(history.messages[0]).toEqual({ role: "user", content: COMPACTION_CONTINUE_NUDGE });

      const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
      // The leaf is the run's last row, past the summary.
      expect(rows.findIndex((r) => r.id === conv?.activeLeafId)).toBeGreaterThan(at);
    });

    it("leaves no continue nudge behind when the summary cannot be committed", async () => {
      // The nudge means "the conversation above was compacted": without the
      // summary in front of it, it would sit in the history as an unexplained
      // instruction, replayed on every turn after.
      const convId = await seedConversation(2);
      // The database refuses to complete this conversation's summary, as a
      // transient failure would. A trigger rather than a mock: `db` is a proxy
      // a spy cannot reach, and this fails the real statement wherever it runs.
      const name = `fail_summary_${convId.replaceAll("-", "_")}`;
      await db.execute(
        sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'commit failed'; END $$;
          CREATE TRIGGER ${name} BEFORE UPDATE ON messages FOR EACH ROW
          WHEN (NEW.conversation_id = '${convId}' AND NEW.author_type = 'summary' AND NEW.status = 'complete')
          EXECUTE FUNCTION ${name}();`),
      );
      try {
        await startChatRun({ userId, content: "work in four steps", model: "llama-3.1-8b-instruct", conversationId: convId });
        await waitFor(() => Promise.resolve(getRunByConversation(convId) ? null : true), 30_000);
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER ${name} ON messages; DROP FUNCTION ${name}();`));
      }
      const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
      const summaries = rows.filter((r) => r.authorType === "summary");
      // The run's own and the after-turn one: neither could be completed.
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every((r) => r.status === "error")).toBe(true);
      const nudges = rows.filter((r) => (r.content as ContentBlock[]).some((b) => b.kind === "text" && b.text === COMPACTION_CONTINUE_NUDGE));
      expect(nudges).toHaveLength(0);
      expect((await loadHistory(convId)).messages.some((m) => m.content === COMPACTION_CONTINUE_NUDGE)).toBe(false);
    });
  });

  it("summarises a history larger than the window in parts, each request under it", { timeout: 60_000 }, async () => {
    // Every long thread from before history stopped being dropped is like
    // this: more than the model can read at once, never summarised. Sent as
    // one request, its compaction could not fit either.
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "huge history" }).returning();
    convIds.push(conv.id);
    await db.insert(messages).values(
      Array.from({ length: 300 }, (_, i) => ({
        id: uuid(),
        conversationId: conv.id,
        authorType: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        origin: "server" as const,
        lamport: 1000 + i,
        content: [{ kind: "text", text: `message ${String(i)}: ${"words ".repeat(40)}` }] as ContentBlock[],
        status: "complete" as const,
        createdAt: new Date(1_700_000_000_000 + i),
      })),
    );
    const WINDOW = 4096; // the mock model's
    expect(estimateTallyTokens(tallyChatMessages((await loadHistory(conv.id)).messages))).toBeGreaterThan(3 * WINDOW);

    requests.length = 0;
    await startChatRun({ userId, content: "another question", model: "llama-3.1-8b-instruct", conversationId: conv.id });
    await waitFor(() => Promise.resolve(getRunByConversation(conv.id) ? null : true), 50_000);

    const summarising = requests.filter((r) => {
      const last = r.at(-1);
      return last?.role === "user" && typeof last.content === "string" && last.content.startsWith("Summarize this conversation");
    });
    expect(summarising.length).toBeGreaterThan(1);
    for (const r of summarising) expect(estimateTallyTokens(tallyChatMessages(r))).toBeLessThan(WINDOW);

    const row = await summaryRow(conv.id);
    expect(row?.status).toBe("complete");
    // The next turn starts from the summary, not from 300 messages.
    const after = await loadHistory(conv.id);
    expect(after.summaryText).not.toBeNull();
    expect(after.messages.length).toBeLessThan(10);

    // Compacted before the run's first request, the message it was started
    // for is not folded into the summary: it stays after it, and is what the
    // model is asked, rather than a nudge to "continue the task".
    expect(after.messages[0]).toEqual({ role: "user", content: "another question" });
    const answered = requests.filter((r) => !summarising.includes(r)).at(-1);
    expect(answered?.some((m) => m.role === "system" && m.content.startsWith(SUMMARY_PREAMBLE))).toBe(true);
    expect(answered?.at(-1)).toEqual({ role: "user", content: "another question" });
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
    expect(rows.some((r) => (r.content as ContentBlock[]).some((b) => b.kind === "text" && b.text === COMPACTION_CONTINUE_NUDGE))).toBe(false);
    const at = rows.findIndex((r) => r.id === row?.id);
    expect((rows[at + 1].content as ContentBlock[])[0]).toEqual({ kind: "text", text: "another question" });
    expect(rows.slice(at + 2).map((r) => r.authorType)).toEqual(["assistant"]);
  });

  it("compacts a request that would not fit at all, even with too little to compact otherwise", async () => {
    // Under the floor of eight, but the next request is over the window less a
    // reply's room: the floor is there to stop a summary being redone for
    // nothing, never to send a request that cannot fit.
    const convId = await seedConversation(0);
    await startChatRun({ userId, content: "exceed the context and make a todo list", model: "llama-3.1-8b-instruct", conversationId: convId });
    await waitFor(() => Promise.resolve(getRunByConversation(convId) ? null : true));

    const row = await summaryRow(convId);
    expect(row).not.toBeNull();
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
    expect(rows.at(-1)).toMatchObject({ authorType: "assistant", status: "complete" });
  });

  it("refuses a single message too large for the window, rather than send it to be cut off", async () => {
    // Nothing else to summarise: the message alone is over the window.
    const convId = await seedConversation(0);
    requests.length = 0;
    await startChatRun({ userId, content: `a long paste: ${"words ".repeat(5000)}`, model: "llama-3.1-8b-instruct", conversationId: convId });
    await waitFor(() => Promise.resolve(getRunByConversation(convId) ? null : true));

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    const reply = rows.find((r) => r.authorType === "assistant");
    expect(reply?.status).toBe("error");
    expect(reply?.error).toMatch(/doesn't fit the model's context/);
    // Nothing was sent.
    expect(requests).toHaveLength(0);
    expect(await summaryRow(convId)).toBeNull();
  });

  it("puts a summary after every row the conversation already has, whatever clock wrote them", async () => {
    // A run's rows take a monotonic lamport that can run ahead of the clock,
    // and a client's can come from a clock ahead of ours. A summary sorted
    // before one of them would replay it after the summary.
    const convId = await seedConversation(2);
    const ahead = Date.now() + 60_000;
    await db.insert(messages).values({
      id: uuid(),
      conversationId: convId,
      authorType: "assistant",
      origin: "server",
      lamport: ahead,
      content: [{ kind: "text", text: "from the future" }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });
    expect(await nextConversationLamport(convId)).toBe(ahead + 1);
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
