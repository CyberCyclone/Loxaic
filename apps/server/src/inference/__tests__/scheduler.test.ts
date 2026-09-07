import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetSchedulerForTest,
  acquireRunSlot,
  RunSlotAbortedError,
  resolveMaxConcurrent,
  resetSlotProbe,
  schedulerState,
} from "../scheduler.ts";

/**
 * The queue's job is to stop two conversations interleaving their requests to
 * a backend that can only hold one cached prompt prefix. These cases are about
 * the ordering guarantees that follow from that — and about the two places
 * where getting it wrong strands a run forever rather than merely slowing it.
 */
/**
 * The env pin is read at call time, so nothing here touches the shared
 * settings cache. Deliberately: `resetServerSettingsCache()` is process-global
 * and files run in one worker, so clearing it mid-run made another suite's
 * `updateSandboxSettings` see a changed value, sweep every live sandbox, and
 * fail four unrelated container tests.
 */
function pin(max: number) {
  process.env.INFERENCE_MAX_CONCURRENT_RUNS = String(max);
  resetSlotProbe();
}

const noop = () => undefined;

beforeEach(() => {
  __resetSchedulerForTest();
  pin(1);
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "INFERENCE_MAX_CONCURRENT_RUNS");
  __resetSchedulerForTest();
});

/** A never-aborted signal, which is what an ordinary run has. */
function live(): AbortSignal {
  return new AbortController().signal;
}

describe("one slot", () => {
  it("admits the first run and makes the second wait", async () => {
    const first = await acquireRunSlot({ signal: live(), onQueued: noop });
    expect(first).not.toBeNull();

    let secondAdmitted = false;
    const second = acquireRunSlot({ signal: live(), onQueued: noop }).then((s) => {
      secondAdmitted = true;
      return s;
    });

    await Promise.resolve();
    expect(secondAdmitted).toBe(false);
    expect(schedulerState()).toEqual({ running: 1, waiting: 1 });

    first?.release();
    expect(await second).not.toBeNull();
    expect(schedulerState().running).toBe(1);
  });

  it("admits waiters in the order they arrived", async () => {
    const first = await acquireRunSlot({ signal: live(), onQueued: noop });
    const order: string[] = [];
    const a = acquireRunSlot({ signal: live(), onQueued: noop }).then((s) => { order.push("a"); return s; });
    const b = acquireRunSlot({ signal: live(), onQueued: noop }).then((s) => { order.push("b"); return s; });

    first?.release();
    (await a)?.release();
    (await b)?.release();

    expect(order).toEqual(["a", "b"]);
  });

  it("tells each waiter its place, and counts it down as the queue moves", async () => {
    const first = await acquireRunSlot({ signal: live(), onQueued: noop });
    const positions: number[] = [];
    const a = acquireRunSlot({ signal: live(), onQueued: noop });
    const b = acquireRunSlot({ signal: live(), onQueued: (p) => positions.push(p) });

    // b joins behind a, then moves up when a is admitted. A single number sent
    // once would leave the client showing "#2" for the rest of the wait.
    await Promise.resolve();
    expect(positions[0]).toBe(2);

    first?.release();
    (await a)?.release();
    (await b)?.release();
    expect(positions).toContain(1);
  });
});

describe("more slots than runs", () => {
  it("does not queue at all when the backend can hold several prefixes", async () => {
    pin(3);
    const slots = await Promise.all([
      acquireRunSlot({ signal: live(), onQueued: noop }),
      acquireRunSlot({ signal: live(), onQueued: noop }),
      acquireRunSlot({ signal: live(), onQueued: noop }),
    ]);
    expect(slots.every(Boolean)).toBe(true);
    expect(schedulerState()).toEqual({ running: 3, waiting: 0 });
  });
});

