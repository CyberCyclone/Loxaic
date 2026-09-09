import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/**
 * Pure unit test on foldSnapshot's queue position. `iteration` used to be the
 * only thing that cleared it, and a compaction run never emits one — so a
 * client catching up mid-summary was shown "Queued · #1" with the summary
 * streaming in underneath. Any event that is not itself a queue update means
 * the run is past the queue.
 */
describe("foldSnapshot drops the queue position once the run moves on", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const rec = (seq: number, event: StreamRecord["event"]): StreamRecord => ({ seq, ts: Date.now(), event });

  it("keeps the latest position while the run is still waiting", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "run.queued", position: 2 }),
      rec(2, { kind: "run.queued", position: 1 }),
    ]);
    expect(snapshot.queued).toEqual({ position: 1 });
  });

  it("clears it on a compaction's first event, which is never an iteration", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "run.queued", position: 1 }),
      rec(2, { kind: "model.loading", message_id: "m1" }),
    ]);
    expect(snapshot.queued).toBeUndefined();
  });

  it("clears it on a delta, for a run re-queued after an approval", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "iteration", n: 1, max: 20 }),
      rec(2, { kind: "run.queued", position: 1 }),
      rec(3, { kind: "text.delta", message_id: "m1", text: "hi" }),
    ]);
    expect(snapshot.queued).toBeUndefined();
    expect(snapshot.iteration).toEqual({ n: 1, max: 20 });
  });
});
