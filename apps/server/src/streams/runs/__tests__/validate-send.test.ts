import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS, validateSendAttachments } from "@shannon/types";

/**
 * The shared `chat.send`/`agent.send` gate, exercised the same way for both
 * WS handlers use it — it's the one thing standing between a hand-rolled
 * client and `startChatRun`/`startAgentRun`.
 */
describe("validateSendAttachments", () => {
  it("passes ordinary text with no attachments", () => {
    expect(validateSendAttachments("hello", undefined)).toBeNull();
  });

  it("passes an image-only send — an attachment on its own is a complete message", () => {
    expect(validateSendAttachments("", ["ref-1"])).toBeNull();
    expect(validateSendAttachments("   ", ["ref-1"])).toBeNull();
  });

  it("rejects empty text with no attachments either", () => {
    expect(validateSendAttachments("", undefined)).toBe("Content required");
    expect(validateSendAttachments("   ", [])).toBe("Content required");
  });

  it("rejects non-string content regardless of attachments — the unchecked JSON.parse cast means this can happen at runtime", () => {
    expect(validateSendAttachments(42, undefined)).toBe("Content required");
    expect(validateSendAttachments(null, ["ref-1"])).toBe("Content required");
  });

  it(`rejects more than ${String(MAX_ATTACHMENTS)} attachments, checked before the content check`, () => {
    const tooMany = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `ref-${String(i)}`);
    expect(validateSendAttachments("hi", tooMany)).toBe(`Attach at most ${String(MAX_ATTACHMENTS)} files`);
    // Bad content AND over-cap attachments — the cap error wins, since it's
    // checked first (matches the production guard's order).
    expect(validateSendAttachments("", tooMany)).toBe(`Attach at most ${String(MAX_ATTACHMENTS)} files`);
  });

  it("rejects a non-array attachments value", () => {
    expect(validateSendAttachments("hi", "not-an-array")).toBe(`Attach at most ${String(MAX_ATTACHMENTS)} files`);
  });

  // The array can hold anything JSON can express. The downstream ref check is
  // a regex, and `RegExp.test` stringifies — so a nested array of a valid
  // uuid would read as that uuid and reach a uuid-typed query.
  it.each([[[["ref-1"]]], [[null]], [[42]], [[{}]], [["ok", 7]]])(
    "rejects the non-string element in %j",
    (atts) => {
      expect(validateSendAttachments("hi", atts)).toBe(`Attach at most ${String(MAX_ATTACHMENTS)} files`);
    },
  );

  it(`accepts exactly ${String(MAX_ATTACHMENTS)} attachments`, () => {
    const atCap = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => `ref-${String(i)}`);
    expect(validateSendAttachments("hi", atCap)).toBeNull();
  });
});
