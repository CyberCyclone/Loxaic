import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_ID, type ReviewAction, type ReviewVerdict } from "@loxaic/types";
import type { CompletionResult } from "../../../inference/provider.ts";
import { __resetSchedulerForTest, resetSlotProbe, tryAcquireRunSlot } from "../../../inference/scheduler.ts";
import { DEFAULT_REVIEW_PROMPT, PAUSED_STEP_REVIEW_MAX_CONTEXT, ProgressReviewer, REPLY_REVIEW_CHARS } from "../progress-review.ts";

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
  | { kind: "run.review.start"; mode: "alongside" | "paused" }
  | { kind: "run.review.end"; verdict: ReviewVerdict | null; action: ReviewAction; reason?: string };

/** A reviewer for a run that holds one of the backend's `slots`, as a real
 * run does: with one slot a review has to borrow the run's own. */
async function make(over: {
  slots?: number;
  everyMs?: number;
  everySteps?: number;
  enabled?: boolean;
  unattended?: boolean;
  subagent?: boolean;
  limitMs?: number | null;
  task?: string;
  onStart?: () => void;
}) {
  process.env.INFERENCE_MAX_CONCURRENT_RUNS = String(over.slots ?? 1);
  resetSlotProbe();
  if (!(await tryAcquireRunSlot(DEFAULT_PROVIDER_ID))) throw new Error("the run's own slot was not free");
  const state = { worked: 0, off: false, realTime: null as number | null };
  const events: Emitted[] = [];
  const usage: CompletionResult[] = [];
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
    emit: (event) => {
      events.push(event);
      if (event.kind === "run.review.start") over.onStart?.();
    },
  });
  const step = (contextTokens: number | null = 1_000) => {
    reviewer.recordStep({ calls: [], ms: 1, thinkingChars: 0, completionTokens: 1 }, { text: "", thinking: "", contextTokens });
  };
  return { reviewer, state, events, usage, step };
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
    const { reviewer, state, events, step } = await track(
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
    expect(events).toEqual([]);
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
    expect(events[0]).toEqual({ kind: "run.review.start", mode: "alongside" });
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
    expect(events[0]).toEqual({ kind: "run.review.start", mode: "alongside" });
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
    expect(m.events[0]).toEqual({ kind: "run.review.start", mode: "paused" });

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
    expect(events[0]).toEqual({ kind: "run.review.start", mode: "alongside" });
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
