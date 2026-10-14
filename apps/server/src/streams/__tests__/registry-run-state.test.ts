import { afterEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import {
  clearRunApproval,
  clearRunCheckin,
  clearRunQueuePosition,
  registerRun,
  runActivityOf,
  setRunApproval,
  setRunCheckin,
  setRunQueuePosition,
  takeRunCheckin,
  unregisterRun,
  type RunHandle,
} from "../registry.ts";
import { watchRunActivity } from "../watchers.ts";

/**
 * The thread list badges every row whose conversation has a run going (#282),
 * and the run registry is what decides the word. Two rules matter:
 *
 * - **What is reported.** The ranking is `runLevelFromSnapshot`'s with
 *   check-in and approval swapped (a run holds at most one; see
 *   `runActivityOf`): a question a person can answer outranks a queue
 *   position the same run also holds, because the run parked on an approval
 *   has handed its slot back and may well be queuing to get it again.
 * - **When a notice goes out.** A change in the *reported* state, and nothing
 *   else. A second approval while already awaiting approval says nothing new
 *   to a row that already says "Awaiting approval"; a run moving from #3 to
 *   #2 does. Every announcement here is asserted through the same channel
 *   delivery.ts taps, so a mutation that changes the word without announcing
 *   it fails here rather than leaving a row to lie.
 */

function makeHandle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    streamId: uuid(),
    conversationId: uuid(),
    userId: uuid(),
    abort: new AbortController(),
    approvals: new Map(),
    ...overrides,
  };
}

describe("runActivityOf", () => {
  it("reads a plain run as running", () => {
    expect(runActivityOf(makeHandle())).toBe("running");
  });

  it("ranks a parked check-in over everything", () => {
    const handle = makeHandle({ queuePosition: 1 });
    setRunApproval(handle, "call_0", () => undefined);
    setRunCheckin(handle, () => undefined);
    expect(runActivityOf(handle)).toBe("awaiting_checkin");
  });

  it("ranks an approval over a queue position", () => {
    // The parked run gave its slot back and re-entered the queue: both are
    // true, and the thing the person can act on is the one to show.
    const handle = makeHandle({ queuePosition: 2 });
    setRunApproval(handle, "call_0", () => undefined);
    expect(runActivityOf(handle)).toBe("awaiting_approval");
  });

  it("reports a waiting run by its place in line", () => {
    const handle = makeHandle();
    setRunQueuePosition(handle, 3);
    expect(runActivityOf(handle)).toBe("queued");
    clearRunQueuePosition(handle);
    expect(runActivityOf(handle)).toBe("running");
  });
});

describe("activity announcements", () => {
  /** Tap the channel for one conversation for the duration of one test. */
  function tap(conversationId: string): string[] {
    const seen: string[] = [];
    const off = watchRunActivity((id) => {
      if (id === conversationId) seen.push(id);
    });
    taps.push(off);
    return seen;
  }
  let taps: (() => void)[] = [];
  afterEach(() => {
    for (const off of taps) off();
    taps = [];
  });

  it("announces on register and on unregister", () => {
    const handle = makeHandle();
    const seen = tap(handle.conversationId);
    registerRun(handle);
    // The state moved (idle → running); both edges must be said.
    expect(seen).toHaveLength(1);
    unregisterRun(handle.streamId);
    expect(seen).toHaveLength(2);
  });

  it("does not announce a second approval over an already-pending one", () => {
    const handle = makeHandle();
    const seen = tap(handle.conversationId);
    registerRun(handle);
    setRunApproval(handle, "call_0", () => undefined);
    expect(seen).toHaveLength(2); // registered, then running → awaiting_approval
    setRunApproval(handle, "call_1", () => undefined);
    expect(seen).toHaveLength(2); // already awaiting: no news
    clearRunApproval(handle, "call_0");
    expect(seen).toHaveLength(2); // still one pending: no news
    clearRunApproval(handle, "call_1");
    expect(seen).toHaveLength(3); // → running
    unregisterRun(handle.streamId);
  });

  it("clears an approval answered by the socket, not only by the engine", () => {
    // run-actions.ts deletes the registry entry when a person answers from
    // any device; the row must stop saying "Awaiting approval" either way.
    const handle = makeHandle();
    const seen = tap(handle.conversationId);
    registerRun(handle);
    setRunApproval(handle, "call_0", () => undefined);
    clearRunApproval(handle, "call_0");
    expect(seen).toHaveLength(3); // register, parked, answered
    unregisterRun(handle.streamId);
  });

  it("announces a check-in parked and taken, and a clear that finds nothing is silent", () => {
    const handle = makeHandle();
    const seen = tap(handle.conversationId);
    registerRun(handle);
    setRunCheckin(handle, () => undefined);
    expect(seen).toHaveLength(2);
    const resolver = takeRunCheckin(handle);
    expect(resolver).not.toBeNull();
    expect(seen).toHaveLength(3);
    // The engine's settle also clears, after the socket already took it:
    // the second clear must not announce a state that never changed.
    clearRunCheckin(handle);
    expect(seen).toHaveLength(3);
    expect(takeRunCheckin(handle)).toBeNull();
    expect(seen).toHaveLength(3);
    unregisterRun(handle.streamId);
  });

  it("announces each move in the queue, and the slot only once", () => {
    const handle = makeHandle();
    const seen = tap(handle.conversationId);
    registerRun(handle);
    setRunQueuePosition(handle, 3);
    setRunQueuePosition(handle, 2);
    setRunQueuePosition(handle, 1);
    expect(seen).toHaveLength(4); // registered, then #3, #2, #1 — each place is a fact
    clearRunQueuePosition(handle);
    expect(seen).toHaveLength(5); // admitted
    // A run that never waited and an unrelated release say nothing.
    clearRunQueuePosition(handle);
    expect(seen).toHaveLength(5);
    unregisterRun(handle.streamId);
  });

  it("does not announce a queue position identical to the last one", () => {
    const handle = makeHandle();
    const seen = tap(handle.conversationId);
    registerRun(handle);
    setRunQueuePosition(handle, 2);
    setRunQueuePosition(handle, 2);
    expect(seen).toHaveLength(2); // registered, then queued · #2 once
    unregisterRun(handle.streamId);
  });
});
