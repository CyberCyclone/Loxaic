import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_ID, type ReviewAction, type ReviewVerdict, type RunReview } from "@loxaic/types";
import type { CompletionResult } from "../../../inference/provider.ts";
import { __resetSchedulerForTest, resetSlotProbe, schedulerState, tryAcquireReviewLane, tryAcquireRunSlot } from "../../../inference/scheduler.ts";
import { reportBackendSlots } from "../../../inference/__tests__/fake-backend-slots.ts";
import {
  DEFAULT_REVIEW_PROMPT,
  PAUSED_STEP_REVIEW_MAX_CONTEXT,
  ProgressReviewer,
  REPLY_REVIEW_CHARS,
  reviewCard,
  type ReviewRecord,
} from "../progress-review.ts";

/**
 * The reviewer's sequencing, driven directly: what it does with a decision
 * when the switch moves under it, the ceiling of a run nobody is watching, and
 * the looks it takes while a reply is still being written. The engine's own
 * use of it is progress-review-run.test.ts.
 *
 * The mock backend answers a review from keywords in the task
 * (inference/provider.ts): `review-stuck`, else progressing.
 */
process.env.MOCK_INFERENCE = "true";

const MODEL = "llama-3.1-8b-instruct";
const HOURS = 60 * 60 * 1000;

type Emitted =
  | { kind: "run.review.start"; mode: "alongside" | "paused"; review: RunReview }
  | { kind: "run.review.end"; verdict: ReviewVerdict | null; action: ReviewAction; reason?: string; review: RunReview };

/** A reviewer for a run that holds one of the backend's `slots`, as a real
 * run does: with one slot a review has to borrow the run's own. */
async function make(over: {
  slots?: number;
  /** Other runs going on the same backend, each holding a run slot. */
  otherRuns?: number;
  everyMs?: number;
  everySteps?: number;
  enabled?: boolean;
  unattended?: boolean;
  subagent?: boolean;
  limitMs?: number | null;
  task?: string;
  onStart?: () => void;
  /** What writing a review's record does; the default returns at once. */
  save?: (record: ReviewRecord) => Promise<void> | void;
}) {
  process.env.INFERENCE_MAX_CONCURRENT_RUNS = String(over.slots ?? 1);
  resetSlotProbe();
  for (let i = 0; i <= (over.otherRuns ?? 0); i++) {
    if (!(await tryAcquireRunSlot(DEFAULT_PROVIDER_ID))) throw new Error("a run's slot was not free");
  }
  const state = { worked: 0, off: false, realTime: null as number | null };
  const events: Emitted[] = [];
  const usage: CompletionResult[] = [];
  const records: ReviewRecord[] = [];
  // The newest row the run has written, as the engine would say it.
  const position = { lamport: 100 };
  const reviewer = new ProgressReviewer({
    prefs: {
      enabled: over.enabled ?? true,
      everyMs: over.everyMs ?? 8 * HOURS,
      everySteps: over.everySteps ?? 1,
      instructions: DEFAULT_REVIEW_PROMPT,
    },
    subagent: over.subagent ?? false,
    unattended: over.unattended ?? false,
    limitMs: over.limitMs ?? null,
    task: over.task ?? "review-stuck: go round again",
    model: MODEL,
    providerId: DEFAULT_PROVIDER_ID,
    thinking: {},
    runSignal: new AbortController().signal,
    workedMs: () => (state.realTime === null ? state.worked : Date.now() - state.realTime),
    switchedOff: () => state.off,
    onUsage: (result) => usage.push(result),
    // A real reply is looked at every ten seconds; a test cannot wait that.
    replyPollMs: 100,
    streamId: "stream-1",
    position: () => position.lamport,
    onReview: (record) => {
      records.push(record);
      return over.save?.(record);
    },
    emit: (event) => {
      events.push(event);
      if (event.kind === "run.review.start") over.onStart?.();
    },
  });
  const step = (contextTokens: number | null = 1_000) => {
    reviewer.recordStep({ calls: [], ms: 1, thinkingChars: 0, completionTokens: 1 }, { text: "", thinking: "", contextTokens });
  };
  return { reviewer, state, events, usage, records, position, step };
}

