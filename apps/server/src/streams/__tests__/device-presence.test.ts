import { describe, expect, it } from "vitest";
import { normalizeDeviceAnswer } from "@loxaic/types";
import { canShareLocation, capsFromQuery, followStream, hasLocationFollower, waitForLocationFollower } from "../device-presence.ts";

describe("device presence", () => {
  it("counts each capable socket following a run, for that run only, until it stops", () => {
    const user = `presence-${String(Math.random())}`;
    expect(hasLocationFollower(user, "run-a")).toBe(false);
    const phone = followStream(user, "run-a");
    const laptop = followStream(user, "run-a");
    // A device open on another thread does not count for this run.
    const elsewhere = followStream(user, "run-b");
    phone();
    // Released twice: still counts once.
    phone();
    expect(hasLocationFollower(user, "run-a")).toBe(true);
    laptop();
    expect(hasLocationFollower(user, "run-a")).toBe(false);
    expect(hasLocationFollower(user, "run-b")).toBe(true);
    expect(hasLocationFollower(`${user}-other`, "run-b")).toBe(false);
    elsewhere();
  });

  it("waits a moment for the sending socket to follow, and no longer", async () => {
    const user = `presence-wait-${String(Math.random())}`;
    const never = new AbortController().signal;
    const late = waitForLocationFollower(user, "run", never, 1_000);
    const release = followStream(user, "run");
    expect(await late).toBe(true);
    release();
    expect(await waitForLocationFollower(user, "run", never, 30)).toBe(false);
    const stop = new AbortController();
    const stopped = waitForLocationFollower(user, "run", stop.signal, 10_000);
    stop.abort();
    expect(await stopped).toBe(false);
  });

  it("reads caps as a short comma-separated list", () => {
    expect(capsFromQuery("location")).toEqual(["location"]);
    expect(capsFromQuery(" location , ,x")).toEqual(["location", "x"]);
    expect(capsFromQuery("x".repeat(40))).toEqual([]);
    expect(canShareLocation(capsFromQuery("other, location"))).toBe(true);
    expect(canShareLocation(capsFromQuery(null))).toBe(false);
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
