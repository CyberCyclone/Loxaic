import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/**
 * The run's permission mode in its snapshot (#311): what a device that opens
 * the thread mid-run, or reconnects, sets its selector from, and what a
 * waiting question is asked in.
 */
describe("foldSnapshot and the run's mode", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const rec = (seq: number, event: StreamRecord["event"]): StreamRecord => ({ seq, ts: Date.now(), event });
  const ask = (mode: "manual" | "auto"): StreamRecord["event"] => ({
    kind: "approval.request",
    call_id: "call_0",
    tool: "bash",
    args: { command: "touch x" },
    mode,
  });

  it("carries the newest mode, and none for a run that never said", () => {
    expect(broker.foldSnapshot([rec(1, { kind: "run.mode", mode: "manual" })]).mode).toBe("manual");
    expect(
      broker.foldSnapshot([rec(1, { kind: "run.mode", mode: "manual" }), rec(2, { kind: "run.mode", mode: "auto" })]).mode,
    ).toBe("auto");
    expect(broker.foldSnapshot([rec(1, { kind: "iteration", n: 1, max: 100 })])).not.toHaveProperty("mode");
  });

  it("keeps a queue position across a switch", () => {
    const snapshot = broker.foldSnapshot([
      rec(1, { kind: "run.mode", mode: "manual" }),
      rec(2, { kind: "run.queued", position: 2 }),
      rec(3, { kind: "run.mode", mode: "auto" }),
    ]);
    expect(snapshot.queued).toEqual({ position: 2 });
  });

  it("withdraws a waiting question on a switch, and keeps the one asked again after it", () => {
    const withdrawn = broker.foldSnapshot([
      rec(1, { kind: "run.mode", mode: "manual" }),
      rec(2, ask("manual")),
      rec(3, { kind: "run.mode", mode: "auto" }),
    ]);
    expect(withdrawn.pending_approval).toBeUndefined();
    const askedAgain = broker.foldSnapshot([
      rec(1, { kind: "run.mode", mode: "manual" }),
      rec(2, ask("manual")),
      rec(3, { kind: "run.mode", mode: "auto" }),
      rec(4, ask("auto")),
    ]);
    expect(askedAgain.pending_approval).toMatchObject({ call_id: "call_0", mode: "auto" });
  });
});
