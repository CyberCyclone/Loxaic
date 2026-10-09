import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/**
 * A snapshot says when each message began, so a device that reconnects in the
 * middle of a reply times that reply, not the whole run: an agent turn is many
 * messages, and the run's age on the newest one read "Thinking… 1955s" for a
 * reply seconds old.
 */
describe("foldSnapshot carries message.start's started_at", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const start = (message_id: string, started_at?: number): StreamRecord => ({
    seq: 1,
    ts: Date.now(),
    event: {
      kind: "message.start",
      message_id,
      author_type: "assistant",
      parent_id: null,
      ...(started_at === undefined ? {} : { started_at }),
    },
  });

  it("copies it onto the folded message", () => {
    expect(broker.foldSnapshot([start("m1", 1_790_000_000_123)]).messages[0].started_at).toBe(1_790_000_000_123);
  });

  it("leaves it absent when an older server sent none", () => {
    expect("started_at" in broker.foldSnapshot([start("m2")]).messages[0]).toBe(false);
  });
});
