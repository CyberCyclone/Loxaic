import { describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { registerRun, unregisterRun, waitForRunEnd } from "../registry.ts";

/**
 * `waitForRunEnd` is what lets a delete abort a run and then clean up after
 * it, rather than racing the rows it writes on its way out.
 */
function run(conversationId: string) {
  const streamId = uuid();
  registerRun({
    streamId,
    conversationId,
    userId: "test-user",
    abort: new AbortController(),
    approvals: new Map(),
  });
  return streamId;
}

describe("waitForRunEnd", () => {
  it("resolves immediately when nothing is running", async () => {
    await expect(waitForRunEnd(uuid(), 50)).resolves.toBe(true);
  });

  it("resolves when the run unregisters", async () => {
    const convId = uuid();
    const streamId = run(convId);
    const waiting = waitForRunEnd(convId, 5_000);
    unregisterRun(streamId);
    await expect(waiting).resolves.toBe(true);
  });

  it("gives up rather than hanging, and says so", async () => {
    // A run wedged inside a tool call never reaches unregisterRun, and the
    // caller still has cleanup to do. False is a fact it logs, not an error.
    const convId = uuid();
    const streamId = run(convId);
    try {
      await expect(waitForRunEnd(convId, 20)).resolves.toBe(false);
    } finally {
      unregisterRun(streamId);
    }
  });

  it("wakes every waiter on the same conversation", async () => {
    const convId = uuid();
    const streamId = run(convId);
    const waits = [waitForRunEnd(convId, 5_000), waitForRunEnd(convId, 5_000)];
    unregisterRun(streamId);
    await expect(Promise.all(waits)).resolves.toEqual([true, true]);
  });

  it("is not woken by a different conversation's run ending", async () => {
    const mine = uuid();
    const theirs = uuid();
    const myRun = run(mine);
    const theirRun = run(theirs);
    try {
      unregisterRun(theirRun);
      await expect(waitForRunEnd(mine, 20)).resolves.toBe(false);
    } finally {
      unregisterRun(myRun);
    }
  });
});
