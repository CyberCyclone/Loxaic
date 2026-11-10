import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { and, db, eq, inArray } from "@loxaic/db";
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
import { startChatRun } from "../chatRun.ts";
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
    delete process.env.PROGRESS_CHECK_MS;
    delete process.env.UNATTENDED_RUN_LIMIT_MS;
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
    // Each review is a request with real tokens: recorded, and never as the turn.
    const reviewUsage = await db.query.usageRecords.findMany({
      where: and(eq(usageRecords.conversationId, convId), eq(usageRecords.purpose, "progress_review")),
    });
    expect(reviewUsage).toHaveLength(2);
    for (const row of reviewUsage) {
      expect(row.messageId).toBeNull();
      expect(row.runId).toBe(streamId);
      expect(row.outputTokens).toBeGreaterThan(0);
    }
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

  it("tells a run called finished so once, and has it answer when the next review says it again", async () => {
    useScenarios([{ match: "review-finished", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const convId = await newConversation();
    const streamId = await run("review-finished: verify it again", convId);

    // One verdict alone never ends a run a person started: a reviewer that is
    // wrong once costs it a note, not its work.
    expect(reviewsIn(await eventsOf(streamId)).map((e) => [e.verdict, e.action])).toEqual([
      ["finished", "steer"],
      ["finished", "answer"],
    ]);
    expect((await notesOf(convId)).map((n) => n.note?.action)).toEqual(["steer", "answer"]);
    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(6);
    expect(rows.at(-1)?.authorType).toBe("assistant");
    expect(rows.at(-1)?.status).toBe("complete");
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

  it(
    "reviews on working time alone, however few the steps",
    async () => {
      // Five hundred steps between reviews, three seconds of work: only the
      // clock can make this one due. One slow step is eight seconds.
      await setPrefs({ progressCheckMs: null, progressCheckSteps: 500 });
      process.env.PROGRESS_CHECK_MS = "3000";
      useScenarios([{ match: "take your time", steps: steps(1), finalText: "[Mock] done slowly.\n" }]);
      const convId = await newConversation();
      const streamId = await run("take your time over one step", convId, 60_000);

      const events = await eventsOf(streamId);
      expect(events.filter((e) => e.kind === "run.review.start")).toEqual([{ kind: "run.review.start", mode: "paused" }]);
      expect(reviewsIn(events).map((e) => [e.verdict, e.action])).toEqual([["progressing", "none"]]);
      expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(1);
    },
    90_000,
  );

  it(
    "reviews a reply still being written once it outlasts the time cadence, and cuts it short",
    async () => {
      process.env.INFERENCE_MAX_CONCURRENT_RUNS = "2";
      resetSlotProbe();
      // Every reply takes eight seconds and a review is due after two of
      // work, so each review starts and decides inside a reply: no step ever
      // finishes for a review to wait for.
      await setPrefs({ progressCheckMs: null, progressCheckSteps: 500 });
      process.env.PROGRESS_CHECK_MS = "2000";
      useScenarios([{ match: "take your time", steps: steps(6), finalText: "[Mock] never reached.\n" }]);
      const convId = await newConversation();
      const streamId = await run("take your time, review-stuck", convId, 75_000);

      const events = await eventsOf(streamId);
      expect(events.filter((e) => e.kind === "run.review.start")).toEqual([
        { kind: "run.review.start", mode: "alongside" },
        { kind: "run.review.start", mode: "alongside" },
      ]);
      expect(reviewsIn(events).map((e) => e.action)).toEqual(["steer", "answer"]);
      // Not one tool ran: both replies were cut short before their call.
      const rows = await rowsOf(convId);
      expect(rows.filter((r) => r.authorType === "tool")).toEqual([]);
      const notes = await notesOf(convId);
      expect(notes.map((n) => n.note?.action)).toEqual(["steer", "answer"]);
      for (const { row } of notes) {
        const cut = rows.filter((r) => r.lamport < row.lamport).at(-1);
        expect(cut).toMatchObject({ authorType: "assistant", status: "cancelled", content: [] });
        // Nothing of it was written (the mock is slow to its first word), so
        // a client is told to drop it, not to show a blank stopped reply
        // above the note.
        expect(events.filter((e) => e.kind === "message.end" && e.message_id === cut?.id)).toEqual([
          { kind: "message.end", message_id: cut?.id, status: "cancelled", discard: true },
        ]);
      }
      expect(rows.at(-1)).toMatchObject({ authorType: "assistant", status: "complete" });
    },
    90_000,
  );

  it("still reviews a sub-agent whose user has turned reviews off", async () => {
    await setPrefs({ progressReview: false });
    useScenarios([
      {
        match: "parent hands off",
        steps: [{ tool: SUBAGENT_TOOL_NAME, args: { description: "Dig", prompt: "child review-stuck: dig in" } }],
        finalText: "[Mock] parent finished.\n",
      },
      { match: "child review-stuck", steps: steps(9), finalText: "[Mock] child never reached this.\n" },
    ]);
    const convId = await newConversation();
    await run("parent hands off", convId);

    const [child] = await db.query.conversations.findMany({ where: eq(conversations.parentConversationId, convId) });
    // The setting is for runs its user is in. Nobody is in this one.
    expect((await notesOf(child.id)).map((n) => n.note?.action)).toEqual(["answer"]);
    expect((await rowsOf(child.id)).filter((r) => r.authorType === "tool")).toHaveLength(3);
  });

  it("still reviews a routine's run whose user has turned reviews off", async () => {
    await setPrefs({ progressReview: false });
    useScenarios([{ match: "review-stuck", steps: steps(12), finalText: "[Mock] never reached.\n" }]);
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: "Routine: nightly", kind: "routine" }).returning();
    convIds.push(conv.id);
    const { streamId } = await startChatRun({ userId, content: "review-stuck: the nightly job", model: MODEL, conversationId: conv.id, recordUse: false });
    await waitFor("the run to register", () => getRunByConversation(conv.id) !== undefined);
    await waitFor("the run to end", () => getRunByConversation(conv.id) === undefined);

    expect(reviewsIn(await eventsOf(streamId)).map((e) => e.action)).toEqual(["steer", "answer"]);
    expect((await rowsOf(conv.id)).filter((r) => r.authorType === "tool")).toHaveLength(6);
  });

  it(
    "ends a sub-agent at its working-time ceiling, mid-reply, with reviews off and nothing found wrong",
    async () => {
      await setPrefs({ progressReview: false, progressCheckSteps: 500 });
      process.env.UNATTENDED_RUN_LIMIT_MS = "2000";
      useScenarios([
        {
          match: "parent hands off",
          steps: [{ tool: SUBAGENT_TOOL_NAME, args: { description: "Dig", prompt: "child take your time: dig in" } }],
          finalText: "[Mock] parent finished.\n",
        },
        { match: "child take your time", steps: steps(9), finalText: "[Mock] child never reached this.\n" },
      ]);
      const convId = await newConversation();
      const streamId = await run("parent hands off", convId, 60_000);

      const [child] = await db.query.conversations.findMany({ where: eq(conversations.parentConversationId, convId) });
      const notes = await notesOf(child.id);
      expect(notes.map((n) => n.note?.action)).toEqual(["answer"]);
      expect(notes[0].note?.reason).toContain("the most a run nobody is watching gets");
      // Two seconds into its first eight-second reply: that reply was cut
      // short, and it ran nothing.
      const childRows = await rowsOf(child.id);
      expect(childRows.filter((r) => r.authorType === "tool")).toEqual([]);
      expect(childRows.filter((r) => r.lamport < notes[0].row.lamport).at(-1)).toMatchObject({ authorType: "assistant", status: "cancelled" });
      expect(childRows.at(-1)).toMatchObject({ authorType: "assistant", status: "complete" });

      // Its parent, which a person started, has no ceiling and got the report.
      expect(await notesOf(convId)).toEqual([]);
      expect((await getStreamBroker().getMeta(streamId))?.status).toBe("complete");
      expect(textOf((await rowsOf(convId)).filter((r) => r.authorType === "assistant").at(-1)?.content)).toContain("parent finished");
    },
    90_000,
  );

  it("has a sub-agent report when its review gives no verdict in time", async () => {
    process.env.REVIEW_DEADLINE_MS = "300";
    useScenarios([
      {
        match: "parent hands off",
        steps: [{ tool: SUBAGENT_TOOL_NAME, args: { description: "Dig", prompt: "child review-slow: dig in" } }],
        finalText: "[Mock] parent finished.\n",
      },
      { match: "child review-slow", steps: steps(9), finalText: "[Mock] child never reached this.\n" },
    ]);
    const convId = await newConversation();
    const streamId = await run("parent hands off", convId);

    const [child] = await db.query.conversations.findMany({ where: eq(conversations.parentConversationId, convId) });
    const notes = await notesOf(child.id);
    // No verdict and no reason: it is told to answer all the same.
    expect(notes.map((n) => n.note?.action)).toEqual(["answer"]);
    expect(notes[0].note?.reason).toMatch(/does not look like/);
    expect((await rowsOf(child.id)).filter((r) => r.authorType === "tool")).toHaveLength(3);
    expect((await getStreamBroker().getMeta(streamId))?.status).toBe("complete");
  });

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
