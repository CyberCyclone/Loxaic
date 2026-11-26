import { describe, expect, it } from "vitest";
import { LOCATION_NOT_SHARED_ELSEWHERE, LOCATION_SHARED_ELSEWHERE, type StreamEventKind, type StreamSnapshot } from "@loxaic/types";
import { contentForReader, eventForReader, snapshotForReader } from "../for-reader.ts";

/** What one person in a conversation may see of where another one is. */
const shared = {
  kind: "tool_result",
  call_id: "c1",
  output: "Approximate location: Brisbane, Queensland, Australia (city-level).\nLocal time: …",
  ok: true,
  device: { request: "location", outcome: "shared", place: "Brisbane, Queensland, Australia", user_id: "sender" },
} as const;

describe("contentForReader", () => {
  it("shows a location result in full to the person whose device answered", () => {
    const content = [shared];
    expect(contentForReader(content, null, "sender")).toBe(content);
  });

  it("tells anyone else only that a location was shared, or was not", () => {
    expect(contentForReader([shared], null, "member")).toEqual([
      { ...shared, output: LOCATION_SHARED_ELSEWHERE, device: { request: "location", outcome: "shared", user_id: "sender" } },
    ]);
    const declined = { ...shared, ok: false, output: "The user chose not to share…\nLocal time: …", device: { request: "location", outcome: "declined", user_id: "sender" } };
    expect(contentForReader([declined], null, "admin")).toEqual([{ ...declined, output: LOCATION_NOT_SHARED_ELSEWHERE }]);
  });

  it("treats a result that does not say whose it was as someone else's", () => {
    const anonymous = { ...shared, device: { request: "location", outcome: "shared", place: "Brisbane" } };
    expect(contentForReader([anonymous], null, "sender")).toEqual([
      { ...anonymous, output: LOCATION_SHARED_ELSEWHERE, device: { request: "location", outcome: "shared" } },
    ]);
  });

  it("leaves every other block, and a row with nothing to hide, as it was", () => {
    const plain = [{ kind: "tool_result", call_id: "c2", output: "ok", ok: true }, { kind: "text", text: "hi" }];
    expect(contentForReader(plain, null, "member")).toBe(plain);
  });
});

describe("eventForReader and snapshotForReader", () => {
  const event = { kind: "tool.result", message_id: "m", call_id: "c1", tool: "get_location", output: shared.output, ok: true, device: shared.device } as StreamEventKind;

  it("narrow a live result and a snapshot's call the same way", () => {
    expect(eventForReader(event, "sender")).toBe(event);
    expect(eventForReader(event, "member")).toMatchObject({ output: LOCATION_SHARED_ELSEWHERE, device: { outcome: "shared" } });
    expect(JSON.stringify(eventForReader(event, "member"))).not.toContain("Brisbane");

    const snapshot = {
      messages: [
        {
          message_id: "m",
          author_type: "assistant",
          parent_id: null,
          text: "",
          status: "complete",
          tool_calls: [
            { call_id: "c1", tool: "get_location", args: {}, output: shared.output, ok: true, device: shared.device },
            { call_id: "c2", tool: "web_fetch", args: {}, output: "page", ok: true },
          ],
        },
      ],
    } as unknown as StreamSnapshot;
    expect(snapshotForReader(snapshot, "sender")).toBe(snapshot);
    const seen = snapshotForReader(snapshot, "member");
    expect(JSON.stringify(seen)).not.toContain("Brisbane");
    expect(seen.messages[0].tool_calls[1]).toBe(snapshot.messages[0].tool_calls[1]);
  });
});
