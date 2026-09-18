import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, usageRecords, user, userPrefs } from "@loxaic/db/schema";
import { CHECKIN_ANSWER_NUDGE, type ContentBlock, type StreamEventKind } from "@loxaic/types";
import { getStreamBroker, initStreamBroker } from "../../index.ts";
import { getRunByConversation } from "../../registry.ts";
import { startAgentRun } from "../agentRun.ts";
import { DEFAULT_MAX_ITERATIONS } from "../engine.ts";
import { __resetMockScenariosForTest } from "../../../inference/mock-scenarios.ts";

/**
 * A run that reaches the end of its step window asks what to do instead of
 * dying (#157).
 *
 * It used to end the stream as an *error* carrying
 * "Stopped after N tool iterations without a final answer." — a string no
 * client ever rendered, because it rode only on `stream.end` and nothing on
 * either surface reads `stream.end.error`. The visible result was a run that
 * went red with no explanation and nothing at all after a reload.
 *
 * So the assertions here are about the pause being a real, answerable state:
 * the run stays registered and holds a resolver, the durable log says why it
 * paused, and each of the three answers leads somewhere different.
 */
process.env.MOCK_INFERENCE = "true";

/** Generous next to the sub-second paths here, far below the five-minute
 * check-in timeout — a regression should time out, not pass slowly. */
const DEADLINE_MS = 10_000;

/** A scenario step that needs no sandbox, no approval on either surface, and
 * returns a byte-identical result for identical args — which is what makes it
 * usable both as ordinary progress and as a fake loop. */
function todoStep(text: string) {
  return { tool: "todo_write", args: { todos: [{ id: "1", text, status: "in_progress" }] } };
}

