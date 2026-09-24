import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/**
 * A snapshot says where each message sits in the thread (#213).
 *
 * A thread loads a page at a time now, and a reconnect snapshots the
 * conversation's last few runs — which can be older than everything a client
 * has loaded. Without the row's lamport the client could only append such a
 * run after the newest reply, which is where it appeared on iOS.
 */
describe("foldSnapshot carries message.start's lamport", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const start = (message_id: string, lamport?: number): StreamRecord => ({
    seq: 1,
    ts: Date.now(),
    event: {
      kind: "message.start",
      message_id,
      author_type: "assistant",
      parent_id: null,
      ...(lamport === undefined ? {} : { lamport }),
    },
  });

  it("copies it onto the folded message", () => {
    expect(broker.foldSnapshot([start("m1", 1_790_000_000_123)]).messages[0].lamport).toBe(1_790_000_000_123);
  });

  it("leaves it absent when an older server sent none", () => {
    expect("lamport" in broker.foldSnapshot([start("m2")]).messages[0]).toBe(false);
  });
});
