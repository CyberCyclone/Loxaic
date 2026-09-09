import { afterEach, describe, expect, it } from "vitest";
import {
  __resetExecutorsForTest,
  callExecutor,
  ExecutorCallError,
  ExecutorOfflineError,
  ExecutorTimeoutError,
  getExecutor,
  handleExecutorResult,
  listExecutors,
  registerExecutor,
  updateExecutorRoots,
  type ExecutorConnection,
} from "../registry.ts";
import type { ServerToExecutor } from "../protocol.ts";

/** A connection whose "executor" is a function: what it answers, or not. */
function fakeConnection(
  overrides: Partial<ExecutorConnection> & { onCall?: (call: Extract<ServerToExecutor, { type: "call" }>) => void },
): ExecutorConnection & { closed: { code: number; reason: string } | null; sent: ServerToExecutor[] } {
  const conn = {
    executorId: "machine-a",
    userId: "user-1",
    name: "Casey's laptop",
    platform: "darwin",
    capabilities: { direct: true, container: false },
    roots: ["/Users/casey/code"],
    closed: null as { code: number; reason: string } | null,
    sent: [] as ServerToExecutor[],
    send(message: ServerToExecutor) {
      conn.sent.push(message);
      if (message.type === "call") overrides.onCall?.(message);
    },
    close(code: number, reason: string) {
      conn.closed = { code, reason };
    },
    ...overrides,
  };
  return conn;
}

afterEach(() => {
  __resetExecutorsForTest();
});