describe("step check-ins", () => {
  const userId = `test-checkin-${uuid()}`;
  const convIds: string[] = [];
  let dir: string;

  beforeAll(async () => {
    await initStreamBroker();
    await db.insert(user).values({
      id: userId,
      name: "Test Checkin",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    dir = mkdtempSync(path.join(tmpdir(), "step-checkin-"));
  });

  afterAll(async () => {
    for (const id of convIds) {
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

  afterEach(async () => {
    // A parked run holds an inference slot until it is answered. Leaving one
    // behind would starve every later case in this file — and, at concurrency
    // 1, other suites sharing this process.
    for (const id of convIds) {
      const run = getRunByConversation(id);
      if (run) {
        run.abort.abort();
        await waitFor("a leftover run to end", () => getRunByConversation(id) === undefined, DEADLINE_MS);
      }
    }
  });

  async function setMaxIterations(n: number): Promise<void> {
    await db
      .insert(userPrefs)
      .values({ userId, maxIterations: n, updatedAt: new Date() })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { maxIterations: n } });
  }

  async function newConversation(): Promise<string> {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: "checkin test", kind: "agent" })
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

  function useScenario(name: string, match: string, steps: unknown[], finalText: string): void {
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify([{ match, steps, finalText }]));
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();
  }

  /** The run, once it is parked and holding a resolver someone can answer. */
  async function parkedRun(convId: string) {
    await waitFor("the run to register", () => getRunByConversation(convId) !== undefined, DEADLINE_MS);
    await waitFor("the run to park at a check-in", () => !!getRunByConversation(convId)?.stepsDecision, DEADLINE_MS);
    const run = getRunByConversation(convId);
    if (!run) throw new Error("run vanished while parking");
    return run;
  }

  /** Every event the run has written so far, from the durable log — the same
   * records a reconnecting client's snapshot is folded from. */
  async function eventsOf(streamId: string): Promise<StreamEventKind[]> {
    const broker = getStreamBroker();
    return (await broker.readFrom(streamId, 0)).map((r) => r.event);
  }

  async function rowsOf(convId: string) {
    return db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
  }

  it("pauses at the end of the window instead of ending the run", async () => {
    await setMaxIterations(1);
    useScenario("budget", "plan in two steps", [todoStep("First"), todoStep("Second")], "[Mock] planned.\n");
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "plan in two steps",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    await parkedRun(convId);

    const events = await eventsOf(streamId);
    const checkin = events.find((e) => e.kind === "steps.checkin");
    expect(checkin).toMatchObject({ n: 1, max: 1, reason: "budget" });
    // A budget check-in names no pattern: nothing is repeating, the window
    // simply ran out.
    expect(checkin && "pattern" in checkin ? checkin.pattern : undefined).toBeUndefined();

    // The snapshot a client catching up mid-pause would receive.
    const broker = getStreamBroker();
    const snapshot = broker.foldSnapshot(await broker.readFrom(streamId, 0));
    expect(snapshot.pending_checkin).toMatchObject({ n: 1, max: 1, reason: "budget" });
    expect(snapshot.queued).toBeUndefined();

    // The first step's work is real and stays: one assistant turn, one tool
    // result. Nothing is marked failed.
    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "assistant" && r.model !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(1);
    expect(rows.some((r) => r.status === "error")).toBe(false);
  });

  it("grants another window on keep going, and finishes the work", async () => {
    // Cadence 2 against a two-step scenario, so the run asks exactly once:
    // the window ends on the last step that had work to do. (At cadence 1 it
    // would ask after *every* step, which is what asking every step means and
    // is asserted by the budget case above.)
    await setMaxIterations(2);
    useScenario("continue", "plan in two steps", [todoStep("First"), todoStep("Second")], "[Mock] planned.\n");
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "plan in two steps",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    const run = await parkedRun(convId);
    run.stepsDecision?.("continue", userId);

    await waitFor("the run to finish", () => getRunByConversation(convId) === undefined, DEADLINE_MS);

    const events = await eventsOf(streamId);
    expect(events.find((e) => e.kind === "steps.decision")).toEqual({
      kind: "steps.decision",
      decision: "continue",
      by: "user",
    });
    // The new window is absolute rather than a fresh count from zero, so the
    // step numbers keep climbing and the ceiling moves out under them.
    const iterations = events.filter((e) => e.kind === "iteration");
    expect(iterations).toEqual([
      { kind: "iteration", n: 1, max: 2 },
      { kind: "iteration", n: 2, max: 2 },
      { kind: "iteration", n: 3, max: 4 },
    ]);
    // ...and a client that reconnects after the answer sees no question.
    const broker = getStreamBroker();
    expect(broker.foldSnapshot(await broker.readFrom(streamId, 0)).pending_checkin).toBeUndefined();

    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(2);
    const last = rows.filter((r) => r.authorType === "assistant").at(-1);
    expect((last?.content as ContentBlock[]).some((b) => b.kind === "text" && b.text.includes("planned"))).toBe(true);
  });

  it("wraps up without running the remaining steps on answer now", async () => {
    await setMaxIterations(1);
    useScenario("answer", "plan in two steps", [todoStep("First"), todoStep("Second")], "[Mock] planned.\n");
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "plan in two steps",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    const run = await parkedRun(convId);
    run.stepsDecision?.("answer", userId);

    await waitFor("the run to finish", () => getRunByConversation(convId) === undefined, DEADLINE_MS);

    const rows = await rowsOf(convId);
    // The instruction is persisted, attributed to whoever pressed the button,
    // and hangs off the tool result it followed — so the next turn replays it
    // in exactly the position the live prompt used.
    const toolRow = rows.find((r) => r.authorType === "tool");
    const nudge = rows.find(
      (r) => r.authorType === "user" && (r.content as ContentBlock[]).some((b) => b.kind === "text" && b.text === CHECKIN_ANSWER_NUDGE),
    );
    expect(nudge).toBeDefined();
    expect(nudge?.authorUserId).toBe(userId);
    expect(nudge?.parentId).toBe(toolRow?.id);

    // The second step never ran.
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(1);
    // The final answer is text, with no tool call on it.
    const last = rows.filter((r) => r.authorType === "assistant" && r.model !== null).at(-1);
    const blocks = last?.content as ContentBlock[];
    expect(blocks.some((b) => b.kind === "tool_call")).toBe(false);
    expect(blocks.some((b) => b.kind === "text" && b.text.includes("without tools"))).toBe(true);

    const events = await eventsOf(streamId);
    expect(events.find((e) => e.kind === "steps.decision")).toMatchObject({ decision: "answer", by: "user" });
  });

  it("answers for itself when nobody replies, rather than holding the slot", async () => {
    // Read at call time precisely so a test can shorten it — see
    // approvalTimeoutMs. Restored in `finally` because vitest shares one
    // process across files.
    const previous = process.env.APPROVAL_TIMEOUT_MS;
    process.env.APPROVAL_TIMEOUT_MS = "50";
    try {
      await setMaxIterations(1);
      useScenario("timeout", "plan in two steps", [todoStep("First"), todoStep("Second")], "[Mock] planned.\n");
      const convId = await newConversation();
      const { streamId } = await startAgentRun({
        userId,
        content: "plan in two steps",
        model: "llama-3.1-8b-instruct",
        mode: "auto",
        conversationId: convId,
      });

      await waitFor("the run to finish on its own", () => getRunByConversation(convId) === undefined, DEADLINE_MS);

      const events = await eventsOf(streamId);
      expect(events.find((e) => e.kind === "steps.decision")).toEqual({
        kind: "steps.decision",
        decision: "answer",
        by: "timeout",
      });

      const rows = await rowsOf(convId);
      const nudge = rows.find(
        (r) => r.authorType === "user" && (r.content as ContentBlock[]).some((b) => b.kind === "text" && b.text === CHECKIN_ANSWER_NUDGE),
      );
      // Nobody asked for this, so nobody is credited with it.
      expect(nudge?.authorUserId).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.APPROVAL_TIMEOUT_MS;
      else process.env.APPROVAL_TIMEOUT_MS = previous;
    }
  });

  it("ends cancelled when stopped while parked, keeping the work already done", async () => {
    await setMaxIterations(1);
    useScenario("stop", "plan in two steps", [todoStep("First"), todoStep("Second")], "[Mock] planned.\n");
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "plan in two steps",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    const run = await parkedRun(convId);
    const started = Date.now();
    run.abort.abort();
    await waitFor("the run to end", () => getRunByConversation(convId) === undefined, DEADLINE_MS);
    // Not "eventually": a stop that waited out the check-in timeout would be
    // the same bug this replaced.
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS);

    const broker = getStreamBroker();
    expect((await broker.getMeta(streamId))?.status).toBe("cancelled");

    const rows = await rowsOf(convId);
    expect(rows.filter((r) => r.authorType === "tool")).toHaveLength(1);
    // Stopping is not asking for an answer.
    expect(
      rows.some((r) => (r.content as ContentBlock[]).some((b) => b.kind === "text" && b.text === CHECKIN_ANSWER_NUDGE)),
    ).toBe(false);
  });

  it("asks early when the model repeats itself, long before the window runs out", async () => {
    await setMaxIterations(DEFAULT_MAX_ITERATIONS);
    // Four identical steps: same tool, byte-identical args. The detector
    // speaks at the third, so the fourth has not run when we look.
    const same = todoStep("Investigate");
    useScenario("loop", "go round in circles", [same, same, same, same], "[Mock] stopped repeating.\n");
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "go round in circles",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    const run = await parkedRun(convId);

    const checkin = (await eventsOf(streamId)).find((e) => e.kind === "steps.checkin");
    expect(checkin).toMatchObject({ n: 3, max: DEFAULT_MAX_ITERATIONS, reason: "loop" });
    // It names what is repeating, so the client can say so rather than just
    // "something".
    expect(checkin && "pattern" in checkin ? checkin.pattern : undefined).toEqual([
      { tool: "todo_write", args: same.args },
    ]);

    // Keep going re-arms rather than switching off — but the fourth step is
    // the last, so the run finishes without asking again.
    run.stepsDecision?.("continue", userId);
    await waitFor("the run to finish", () => getRunByConversation(convId) === undefined, DEADLINE_MS);
    expect((await eventsOf(streamId)).filter((e) => e.kind === "steps.checkin")).toHaveLength(1);
    expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(4);
  });

  it("leaves a run that is making progress alone", async () => {
    await setMaxIterations(DEFAULT_MAX_ITERATIONS);
    // The same tool three times, but different arguments each time — which is
    // what working through a list looks like, and must not be mistaken for a
    // stall.
    useScenario(
      "progress",
      "work through the list",
      [todoStep("First"), todoStep("Second"), todoStep("Third")],
      "[Mock] worked through it.\n",
    );
    const convId = await newConversation();
    const { streamId } = await startAgentRun({
      userId,
      content: "work through the list",
      model: "llama-3.1-8b-instruct",
      mode: "auto",
      conversationId: convId,
    });

    await waitFor("the run to finish", () => getRunByConversation(convId) === undefined, DEADLINE_MS);
    expect((await eventsOf(streamId)).filter((e) => e.kind === "steps.checkin")).toHaveLength(0);
    expect((await rowsOf(convId)).filter((r) => r.authorType === "tool")).toHaveLength(3);
  });
});