describe("waiting for a human", () => {
  it("frees the slot during an approval and takes it back at the front", async () => {
    const held = await acquireRunSlot({ signal: live(), onQueued: noop });
    if (!held) throw new Error("not admitted");

    // Someone else is already queued behind the approving run.
    const queuedOrder: string[] = [];
    const other = acquireRunSlot({ signal: live(), onQueued: noop }).then((s) => {
      queuedOrder.push("other");
      return s;
    });

    let approvalResolved: (() => void) | undefined;
    const approval = new Promise<boolean>((r) => { approvalResolved = () => { r(true); }; });
    const yielded = held.yieldWhile(() => approval).then(() => { queuedOrder.push("approver"); });

    // With the slot handed back, the waiting run gets to work — that is the
    // point of yielding rather than holding through a wait measured in the
    // time a person takes to click.
    expect(await other).not.toBeNull();

    approvalResolved?.();
    (await other)?.release();
    await yielded;

    // The approver came back ahead of anything that queued behind it, so
    // answering a prompt never costs the user their place.
    expect(queuedOrder).toEqual(["other", "approver"]);
    held.release();
  });

  it("re-takes the slot even when the awaited work throws, so it is released once", async () => {
    const held = await acquireRunSlot({ signal: live(), onQueued: noop });
    if (!held) throw new Error("not admitted");

    await expect(
      held.yieldWhile(() => Promise.reject(new Error("tool blew up"))),
    ).rejects.toThrow("tool blew up");

    // Still exactly one run holding the backend: releasing now must take it to
    // zero, not to minus one (which would let two runs in forever after).
    expect(schedulerState().running).toBe(1);
    held.release();
    expect(schedulerState().running).toBe(0);
  });
});

describe("a stopped run does not hold up the queue", () => {
  it("gives up its place when aborted while waiting", async () => {
    const first = await acquireRunSlot({ signal: live(), onQueued: noop });
    const stopping = new AbortController();
    const abandoned = acquireRunSlot({ signal: stopping.signal, onQueued: noop });

    stopping.abort();
    // Null rather than a rejection: the run starters call the engine
    // fire-and-forget, so a throw here would surface as an unhandled rejection
    // instead of a cancelled turn.
    expect(await abandoned).toBeNull();
    expect(schedulerState().waiting).toBe(0);

    first?.release();
    expect(schedulerState()).toEqual({ running: 0, waiting: 0 });
  });

  it("does not admit a run that was already stopped before it asked", async () => {
    const stopping = new AbortController();
    stopping.abort();
    expect(await acquireRunSlot({ signal: stopping.signal, onQueued: noop })).toBeNull();
    expect(schedulerState()).toEqual({ running: 0, waiting: 0 });
  });

  it("throws out of an approval wait when the run is stopped meanwhile", async () => {
    const stopping = new AbortController();
    const held = await acquireRunSlot({ signal: stopping.signal, onQueued: noop });
    if (!held) throw new Error("not admitted");
    // Another run takes the slot the moment it is handed back, so the stopped
    // one cannot simply walk back in.
    const blocker = held.yieldWhile(async () => {
      const other = await acquireRunSlot({ signal: live(), onQueued: noop });
      stopping.abort();
      return other;
    });
    await expect(blocker).rejects.toBeInstanceOf(RunSlotAbortedError);
  });
});

describe("how many runs are allowed at once", () => {
  it("prefers the environment pin over everything else", async () => {
    pin(7);
    await expect(resolveMaxConcurrent()).resolves.toBe(7);
  });

  it("falls back to one when the backend will not say how many slots it has", async () => {
    Reflect.deleteProperty(process.env, "INFERENCE_MAX_CONCURRENT_RUNS");
    // Nothing pinned, nothing persisted, and the probe pointed at a port with
    // no backend on it — which is the same answer LM Studio gives on a live
    // one, since it reports nothing about slots on any endpoint. Driven
    // through the real probe rather than a module mock: mocking an ES export
    // means resetting the module registry, which every other suite sharing
    // this worker then inherits.
    const previousBase = process.env.INFERENCE_BASE_URL;
    process.env.INFERENCE_BASE_URL = "http://127.0.0.1:1";
    resetSlotProbe();
    try {
      await expect(resolveMaxConcurrent()).resolves.toBe(1);
    } finally {
      if (previousBase === undefined) Reflect.deleteProperty(process.env, "INFERENCE_BASE_URL");
      else process.env.INFERENCE_BASE_URL = previousBase;
      resetSlotProbe();
    }
  });
});
