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
    const pattern = [{ tool: "grep" }, { tool: "fs_read" }];
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

  it("carries the deadline and what happens when it passes", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, {
        kind: "steps.checkin",
        n: 5,
        max: 5,
        reason: "budget",
        timeout_ms: 1_200_000,
        expires_at: 1_700_000_000_000,
        timeout_basis: "adaptive",
        on_timeout: "continue",
        unattended: 1,
        auto_continues: 2,
      }),
    ]);
    expect(snapshot.pending_checkin).toEqual({
      n: 5,
      max: 5,
      reason: "budget",
      timeout_ms: 1_200_000,
      expires_at: 1_700_000_000_000,
      timeout_basis: "adaptive",
      on_timeout: "continue",
      unattended: 1,
      auto_continues: 2,
    });
  });

  it("puts a timed-out decision on the answer it preceded, and nothing for a person's", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "message.start", message_id: "a1", author_type: "assistant", parent_id: null }),
      rec(2, { kind: "steps.checkin", n: 1, max: 1, reason: "budget" }),
      rec(3, { kind: "steps.decision", decision: "continue", by: "timeout", n: 1, unattended: 1, auto_continues: 2 }),
      rec(4, { kind: "message.start", message_id: "a2", author_type: "assistant", parent_id: "a1" }),
      rec(5, { kind: "steps.checkin", n: 2, max: 2, reason: "budget" }),
      rec(6, { kind: "steps.decision", decision: "answer", by: "user", n: 2 }),
    ]);
    const byId = new Map(snapshot.messages.map((m) => [m.message_id, m]));
    expect(byId.get("a1")?.checkin_decision).toEqual({ decision: "continue", by: "timeout", n: 1, unattended: 1, auto_continues: 2 });
    expect(byId.get("a2")?.checkin_decision).toBeUndefined();
  });

  it("folds who wrote a server-inserted message, keeping null distinct from absent", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "message.start", message_id: "n1", author_type: "user", parent_id: null, text: "x", author_user_id: null }),
      rec(2, { kind: "message.start", message_id: "u1", author_type: "user", parent_id: "n1", text: "y" }),
    ]);
    const byId = new Map(snapshot.messages.map((m) => [m.message_id, m]));
    expect(byId.get("n1")).toHaveProperty("author_user_id", null);
    expect(byId.get("u1")).not.toHaveProperty("author_user_id");
  });
});
