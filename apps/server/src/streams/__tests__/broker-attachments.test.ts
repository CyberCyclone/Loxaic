import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamRecord } from "../types.ts";

/** Pure unit test on foldSnapshot — no Postgres, no network. */
describe("foldSnapshot carries attachments from message.start into the snapshot", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);

  it("attaches the refs to the folded user message", () => {
    const att = { ref: "11111111-1111-1111-1111-111111111111", mime: "image/png" };
    const records: StreamRecord[] = [
      {
        seq: 1,
        ts: Date.now(),
        event: {
          kind: "message.start",
          message_id: "m1",
          author_type: "user",
          parent_id: null,
          text: "what is this",
          attachments: [att],
        },
      },
    ];

    const snapshot = broker.foldSnapshot(records);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].attachments).toEqual([att]);
  });

  it("leaves attachments undefined when the event carries none — no stray empty array", () => {
    const records: StreamRecord[] = [
      { seq: 1, ts: Date.now(), event: { kind: "message.start", message_id: "m2", author_type: "user", parent_id: null, text: "hi" } },
    ];

    const snapshot = broker.foldSnapshot(records);
    expect(snapshot.messages[0].attachments).toBeUndefined();
  });
});
