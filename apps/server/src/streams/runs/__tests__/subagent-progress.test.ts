import { describe, expect, it } from "vitest";
import type { StreamEventKind } from "@loxaic/types";
import type { StreamProducer } from "../../broker.ts";
import { mirrorProgress } from "../subagentRun.ts";

/**
 * The queue/running hooks behind the sub-agent listing's `state`, driven
 * through the mirror directly. The real sequence — a manual-mode child whose
 * approval is answered while a sibling holds the only slot, then a long
 * sandboxed command — needs Docker and a queue at once, which
 * `subagents.test.ts` deliberately avoids; this pins the order at the seam.
 */
function harness() {
  const calls: string[] = [];
  const reports: Extract<StreamEventKind, { kind: "subagent.progress" }>[] = [];
  const noop: StreamProducer = { emit: () => undefined, end: () => Promise.resolve() };
  const parent: StreamProducer = {
    emit: (e) => {
      if (e.kind === "subagent.progress") reports.push(e);
    },
    end: () => Promise.resolve(),
  };
  const producer = mirrorProgress(noop, parent, "child-conv", "child-stream", {
    onQueued: () => calls.push("queued"),
    onAdmitted: () => calls.push("admitted"),
    onRunning: () => calls.push("running"),
  });
  return {
    calls,
    reports,
    emit: (e: StreamEventKind) => {
      producer.emit(e);
    },
  };
}

const approval = (call_id: string) =>
  ({ kind: "approval.request", call_id, tool: "bash", args: { command: "sleep 120" } }) as unknown as StreamEventKind;
const result = (call_id: string): StreamEventKind => ({
  kind: "tool.result",
  message_id: "m1",
  call_id,
  tool: "bash",
  output: "",
  ok: true,
});

describe("a sub-agent's queued and running state", () => {
  it("queues, is admitted once, and later iterations only say running", () => {
    const h = harness();
    h.emit({ kind: "run.queued", position: 2 });
    h.emit({ kind: "iteration", n: 1 } as StreamEventKind);
    h.emit({ kind: "iteration", n: 2 } as StreamEventKind);
    expect(h.calls).toEqual(["queued", "admitted", "running"]);
  });

  it("is running again once an answered approval's call has its result, not only at the next iteration", () => {
    // Back in line after the approval, then the call runs holding a slot. The
    // next iteration follows the whole batch, so without this the listing
    // read "Queued" for the length of the command.
    const h = harness();
    h.emit({ kind: "iteration", n: 1 } as StreamEventKind);
    h.emit(approval("c1"));
    h.emit({ kind: "run.queued", position: 1 });
    h.emit(result("c1"));
    expect(h.calls).toEqual(["admitted", "queued", "running"]);
    expect(h.reports.at(-1)).toMatchObject({ state: "running", pending_approval: null });
  });

  it("a result for a call nobody was asked about changes nothing", () => {
    const h = harness();
    h.emit({ kind: "iteration", n: 1 } as StreamEventKind);
    h.emit(result("c9"));
    expect(h.calls).toEqual(["admitted"]);
  });
});
