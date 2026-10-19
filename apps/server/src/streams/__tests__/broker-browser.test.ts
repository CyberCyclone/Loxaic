import { describe, expect, it } from "vitest";
import { StreamBroker } from "../broker.ts";
import { MemoryStreamLogDriver } from "../memory.ts";
import type { StreamEventKind } from "@loxaic/types";
import type { StreamRecord } from "../types.ts";

/** A device that reconnects mid-turn sees a web_fetch's screenshot and that it
 * went through the chat's browser (#281), as a live one does. */
describe("foldSnapshot carries a web_fetch's screenshot and browser mark", () => {
  const broker = new StreamBroker(new MemoryStreamLogDriver(86400), 0);
  const records = (...events: StreamEventKind[]): StreamRecord[] => events.map((event, i) => ({ seq: i + 1, ts: Date.now(), event }));
  const images = [{ ref: "00000000-0000-4000-8000-000000000001", mime: "image/png" }];
  const call = (call_id: string): StreamEventKind => ({ kind: "tool.call", message_id: "m1", call_id, tool: "web_fetch", args: { url: "https://example.com" } });

  it("copies both onto the call, and neither onto a plain fetch", () => {
    const snapshot = broker.foldSnapshot(records(
      { kind: "message.start", message_id: "m1", author_type: "assistant", parent_id: null },
      call("browsed"),
      { kind: "tool.result", message_id: "m1", call_id: "browsed", tool: "web_fetch", output: "ok", ok: true, images, browser: true },
      call("plain"),
      { kind: "tool.result", message_id: "m1", call_id: "plain", tool: "web_fetch", output: "ok", ok: true },
    ));
    const [browsed, plain] = snapshot.messages[0].tool_calls;
    expect(browsed).toMatchObject({ images, browser: true });
    expect("browser" in plain || "images" in plain).toBe(false);
  });
});
