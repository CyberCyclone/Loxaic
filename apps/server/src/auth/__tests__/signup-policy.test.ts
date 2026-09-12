import { describe, expect, it } from "vitest";
import { signUpClosedReason } from "../index.ts";

describe("sign-up policy", () => {
  it("is open by default", () => {
    expect(signUpClosedReason({})).toBe(null);
  });

  it("closes registration while the server is published through Funnel", () => {
    // The first account created is made admin, and a Funnel address is in
    // Certificate Transparency logs the moment it exists — so an open sign-up
    // there hands the deployment to whoever finds it first.
    const reason = signUpClosedReason({ LOXAIC_FUNNEL: "1" });
    expect(reason).toMatch(/published to the internet/);
    expect(reason).toMatch(/Turn Funnel off/);
  });

  it("does not read anything but the exact flag", () => {
    expect(signUpClosedReason({ LOXAIC_FUNNEL: "0" })).toBe(null);
    expect(signUpClosedReason({ LOXAIC_FUNNEL: "" })).toBe(null);
  });
});