describe("registration", () => {
  it("lists a user's connected machines, and only theirs", () => {
    registerExecutor(fakeConnection({}));
    registerExecutor(fakeConnection({ executorId: "machine-b", userId: "user-2", name: "Other" }));
    expect(listExecutors("user-1").map((e) => e.executorId)).toEqual(["machine-a"]);
    expect(listExecutors("user-2").map((e) => e.executorId)).toEqual(["machine-b"]);
    expect(listExecutors("nobody")).toEqual([]);
    expect(getExecutor("machine-a")?.name).toBe("Casey's laptop");
  });

  it("forgets a machine when its socket closes, but still knows its name for the offline message", async () => {
    const unregister = registerExecutor(fakeConnection({}));
    unregister?.();
    expect(getExecutor("machine-a")).toBeNull();
    await expect(callExecutor("machine-a", "ping", {})).rejects.toThrow(/Your machine Casey's laptop is offline/);
  });

  it("names no machine it has never seen", async () => {
    await expect(callExecutor("never", "ping", {})).rejects.toThrow(/The machine this workspace lives on is offline/);
  });

  it("replaces an older connection with the same id and closes it", () => {
    const first = fakeConnection({});
    const unregisterFirst = registerExecutor(first);
    const second = fakeConnection({ name: "Casey's laptop (restarted)" });
    registerExecutor(second);
    expect(first.closed?.code).toBe(4000);
    expect(getExecutor("machine-a")?.name).toBe("Casey's laptop (restarted)");
    // The stale socket's own close must not unregister the newer one.
    unregisterFirst?.();
    expect(getExecutor("machine-a")?.name).toBe("Casey's laptop (restarted)");
  });

  it("refuses a connection claiming another user's executor id, and keeps the real one", () => {
    // Replacement is for the same user's restarted desktop. The id is a UUID
    // in a config file, not a secret; a stranger who learned it could
    // otherwise evict the machine and receive its owner's commands.
    const real = fakeConnection({});
    registerExecutor(real);
    const impostor = fakeConnection({ userId: "user-2", name: "Impostor" });
    expect(registerExecutor(impostor)).toBeNull();
    expect(impostor.closed?.code).toBe(4003);
    expect(real.closed).toBeNull();
    expect(getExecutor("machine-a")?.userId).toBe("user-1");
  });

  it("takes a roots update", () => {
    registerExecutor(fakeConnection({}));
    updateExecutorRoots("machine-a", ["/a", "/b"]);
    expect(getExecutor("machine-a")?.roots).toEqual(["/a", "/b"]);
  });
});

describe("calls", () => {
  it("round-trips a call to its result by correlation id", async () => {
    registerExecutor(
      fakeConnection({
        onCall: (call) => {
          // Answer out of order to prove correlation is by id, not arrival.
          setTimeout(() => { handleExecutorResult("machine-a", { type: "result", id: call.id, ok: true, value: { echoed: call.params } }); }, 5);
        },
      }),
    );
    const [a, b] = await Promise.all([
      callExecutor("machine-a", "ping", { n: 1 }),
      callExecutor("machine-a", "ping", { n: 2 }),
    ]);
    expect(a).toEqual({ echoed: { n: 1 } });
    expect(b).toEqual({ echoed: { n: 2 } });
  });

  it("surfaces the executor's own refusal as the error message", async () => {
    registerExecutor(
      fakeConnection({
        onCall: (call) => {
          handleExecutorResult("machine-a", { type: "result", id: call.id, ok: false, error: "/etc is not inside a folder you have chosen for Loxaic" });
        },
      }),
    );
    await expect(callExecutor("machine-a", "readFile", {})).rejects.toBeInstanceOf(ExecutorCallError);
    await expect(callExecutor("machine-a", "readFile", {})).rejects.toThrow(/not inside a folder you have chosen/);
  });

  it("times out a call the executor never answers, naming the machine", async () => {
    registerExecutor(fakeConnection({}));
    await expect(callExecutor("machine-a", "exec", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(ExecutorTimeoutError);
    await expect(callExecutor("machine-a", "exec", {}, { timeoutMs: 20 })).rejects.toThrow(/Casey's laptop did not answer \(exec\)/);
  });

  it("fails in-flight calls when the machine disconnects, rather than leaving them hanging", async () => {
    const unregister = registerExecutor(fakeConnection({}));
    const pending = callExecutor("machine-a", "exec", {}, { timeoutMs: 60_000 });
    unregister?.();
    await expect(pending).rejects.toThrow(/disconnected before this call completed/);
  });

  it("ignores a late answer to a call that already timed out", async () => {
    let seen: string | null = null;
    registerExecutor(fakeConnection({ onCall: (call) => { seen = call.id; } }));
    await expect(callExecutor("machine-a", "ping", {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(ExecutorTimeoutError);
    expect(() => { handleExecutorResult("machine-a", { type: "result", id: seen ?? "", ok: true, value: 1 }); }).not.toThrow();
  });

  it("is an offline error, not a timeout, when nothing is connected", async () => {
    await expect(callExecutor("machine-a", "ping", {})).rejects.toBeInstanceOf(ExecutorOfflineError);
  });
});

describe("cancelling a call", () => {
  it("sends exec.cancel naming the call, and still settles on the executor's own answer", async () => {
    // Cancellation deliberately does not settle the promise here: the
    // executor kills the command and then answers the original call, so the
    // partial output it produced still comes back rather than being thrown
    // away for a synthetic "cancelled" result (#119).
    const controller = new AbortController();
    let callId = "";
    const conn = fakeConnection({ onCall: (call) => { callId = call.id; } });
    registerExecutor(conn);

    const pending = callExecutor("machine-a", "exec", { command: ["sleep", "5"] }, {
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    controller.abort();
    const cancel = conn.sent.find((m) => m.type === "exec.cancel");
    expect(cancel).toEqual({ type: "exec.cancel", id: callId });

    // The executor answers as it always would; the caller sees that result.
    handleExecutorResult("machine-a", { type: "result", id: callId, ok: true, value: { exitCode: 130, stdout: "partial" } });
    await expect(pending).resolves.toEqual({ exitCode: 130, stdout: "partial" });
  });

  it("does nothing for a signal that aborts after the call has answered", async () => {
    const controller = new AbortController();
    let callId = "";
    const conn = fakeConnection({ onCall: (call) => { callId = call.id; } });
    registerExecutor(conn);

    const pending = callExecutor("machine-a", "exec", {}, { timeoutMs: 5_000, signal: controller.signal });
    handleExecutorResult("machine-a", { type: "result", id: callId, ok: true, value: "done" });
    await expect(pending).resolves.toBe("done");

    // The listener is removed when the call settles, so a later abort — the
    // run ending for some other reason — cannot send a cancel for an id the
    // executor has already forgotten.
    controller.abort();
    expect(conn.sent.some((m) => m.type === "exec.cancel")).toBe(false);
  });
});
