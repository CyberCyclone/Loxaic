import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq, inArray } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import {
  SUBAGENT_TOOL_NAME,
  parseProgressNote,
  type ContentBlock,
  type RunLimits,
  type StreamEventKind,
} from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { getRunByConversation, setRunLimits } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";
import { __resetSchedulerForTest, resetSlotProbe } from "../../../inference/scheduler.ts";

/**
 * The progress review, driven through the real tool loop against the mock
 * model: when a review happens, what each verdict does to the run, beside the
 * run or paused, and that nobody is ever asked anything.
 *
 * The mock answers a review from keywords in the task its digest quotes
 * (inference/provider.ts): `review-stuck`, `review-finished`,
 * `review-garbage`, `review-slow`, else progressing.
 */
process.env.MOCK_INFERENCE = "true";

const MODEL = "llama-3.1-8b-instruct";
const DEADLINE_MS = 20_000;

function todoStep(text: string) {
  return { tool: "todo_write", args: { todos: [{ id: "1", text, status: "in_progress" }] } };
}
const steps = (n: number) => Array.from({ length: n }, (_, i) => todoStep(`Step ${String(i + 1)}`));

describe("progress review", () => {
  const userId = `test-review-${uuid()}`;
  const convIds: string[] = [];
  let dir: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Review",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dir = mkdtempSync(path.join(tmpdir(), "progress-review-"));
  });

  afterAll(async () => {
    const children = convIds.length
      ? await db.query.conversations.findMany({ where: inArray(conversations.parentConversationId, convIds), columns: { id: true } })
      : [];
    for (const id of [...convIds, ...children.map((c) => c.id)]) {
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(usageRecords).where(eq(usageRecords.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(userPrefs).where(eq(userPrefs.userId, userId));
    await db.delete(user).where(eq(user.id, userId));
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await setPrefs({});
  });

  afterEach(async () => {
    for (const id of convIds) {
      const run = getRunByConversation(id);
      if (run) {
        run.abort.abort();
        await waitFor("a leftover run to end", () => getRunByConversation(id) === undefined, DEADLINE_MS);
      }
    }
    delete process.env.REVIEW_DEADLINE_MS;
    delete process.env.INFERENCE_MAX_CONCURRENT_RUNS;
    delete process.env.PROGRESS_CHECK_STEPS;
    resetSlotProbe();
    __resetSchedulerForTest();
  });

  /** Reviews every three steps unless a case says otherwise; a long time
   * window, so steps alone decide when. */
  async function setPrefs(values: Partial<typeof userPrefs.$inferInsert>): Promise<void> {
    const set = {
      progressReview: true,
      progressCheckMs: 8 * 60 * 60 * 1000,
      progressCheckSteps: 3,
      progressReviewPrompt: null,
      ...values,
    };
    await db
      .insert(userPrefs)
      .values({ userId, ...set, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set });
  }

  async function newConversation(limits: Partial<RunLimits> = {}): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "review test", kind: "agent", ...limits })
      .returning();
    convIds.push(conv.id);
    return conv.id;
  }

  async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = DEADLINE_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function useScenarios(list: { match: string; steps: unknown[]; finalText: string }[]): void {
    const file = path.join(dir, `${uuid()}.json`);
    writeFileSync(file, JSON.stringify(list));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  async function run(content: string, convId: string, timeoutMs = DEADLINE_MS): Promise<string> {
    const { streamId } = await startAgentRun({ userId, content, model: MODEL, mode: "auto", conversationId: convId });
    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined);
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, timeoutMs);
    return streamId;
  }

  async function eventsOf(streamId: string): Promise<StreamEventKind[]> {
    return (await getStreamBroker().readFrom(streamId, 0)).map((r) => r.event);
  }

  async function rowsOf(convId: string) {
    return db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.lamport), asc(m.createdAt)],
    });
  }

  const textOf = (content: unknown) =>
    (content as ContentBlock[]).map((b) => (b.kind === "text" ? b.text : "")).join("");

  async function notesOf(convId: string) {
    return (await rowsOf(convId))
      .filter((r) => r.authorType === "user")
      .map((r) => ({ row: r, note: parseProgressNote(textOf(r.content)) }))
      .filter((n) => n.note !== null);
  }

  const reviewsIn = (events: StreamEventKind[]) =>
    events.filter((e): e is Extract<StreamEventKind, { kind: "run.review.end" }> => e.kind === "run.review.end");

  it("leaves a run that is making progress alone, and asks nobody anything", async () => {
    useScenarios([{ match: "plan in seven steps", steps: steps(7), finalText: "[Mock] all done.\n" }]);
    const convId = await newConversation();
    const streamId = await run("plan in seven steps", convId);

    const events = await eventsOf(streamId);
    // Reviewed after step 3 and step 6, in the run's own slot: the mock
    // backend has one.
    expect(events.filter((e) => e.kind === "run.review.start")).toEqual([
      { kind: "run.review.start", mode: "paused" },
      { kind: "run.review.start", mode: "paused" },
    ]);
    expect(reviewsIn(events).map((e) => [e.verdict, e.action])).toEqual([
      ["progressing", "none"],
      ["progressing", "none"],
    ]);
    // No step limit and no question, whatever the length.
    expect(events.some((e) => (e.kind as string) === "steps.checkin")).toBe(false);
    expect(events.filter((e) => e.kind === "iteration").every((e) => !("max" in e))).toBe(true);

    expect(await notesOf(convId)).toEqual([]);
    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(7);
    expect(textOf(rows.filter((r) => r.authorType === "assistant").at(-1)?.content)).toContain("all done");
    // The snapshot a client catching up would get says nothing is under way.
    expect(getStreamBroker().foldSnapshot(await getStreamBroker().readFrom(streamId, 0)).reviewing).toBeUndefined();
  });

  it("steers a stuck run once, then has it answer when it is stuck again", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-stuck: keep reading the same file", convId);

    expect(reviewsIn(await eventsOf(streamId)).map((e) => e.action)).toEqual(["steer", "answer"]);
    const notes = await notesOf(convId);
    expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer"]);
    // Written by nobody, and saying why.
    for (const { row, note } of notes) {
      expect(row.authorUserId).toBeNull();
      expect(row.origin).toBe("server");
      expect(note?.reason).toContain("says stuck");
    }
    // Steered after step 3, so it carried on to step 6; told to answer there,
    // it ran nothing more and ended on its answer.
    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(6);
    const last = rows.at(-1);
    expect(last?.authorType).toBe("assistant");
    expect(last?.status).toBe("complete");
    expect(last?.lamport).toBeGreaterThan(notes[1].row.lamport);
  });

  it("has a run that already has its answer stop at the first review", async () => {
    useScenarios([{ match: "review-finished", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-finished: verify it again", convId);

    expect(reviewsIn(await eventsOf(streamId)).map((e) => [e.verdict, e.action])).toEqual([["finished", "answer"]]);
    expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(3);
  });

  it("leaves a run alone on one missing verdict, and has it answer on the second", async () => {
    useScenarios([{ match: "review-garbage", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-garbage: anything", convId);

    expect(reviewsIn(await eventsOf(streamId)).map((e) => [e.verdict, e.action])).toEqual([
      [null, "none"],
      [null, "answer"],
    ]);
    expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(6);
  });

  it("counts a review past its deadline as no verdict", async () => {
    process.env.REVIEW_DEADLINE_MS = "300";
    useScenarios([{ match: "review-slow", steps: steps(4), finalText: "[Mock] done slowly.\n" }]);
    const convId = await newConversation();
    const startedAt = Date.now();
    const streamId = await run("review-slow: take a while", convId);

    expect(reviewsIn(await eventsOf(streamId)).map((e) => [e.verdict, e.action])).toEqual([[null, "none"]]);
    // The mock sleeps ten minutes on a slow review; the deadline is what ended it.
    expect(Date.now() - startedAt).toBeLessThan(DEADLINE_MS);
    expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(4);
  });

  it("hands the reviewer the user's own instructions, ahead of the fixed format", async () => {
    await setPrefs({ progressReviewPrompt: "Custom reviewer instructions: be strict about repeats." });
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    await run("review-stuck: custom", convId);

    const [first] = await notesOf(convId);
    expect(first.note?.reason).toContain('instructions: "Custom reviewer instructions: be strict about repeats.');
  });

  it("does not review a conversation whose owner switched it off, or a user who turned it off", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(7), finalText: "[Mock] finished unreviewed.\n" }]);
    const off = await newConversation({ progressReviewOff: true });
    const offStream = await run("review-stuck: switched off here", off);
    expect((await eventsOf(offStream)).some((e) => e.kind === "run.review.start")).toBe(false);
    expect((await rowsOf(off)).filter((r) => r.authorType === "tool")).toHaveLength(7);

    await setPrefs({ progressReview: false });
    const conv = await newConversation();
    const stream = await run("review-stuck: turned off for the user", conv);
    expect((await eventsOf(stream)).some((e) => e.kind === "run.review.start")).toBe(false);
    expect(await notesOf(conv)).toEqual([]);
  });

  it("lets a run carry on when its switch is turned off while a review is under way", async () => {
    useScenarios([{ match: "review-stuck", steps: steps(4), finalText: "[Mock] finished unsteered.\n" }]);
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "review-stuck review-linger: switched off mid-review",
      model: MODEL,
      mode: "auto",
      conversationId: convId,
    });
    await waitFor("the review to start", async () => (await eventsOf(streamId)).some((e) => e.kind === "run.review.start"));
    const handle = getRunByConversation(convId);
    if (!handle) throw new Error("the run ended before its review");
    setRunLimits(handle, { progressReviewOff: true });
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, 40_000);

    // The verdict is still told, but acts on nothing.
    expect(reviewsIn(await eventsOf(streamId)).map((e) => [e.verdict, e.action])).toEqual([["stuck", "none"]]);
    expect(await notesOf(convId)).toEqual([]);
    expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(4);
  }, 60_000);

  it("ends cancelled when stopped while paused for a review, and says nothing more", async () => {
    useScenarios([{ match: "review-slow", steps: steps(6), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const { streamId } = await startAgentRun({ userId, content: "review-slow: stop me", model: MODEL, mode: "auto", conversationId: convId });
    await waitFor("the review to start", async () => (await eventsOf(streamId)).some((e) => e.kind === "run.review.start"));
    getRunByConversation(convId)?.abort.abort();
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined);

    expect(reviewsIn(await eventsOf(streamId))).toEqual([]);
    expect((await getStreamBroker().getMeta(streamId))?.status).toBe("cancelled");
    // The three steps it took stay, complete.
    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(3);
    expect(await notesOf(convId)).toEqual([]);
  });

  it(
    "reviews beside the run on a spare slot, and cuts a reply short to steer it",
    async () => {
      process.env.INFERENCE_MAX_CONCURRENT_RUNS = "2";
      resetSlotProbe();
      // Every request "takes its time" (eight seconds) and every review two,
      // so a review started after step 1 decides while step 2 is still being
      // written: the decision has to cut that reply short, not wait for it.
      await setPrefs({ progressCheckSteps: null });
      process.env.PROGRESS_CHECK_STEPS = "1";
      useScenarios([{ match: "take your time", steps: steps(6), finalText: "[Mock] never reached.\n" }]);
      const convId = await newConversation();
      // Three eight-second requests: step 1, step 3 and the answer.
      const startedAt = Date.now();
      const streamId = await run("take your time, review-stuck review-brief", convId, 75_000);
      // Two whole requests waited out instead of cut short would add sixteen.
      expect(Date.now() - startedAt).toBeLessThan(35_000);

      const events = await eventsOf(streamId);
      const starts = events.filter((e): e is Extract<StreamEventKind, { kind: "run.review.start" }> => e.kind === "run.review.start");
      expect(starts.map((e) => e.mode)).toEqual([
        "alongside",
        "alongside",
      ]);
      expect(reviewsIn(events).map((e) => e.action)).toEqual(["steer", "answer"]);

      // Each decision cut the reply being written short: a cancelled row,
      // which no replay sends, and the note straight after it.
      const rows = await rowsOf(convId);
      const notes = await notesOf(convId);
      expect(notes).toHaveLength(2);
      for (const { row } of notes) {
        const before = rows.filter((r) => r.lamport < row.lamport).at(-1);
        expect(before?.authorType).toBe("assistant");
        expect(before?.status).toBe("cancelled");
        expect(row.parentId).toBe(before?.id);
      }
      // Two steps finished: one before each review. The run ends on its answer.
      expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(2);
      expect(rows.at(-1)).toMatchObject({ authorType: "assistant", status: "complete" });
      expect((await getStreamBroker().getMeta(streamId))?.status).toBe("complete");
    },
    90_000,
  );

  it("tells a stuck sub-agent to report, and its parent carries on", async () => {
    useScenarios([
      {
        match: "parent hands off",
        steps: [{ tool: SUBAGENT_TOOL_NAME, args: { description: "Dig", prompt: "child review-stuck: dig in" } }],
        finalText: "[Mock] parent finished.\n",
      },
      { match: "child review-stuck", steps: steps(9), finalText: "[Mock] child never reached this.\n" },
    ]);
    const convId = await newConversation();
    const streamId = await run("parent hands off", convId);

    const [child] = await db.query.conversations.findMany({ where: eq(conversations.parentConversationId, convId) });
    expect(child).toBeDefined();
    // A sub-agent is not steered: its parent is waiting, so the first stuck
    // verdict has it answer.
    const notes = await notesOf(child.id);
    expect(notes.map((n) => n.note?.action)).toEqual(["answer"]);
    expect((await rowsOf(child.id)).filter((r) => r.authorType === "tool")).toHaveLength(3);

    // The parent got the report and ended normally.
    expect((await getStreamBroker().getMeta(streamId))?.status).toBe("complete");
    const parentRows = await rowsOf(convId);
    expect(textOf(parentRows.filter((r) => r.authorType === "assistant").at(-1)?.content)).toContain("parent finished");
  });
});
