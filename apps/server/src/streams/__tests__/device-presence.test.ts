import { describe, expect, it } from "vitest";
import { normalizeDeviceAnswer } from "@loxaic/types";
import { capsFromQuery, hasLocationDevice, registerDeviceSocket } from "../device-presence.ts";

describe("device presence", () => {
  it("counts each socket that can share a location until it closes", () => {
    const user = `presence-${String(Math.random())}`;
    expect(hasLocationDevice(user)).toBe(false);
    const phone = registerDeviceSocket(user, ["location"]);
    const laptop = registerDeviceSocket(user, capsFromQuery("other, location"));
    const oldApp = registerDeviceSocket(user, capsFromQuery(null));
    phone();
    // Released twice: still counts once.
    phone();
    expect(hasLocationDevice(user)).toBe(true);
    laptop();
    expect(hasLocationDevice(user)).toBe(false);
    oldApp();
    expect(hasLocationDevice(user)).toBe(false);
  });

  it("reads caps as a short comma-separated list", () => {
    expect(capsFromQuery("location")).toEqual(["location"]);
    expect(capsFromQuery(" location , ,x")).toEqual(["location", "x"]);
    expect(capsFromQuery("x".repeat(40))).toEqual([]);
  });
});

describe("normalizeDeviceAnswer", () => {
  it("keeps a shared position rounded to about a kilometre", () => {
    expect(normalizeDeviceAnswer({ outcome: "shared", location: { lat: -27.46794, lon: 153.02809 }, tz: "Australia/Brisbane", always: true })).toEqual({
      outcome: "shared",
      location: { lat: -27.47, lon: 153.03 },
      tz: "Australia/Brisbane",
      always: true,
    });
  });

  it("refuses a share without a usable position, and anything that is not an answer", () => {
    for (const bad of [
      null,
      "shared",
      [],
      { outcome: "maybe" },
      { outcome: "shared" },
      { outcome: "shared", location: { lat: 91, lon: 0 } },
      { outcome: "shared", location: { lat: 0, lon: 181 } },
      { outcome: "shared", location: { lat: NaN, lon: 0 } },
      { outcome: "shared", location: { lat: "1", lon: 2 } },
    ]) {
      expect(normalizeDeviceAnswer(bad)).toBeNull();
    }
  });

  it("drops what does not belong with the outcome", () => {
    expect(normalizeDeviceAnswer({ outcome: "declined", always: true, location: { lat: 1, lon: 2 } })).toEqual({ outcome: "declined" });
    expect(normalizeDeviceAnswer({ outcome: "unavailable", reason: "permission_denied", location: { lat: 1, lon: 2 } })).toEqual({
      outcome: "unavailable",
      reason: "permission_denied",
    });
    expect(normalizeDeviceAnswer({ outcome: "unavailable", reason: "<script>" })).toEqual({ outcome: "unavailable", reason: "error" });
    expect(normalizeDeviceAnswer({ outcome: "declined", tz: "not a zone" })).toEqual({ outcome: "declined" });
  });
});
