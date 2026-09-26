import { describe, expect, it } from "vitest";
import { clientRefOf } from "../client-ref.ts";

describe("clientRefOf", () => {
  it("echoes a short identifier", () => {
    expect(clientRefOf({ type: "chat.send", client_ref: "lm1790000000000" })).toBe("lm1790000000000");
  });

  it("echoes nothing it cannot vouch for: absent, not a string, too long, or not an identifier", () => {
    expect(clientRefOf({ type: "chat.send" })).toBeUndefined();
    expect(clientRefOf({ client_ref: 42 })).toBeUndefined();
    expect(clientRefOf({ client_ref: "x".repeat(65) })).toBeUndefined();
    expect(clientRefOf({ client_ref: "<img src=x>" })).toBeUndefined();
    expect(clientRefOf(null)).toBeUndefined();
  });
});
