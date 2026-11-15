import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";
import { settledRunReviews, withRunReview, type RunReview } from "@loxaic/types";

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

  describe("the run's review cards", () => {
    const card = (id: string, lamport: number, startedAt = 1_000): RunReview => ({
      id,
      lamport,
      step: 3,
      worked_ms: 500,
      mode: "paused",
      trigger: "steps",
      started_at: startedAt,
    });
    const done = (c: RunReview): RunReview => ({ ...c, ended_at: c.started_at + 40, verdict: "stuck", reason: "Round again.", action: "steer" });

    it("holds a review under way, then the same one finished, in place", () => {
      const a = card("a", 10);
      const b = card("b", 20);
      const running = broker.foldSnapshot([
        rec(1, { kind: "run.review.start", mode: "paused", review: a }),
        rec(2, { kind: "run.review.end", verdict: "stuck", action: "steer", review: done(a) }),
        rec(3, { kind: "run.review.start", mode: "paused", review: b }),
      ]);
      expect(running.reviews).toEqual([done(a), b]);
      expect(running.reviewing).toEqual({ mode: "paused" });
    });

    it("orders them by where they sit in the thread, not by when they ended", () => {
      // One beside the run, started after step 3, ends after a later one started.
      const early = card("early", 10, 1_000);
      const late = card("late", 20, 2_000);
      const sameRow = card("same-row", 10, 1_500);
      const snapshot = broker.foldSnapshot([
        rec(1, { kind: "run.review.start", mode: "alongside", review: early }),
        rec(2, { kind: "run.review.start", mode: "alongside", review: late }),
        rec(3, { kind: "run.review.end", verdict: "stuck", action: "steer", review: done(late) }),
        rec(4, { kind: "run.review.start", mode: "alongside", review: sameRow }),
        rec(5, { kind: "run.review.end", verdict: "stuck", action: "steer", review: done(early) }),
      ]);
      expect(snapshot.reviews?.map((r) => r.id)).toEqual(["early", "same-row", "late"]);
      // The fold itself: a card goes between the rows either side of it, and
      // one of an id already held replaces it where it was.
      expect(withRunReview([early, late], sameRow).map((r) => r.id)).toEqual(["early", "same-row", "late"]);
      expect(withRunReview([early, sameRow, late], done(sameRow))).toEqual([early, done(sameRow), late]);
    });

    it("takes the ceiling's card, which ends without having started", () => {
      const limit: RunReview = { ...card("limit", 30), mode: null, trigger: "limit", ended_at: 1_000, verdict: null, action: "answer", forced: true };
      expect(broker.foldSnapshot([rec(1, { kind: "run.review.end", verdict: null, action: "answer", review: limit })]).reviews).toEqual([limit]);
    });

    it("drops a review still under way when the ceiling ends the run's reviewing, in that run only", () => {
      const running = { ...card("running", 10), stream_id: "s1" };
      const elsewhere = { ...card("elsewhere", 10), stream_id: "s2" };
      const finished = done({ ...card("finished", 5), stream_id: "s1" });
      const limit: RunReview = { ...card("limit", 30), stream_id: "s1", mode: null, trigger: "limit", ended_at: 1_000, verdict: null, action: "answer", forced: true };
      expect(withRunReview([finished, running, elsewhere], limit).map((r) => r.id)).toEqual(["finished", "elsewhere", "limit"]);
      // An ordinary review ending leaves every other card alone.
      expect(withRunReview([finished, running], done({ ...card("other", 20), stream_id: "s1" })).map((r) => r.id)).toEqual(["finished", "running", "other"]);
    });

    it("has no cards for an older server's events, which name no review", () => {
      const snapshot = broker.foldSnapshot([
        rec(1, { kind: "run.review.start", mode: "paused" }),
        rec(2, { kind: "run.review.end", verdict: "progressing", action: "none" }),
      ]);
      expect("reviews" in snapshot).toBe(false);
    });

    it("drops what never finished from a run that has ended, and nothing else", () => {
      const a = done(card("a", 10));
      const b = card("b", 20);
      expect(settledRunReviews([a, b])).toEqual([a]);
      expect(settledRunReviews([])).toEqual([]);
    });
  });

  it("counts steps with no ceiling, and drops an older server's", () => {
    expect(broker.foldSnapshot([rec(1, { kind: "iteration", n: 7, max: 107, unlimited: true })]).iteration).toEqual({ n: 7 });
  });

  it("leaves out a reply a review cut short before anything was written, and keeps one it cut mid-way", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "message.start", message_id: "a1", author_type: "assistant", parent_id: null }),
      rec(2, { kind: "message.end", message_id: "a1", status: "cancelled", discard: true }),
      rec(3, { kind: "message.start", message_id: "a2", author_type: "assistant", parent_id: null }),
      rec(4, { kind: "text.delta", message_id: "a2", text: "Half a tho" }),
      rec(5, { kind: "message.end", message_id: "a2", status: "cancelled" }),
    ]);
    expect(snapshot.messages.map((m) => [m.message_id, m.status])).toEqual([["a2", "cancelled"]]);
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
