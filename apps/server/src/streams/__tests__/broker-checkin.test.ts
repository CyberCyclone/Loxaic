import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/**
 * A step check-in has to survive a reconnect: the run is parked on an answer
 * that only a person can give, so a client that joins mid-pause and is shown
 * nothing has no way to un-stick it short of pressing Stop.
 *
 * Pure unit test on the fold, for the same reason `broker-queued.test.ts` is
 * one — these are ordering rules between event kinds, and a full run can only
 * ever exercise one ordering at a time.
 */
describe("foldSnapshot carries a pending step check-in", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const rec = (seq: number, event: StreamRecord["event"]): StreamRecord => ({ seq, ts: Date.now(), event });

  it("reports the question, and the step it paused at", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "iteration", n: 100, max: 100 }),
      rec(2, { kind: "steps.checkin", n: 100, max: 100, reason: "budget" }),
    ]);
    expect(snapshot.pending_checkin).toEqual({ n: 100, max: 100, reason: "budget" });
    expect(snapshot.iteration).toEqual({ n: 100, max: 100 });
  });

  it("carries the repeating calls of a loop check-in", () => {
    const pattern = [{ tool: "grep", args: { pattern: "todo" } }];
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "steps.checkin", n: 3, max: 100, reason: "loop", pattern }),
    ]);
    expect(snapshot.pending_checkin).toEqual({ n: 3, max: 100, reason: "loop", pattern });
  });

  it("clears it once the decision is in", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "steps.checkin", n: 100, max: 100, reason: "budget" }),
      rec(2, { kind: "steps.decision", decision: "continue", by: "user" }),
    ]);
    expect(snapshot.pending_checkin).toBeUndefined();
  });

  it("clears it on the next iteration too, since reaching one is the run moving on", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "steps.checkin", n: 100, max: 100, reason: "budget" }),
      rec(2, { kind: "iteration", n: 101, max: 200 }),
    ]);
    expect(snapshot.pending_checkin).toBeUndefined();
  });

  it("is not cleared by the queue position the answered run re-enters with", () => {
    // The run gave its slot back to ask, so getting back in line is ordinary.
    // In practice `steps.decision` is emitted before re-entry precisely so
    // this ordering cannot arise — but a fold that dropped the question on a
    // queue update would be one reordering away from losing it.
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "steps.checkin", n: 100, max: 100, reason: "budget" }),
      rec(2, { kind: "run.queued", position: 1 }),
    ]);
    expect(snapshot.pending_checkin).toEqual({ n: 100, max: 100, reason: "budget" });
    expect(snapshot.queued).toEqual({ position: 1 });
  });
});
