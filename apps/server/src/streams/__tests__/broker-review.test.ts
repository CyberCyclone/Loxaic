import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/**
 * What a client catching up mid-run is told about a progress review, and the
 * step counter beside it. Pure unit test on the fold, for the same reason
 * `broker-queued.test.ts` is one — these are ordering rules between event
 * kinds, and a full run can only ever exercise one ordering at a time.
 */
describe("foldSnapshot and the progress review", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const rec = (seq: number, event: StreamRecord["event"]): StreamRecord => ({ seq, ts: Date.now(), event });

  it("says a review is under way, and how", () => {
    expect(broker.foldSnapshot([rec(1, { kind: "run.review.start", mode: "alongside" })]).reviewing).toEqual({ mode: "alongside" });
    expect(broker.foldSnapshot([rec(1, { kind: "run.review.start", mode: "paused" })]).reviewing).toEqual({ mode: "paused" });
  });

  it("clears it once the review has ended, whatever it decided", () => {
    for (const action of ["none", "steer", "answer"] as const) {
      const snapshot = broker.foldSnapshot([
        rec(1, { kind: "run.review.start", mode: "paused" }),
        rec(2, { kind: "run.review.end", verdict: action === "none" ? "progressing" : "stuck", action }),
      ]);
      expect(snapshot.reviewing).toBeUndefined();
    }
  });

  it("keeps a review beside the run through the steps the run takes meanwhile", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "run.review.start", mode: "alongside" }),
      rec(2, { kind: "iteration", n: 4 }),
      rec(3, { kind: "message.start", message_id: "a4", author_type: "assistant", parent_id: null }),
    ]);
    expect(snapshot.reviewing).toEqual({ mode: "alongside" });
    expect(snapshot.iteration).toEqual({ n: 4 });
  });

  it("counts steps with no ceiling, and drops an older server's", () => {
    expect(broker.foldSnapshot([rec(1, { kind: "iteration", n: 7, max: 107, unlimited: true })]).iteration).toEqual({ n: 7 });
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