async function waitFor(label: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ended = (events: Emitted[]) => events.filter((e) => e.kind === "run.review.end");

describe("ProgressReviewer", () => {
  const made: ProgressReviewer[] = [];
  const track = async <T extends { reviewer: ProgressReviewer }>(making: Promise<T>): Promise<T> => {
    const m = await making;
    made.push(m.reviewer);
    return m;
  };

  afterEach(() => {
    for (const r of made.splice(0)) r.dispose();
    delete process.env.INFERENCE_MAX_CONCURRENT_RUNS;
    resetSlotProbe();
    __resetSchedulerForTest();
  });

  it("withdraws a decision that was waiting when the switch is turned off", async () => {
    const { reviewer, state, events, step } = await track(make({ slots: 2 }));
    step();
    // A spare slot: the review runs beside the run, and its decision waits.
    expect(await reviewer.atStepEnd()).toBeNull();
    await waitFor("the review to end", () => ended(events).length === 1);
    await waitFor("its decision to be waiting", () => reviewer.hasDecision());

    state.off = true;
    expect(reviewer.hasDecision()).toBe(false);
    expect(reviewer.takeReady()).toBeNull();
    // Gone for good: turning the switch back on does not bring it back.
    state.off = false;
    expect(reviewer.takeReady()).toBeNull();
  });

  it("does not count a verdict nobody acted on towards the next one", async () => {
    const m = await track(
      make({
        // The switch goes off as the first review starts, and so is off when
        // its verdict lands.
        onStart: () => {
          if (ended(m.events).length === 0) m.state.off = true;
        },
      }),
    );
    m.step();
    expect(await m.reviewer.atStepEnd()).toBeNull();
    expect(ended(m.events)).toMatchObject([{ verdict: "stuck", action: "none" }]);

    // Back on: this is the first stuck verdict that counts, so it steers.
    m.state.off = false;
    m.step();
    expect(await m.reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });
  });

  it("holds a run nobody is watching to its working time, whatever its user's setting", async () => {
    const { reviewer, state, events, usage, records, step } = await track(
      make({ unattended: true, subagent: true, enabled: false, limitMs: 4 * HOURS, everySteps: 500, task: "an ordinary task" }),
    );
    state.worked = 4 * HOURS - 1;
    step();
    expect(await reviewer.atStepEnd()).toBeNull();
    state.worked = 4 * HOURS;
    step();
    const over = await reviewer.atStepEnd();
    expect(over).toMatchObject({ verdict: null, action: "answer", forced: true });
    expect(over?.reason).toBe("This sub-agent has been working for 4.0 h, the most a run nobody is watching gets.");
    // Said once, and not by a review: nothing was sent to a model.
    step();
    expect(await reviewer.atStepEnd()).toBeNull();
    expect(usage).toEqual([]);
    // It is recorded and carded like a review all the same, so the thread
    // says why the run ended: an end with no start, and no model or digest.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ mode: null, trigger: "limit", step: 2, workedMs: 4 * HOURS, lamport: 100, forced: true, action: "answer", digest: "", result: null });
    expect(events).toEqual([
      { kind: "run.review.end", verdict: null, reason: over?.reason, action: "answer", review: reviewCard("stream-1", records[0]) },
    ]);
    expect(events[0].review).toMatchObject({ trigger: "limit", forced: true, mode: null });
  });

  it("gives a run a person started no ceiling", async () => {
    const { reviewer, state, step } = await track(make({ everySteps: 500, task: "an ordinary task" }));
    state.worked = 100 * HOURS;
    step();
    // Due on time, so it is reviewed (progressing), but never cut off.
    expect(await reviewer.atStepEnd()).toBeNull();
  });

  it("reviews a run nobody is watching even when its user turned reviews off", async () => {
    const { reviewer, step } = await track(make({ unattended: true, subagent: true, enabled: false }));
    step();
    expect(await reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "answer" });
  });

  it("does not review a watched run whose user turned reviews off", async () => {
    const { reviewer, events, step } = await track(make({ enabled: false }));
    step();
    expect(await reviewer.atStepEnd()).toBeNull();
    expect(events).toEqual([]);
  });

  it("cuts a reply short at the ceiling, with no slot to spare and the switch off", async () => {
    const { reviewer, state } = await track(make({ unattended: true, limitMs: 300, enabled: false, everySteps: 500 }));
    state.realTime = Date.now();
    state.off = true;
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const stop = reviewer.watchRequest(() => ({ text: "", thinking: "still going", startedAt: Date.now() }));
    await waitFor("the reply to be cut short", () => interrupt.mock.calls.length > 0);
    stop();
    // The ceiling is not a review's opinion: the switch does not withdraw it.
    expect(reviewer.hasDecision()).toBe(true);
    expect(reviewer.takeReady()).toMatchObject({ action: "answer", forced: true });
  });

  it("reviews a reply that outlasts the time cadence, beside it, and cuts it short on the verdict", async () => {
    const { reviewer, state, events } = await track(make({ slots: 2, everyMs: 300, everySteps: 500 }));
    state.realTime = Date.now();
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const stop = reviewer.watchRequest(() => ({ text: "", thinking: "round and round", startedAt: Date.now() }));
    await waitFor("the reply to be cut short", () => interrupt.mock.calls.length > 0);
    stop();
    expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
    expect(ended(events)).toMatchObject([{ verdict: "stuck", action: "steer" }]);
    expect(reviewer.takeReady()).toMatchObject({ action: "steer" });
  });

  it("reviews a reply each time it has written a lot without acting, however little time has passed", async () => {
    // Eight hours between reviews on the clock: only the reply's size is due.
    const { reviewer, events } = await track(make({ slots: 2, everySteps: 500, task: "an ordinary task" }));
    const reply = { text: "", thinking: "x".repeat(REPLY_REVIEW_CHARS - 1), startedAt: Date.now() };
    const stop = reviewer.watchRequest(() => reply);
    await new Promise((r) => setTimeout(r, 400));
    // Just short of it: left alone.
    expect(events).toEqual([]);

    reply.thinking += "x";
    await waitFor("the review of the reply", () => ended(events).length === 1);
    expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
    // Looked at then: not again for writing a little more...
    reply.thinking += "x".repeat(REPLY_REVIEW_CHARS - 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(ended(events)).toHaveLength(1);
    // ...but again once it has written as much again.
    reply.thinking += "x";
    await waitFor("the second review of the reply", () => ended(events).length === 2);
    stop();
  });

  it("cuts a reply that is going round short on the verdict of a look at it", async () => {
    const { reviewer, events } = await track(make({ slots: 2, everySteps: 500 }));
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const stop = reviewer.watchRequest(() => ({ text: "", thinking: "y".repeat(REPLY_REVIEW_CHARS), startedAt: Date.now() }));
    await waitFor("the reply to be cut short", () => interrupt.mock.calls.length > 0);
    stop();
    expect(ended(events)).toMatchObject([{ verdict: "stuck", action: "steer" }]);
  });

  it("does not review a reply that has started writing its answer, on the clock or by size", async () => {
    // A slot to spare and both cadences due: only the words hold it back.
    const { reviewer, state, events } = await track(make({ slots: 2, everyMs: 200, everySteps: 500 }));
    state.realTime = Date.now();
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const reply = { text: "Section 1. The design", thinking: "y".repeat(REPLY_REVIEW_CHARS * 2), startedAt: Date.now() };
    const stop = reviewer.watchRequest(() => reply);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(events).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();
    // The same reply with nothing but blank space written is still only
    // thinking, and is reviewed.
    reply.text = " \n";
    await waitFor("the reply to be cut short", () => interrupt.mock.calls.length > 0);
    stop();
    expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
  });

  it("does not cut a reply that began its answer while the review of its thinking ran", async () => {
    // The mock's reviewer takes two seconds ("review-brief") to say stuck.
    const { reviewer, events, step } = await track(make({ slots: 2, everySteps: 500, task: "review-stuck review-brief: go round" }));
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const reply = { text: "", thinking: "y".repeat(REPLY_REVIEW_CHARS), startedAt: Date.now() };
    const stop = reviewer.watchRequest(() => reply);
    await waitFor("the review to start", () => events.some((e) => e.kind === "run.review.start"));
    reply.text = "Here is the document.";
    await waitFor("the review to end", () => ended(events).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    // The verdict stands and is said, but the reply is left to finish.
    expect(ended(events)).toMatchObject([{ verdict: "stuck", action: "steer" }]);
    expect(interrupt).not.toHaveBeenCalled();
    // It waits for the step's end, like a decision that lands between requests.
    expect(reviewer.hasDecision()).toBe(true);
    stop();
    step();
    expect(await reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });
  });

  it("still cuts a reply that is only thinking when the verdict lands", async () => {
    const { reviewer, events } = await track(make({ slots: 2, everySteps: 500, task: "review-stuck review-brief: go round" }));
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const reply = { text: "", thinking: "y".repeat(REPLY_REVIEW_CHARS), startedAt: Date.now() };
    const stop = reviewer.watchRequest(() => reply);
    await waitFor("the review to start", () => events.some((e) => e.kind === "run.review.start"));
    reply.thinking += " and more of the same";
    await waitFor("the reply to be cut short", () => interrupt.mock.calls.length > 0);
    stop();
    expect(reviewer.takeReady()).toMatchObject({ action: "steer" });
  });

  it("cuts a reply at the ceiling even when it is writing its answer", async () => {
    const { reviewer, state } = await track(make({ slots: 2, unattended: true, subagent: true, limitMs: 300, everySteps: 500 }));
    state.realTime = Date.now();
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const stop = reviewer.watchRequest(() => ({ text: "Half the report is written", thinking: "", startedAt: Date.now() }));
    await waitFor("the ceiling to cut the reply", () => interrupt.mock.calls.length > 0);
    stop();
    expect(reviewer.takeReady()).toMatchObject({ action: "answer", forced: true });
  });

  it("leaves a long reply alone when there is no slot to review it on", async () => {
    const { reviewer, state, events } = await track(make({ slots: 1, everyMs: 200, everySteps: 500 }));
    state.realTime = Date.now();
    const interrupt = vi.fn();
    reviewer.interrupt = interrupt;
    const stop = reviewer.watchRequest(() => ({ text: "", thinking: "long but fine", startedAt: Date.now() }));
    await new Promise((r) => setTimeout(r, 1_000));
    stop();
    // The one slot is the run's own, and a reply cannot be paused half-written.
    expect(events).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("stops looking once the request is over", async () => {
    const { reviewer, state, events } = await track(make({ slots: 2, everyMs: 300, everySteps: 500 }));
    state.realTime = Date.now();
    reviewer.watchRequest(() => ({ text: "", thinking: "", startedAt: Date.now() }))();
    await new Promise((r) => setTimeout(r, 800));
    expect(events).toEqual([]);
  });

  it("pauses a run with a large context for the time cadence only", async () => {
    const big = PAUSED_STEP_REVIEW_MAX_CONTEXT + 1;
    // One slot, so a review would have to take the run's own.
    const m = await track(make({ slots: 1, everyMs: 30 * 60_000, everySteps: 1 }));
    m.step(big);
    // Due on steps: not worth making the run read 100K tokens again.
    expect(await m.reviewer.atStepEnd()).toBeNull();
    expect(m.events).toEqual([]);
    // Due on time: it is.
    m.state.worked = 30 * 60_000;
    expect(await m.reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });
    expect(m.events[0]).toMatchObject({ kind: "run.review.start", mode: "paused" });

    // A small context pauses for either.
    __resetSchedulerForTest();
    const small = await track(make({ slots: 1, everySteps: 1 }));
    small.step(PAUSED_STEP_REVIEW_MAX_CONTEXT);
    expect(await small.reviewer.atStepEnd()).toMatchObject({ action: "steer" });
  });

  it("reviews a large context on the step cadence when a slot is spare", async () => {
    const { reviewer, events, step } = await track(make({ slots: 2, everySteps: 1 }));
    step(PAUSED_STEP_REVIEW_MAX_CONTEXT * 5);
    expect(await reviewer.atStepEnd()).toBeNull();
    await waitFor("the review to end", () => ended(events).length === 1);
    expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
  });

  describe("with every run slot taken", () => {
    // Two runs allowed and both going, as on the box this was found on.
    let undo: (() => Promise<void>) | null = null;
    afterEach(async () => {
      await undo?.();
      undo = null;
    });
    /** The run's model loaded with `slots` slots, on a router that also
     * serves a second model, not loaded. */
    const modelSlots = async (slots: number) => (await reportBackendSlots([{ id: MODEL, slots }, { slots: null }])).undo;

    it("reviews beside the run at a step boundary when the backend has slots the limit leaves idle", async () => {
      undo = await modelSlots(4);
      const lane: boolean[] = [];
      const { reviewer, events, step } = await track(
        make({ slots: 2, otherRuns: 1, everySteps: 1, onStart: () => lane.push(schedulerState().reviewLane) }),
      );
      step();
      // Not paused: nothing is handed back to wait on.
      expect(await reviewer.atStepEnd()).toBeNull();
      await waitFor("the review to end", () => ended(events).length === 1);
      expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
      expect(reviewer.takeReady()).toMatchObject({ verdict: "stuck", action: "steer" });
      // On the lane, beside both runs, and given back when it ended.
      expect(lane).toEqual([true]);
      await waitFor("the lane to be free", () => !schedulerState().reviewLane);
      expect(schedulerState().running).toBe(2);
    });

    it("looks at a long reply while it is written, which nothing did before", async () => {
      undo = await modelSlots(4);
      const { reviewer, events } = await track(make({ slots: 2, otherRuns: 1, everySteps: 500 }));
      const interrupt = vi.fn();
      reviewer.interrupt = interrupt;
      const stop = reviewer.watchRequest(() => ({ text: "", thinking: "y".repeat(REPLY_REVIEW_CHARS), startedAt: Date.now() }));
      await waitFor("the reply to be cut short", () => interrupt.mock.calls.length > 0);
      stop();
      expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
      expect(ended(events)).toMatchObject([{ verdict: "stuck", action: "steer" }]);
    });

    it("takes a spare run slot before the lane when there is one", async () => {
      undo = await modelSlots(4);
      const lane: boolean[] = [];
      const { reviewer, events, step } = await track(make({ slots: 2, everySteps: 1, onStart: () => lane.push(schedulerState().reviewLane) }));
      step();
      expect(await reviewer.atStepEnd()).toBeNull();
      await waitFor("the review to end", () => ended(events).length === 1);
      expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "alongside" });
      expect(lane).toEqual([false]);
    });

    it("pauses the run as before when the backend has no more slots than the limit", async () => {
      undo = await modelSlots(2);
      const { reviewer, state, events, step } = await track(make({ slots: 2, otherRuns: 1, everyMs: 200, everySteps: 1 }));
      step();
      expect(await reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });
      expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "paused" });
      // And a reply being written has nowhere to be reviewed.
      state.realTime = Date.now();
      const interrupt = vi.fn();
      reviewer.interrupt = interrupt;
      const stop = reviewer.watchRequest(() => ({ text: "", thinking: "long but fine", startedAt: Date.now() }));
      await new Promise((r) => setTimeout(r, 1_000));
      stop();
      expect(events.filter((e) => e.kind === "run.review.start")).toHaveLength(1);
      expect(interrupt).not.toHaveBeenCalled();
    });

    it("pauses the run when its own model is not the loaded one with slots to spare", async () => {
      // Four slots, but on the other model: nothing says this run's has any.
      undo = (await reportBackendSlots([{ id: MODEL, slots: null }, { slots: 4 }])).undo;
      const { reviewer, events, step } = await track(make({ slots: 2, otherRuns: 1, everySteps: 1 }));
      step();
      expect(await reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });
      expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "paused" });
    });

    it("pauses the run when another review already has the lane", async () => {
      undo = await modelSlots(4);
      const { reviewer, events, step } = await track(make({ slots: 2, otherRuns: 1, everySteps: 1 }));
      const taken = await tryAcquireReviewLane(DEFAULT_PROVIDER_ID, MODEL);
      expect(taken).not.toBeNull();
      step();
      expect(await reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });
      expect(events[0]).toMatchObject({ kind: "run.review.start", mode: "paused" });
      taken?.release();
    });
  });

  describe("a review's record", () => {
    it("says where the run stood when the review started, what was read and what came of it", async () => {
      const { reviewer, state, events, records, position, step } = await track(make({ everySteps: 2 }));
      state.worked = 1_234;
      step();
      expect(await reviewer.atStepEnd()).toBeNull();
      step();
      position.lamport = 250;
      const before = Date.now();
      expect(await reviewer.atStepEnd()).toMatchObject({ verdict: "stuck", action: "steer" });

      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record).toMatchObject({ mode: "paused", trigger: "steps", step: 2, workedMs: 1_234, lamport: 250, verdict: "stuck", action: "steer", forced: false });
      expect(record.reason).toContain("says stuck");
      expect(record.startedAt).toBeGreaterThanOrEqual(before);
      expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt);
      // The digest the reviewer read, and the request it cost.
      expect(record.digest).toContain("review-stuck: go round again");
      expect(record.digest).not.toContain(DEFAULT_REVIEW_PROMPT.slice(0, 40));
      expect(record.result?.usage.completion_tokens).toBeGreaterThan(0);

      // Its card: under way at the start, the same id finished at the end.
      const [start, end] = events;
      expect(start).toEqual({
        kind: "run.review.start",
        mode: "paused",
        review: { id: record.id, stream_id: "stream-1", lamport: 250, step: 2, worked_ms: 1_234, mode: "paused", trigger: "steps", started_at: record.startedAt },
      });
      expect(end.review).toEqual({ ...start.review, ended_at: record.endedAt, verdict: "stuck", reason: record.reason, action: "steer" });
      expect(end.review).toEqual(reviewCard("stream-1", record));
    });

    it("is written before the review is said to have ended", async () => {
      let saved = false;
      const m = await track(
        make({
          save: async () => {
            await new Promise((r) => setTimeout(r, 150));
            saved = true;
          },
        }),
      );
      m.step();
      const deciding = m.reviewer.atStepEnd();
      await waitFor("the record to be handed over", () => m.records.length === 1);
      expect(ended(m.events)).toEqual([]);
      await deciding;
      expect(saved).toBe(true);
      expect(ended(m.events)).toHaveLength(1);
    });

    it("says nothing when the run ended while it was being written", async () => {
      const m = await track(
        make({
          slots: 2,
          save: async () => {
            m.reviewer.dispose();
            await new Promise((r) => setTimeout(r, 50));
          },
        }),
      );
      m.step();
      expect(await m.reviewer.atStepEnd()).toBeNull();
      await waitFor("the record to be handed over", () => m.records.length === 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(ended(m.events)).toEqual([]);
      expect(m.reviewer.hasDecision()).toBe(false);
    });

    it("names the cadence that made it due: time at a step, time or size mid-reply", async () => {
      const onTime = await track(make({ everyMs: 1_000, everySteps: 500, task: "an ordinary task" }));
      onTime.state.worked = 1_000;
      onTime.step();
      await onTime.reviewer.atStepEnd();
      expect(onTime.records.map((r) => [r.trigger, r.mode, r.verdict, r.action])).toEqual([["time", "paused", "progressing", "none"]]);

      __resetSchedulerForTest();
      const bySize = await track(make({ slots: 2, everySteps: 500, task: "an ordinary task" }));
      const stopSize = bySize.reviewer.watchRequest(() => ({ text: "", thinking: "x".repeat(REPLY_REVIEW_CHARS), startedAt: Date.now() }));
      await waitFor("the review of the reply", () => bySize.records.length === 1);
      stopSize();
      expect(bySize.records.map((r) => [r.trigger, r.mode, r.step])).toEqual([["in-reply", "alongside", 0]]);
      // The digest it read had the reply still being written in it.
      expect(bySize.records[0].digest).toContain("xxxxxxxx");

      __resetSchedulerForTest();
      const midReply = await track(make({ slots: 2, everyMs: 300, everySteps: 500, task: "an ordinary task" }));
      midReply.state.realTime = Date.now();
      const stopTime = midReply.reviewer.watchRequest(() => ({ text: "", thinking: "short", startedAt: Date.now() }));
      await waitFor("the review on time", () => midReply.records.length === 1);
      stopTime();
      expect(midReply.records.map((r) => [r.trigger, r.mode])).toEqual([["time", "alongside"]]);
    });

    it("is not kept for a review a stop abandoned", async () => {
      const m = await track(make({ task: "review-slow: wait" }));
      m.step();
      const deciding = m.reviewer.atStepEnd();
      await waitFor("the review to start", () => m.events.length === 1);
      m.reviewer.dispose();
      expect(await deciding).toBeNull();
      expect(m.records).toEqual([]);
      expect(ended(m.events)).toEqual([]);
    });
  });

  it("hands every finished review's usage on, once", async () => {
    const { reviewer, usage, step } = await track(make({}));
    step();
    await reviewer.atStepEnd();
    step();
    await reviewer.atStepEnd();
    expect(usage).toHaveLength(2);
    expect(usage[0].usage.completion_tokens).toBeGreaterThan(0);
  });
});
