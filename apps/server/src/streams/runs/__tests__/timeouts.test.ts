import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, MIN_WAIT_TIMEOUT_MS } from "@loxaic/types";
import {
  clampAutoContinues,
  clampWaitTimeoutMs,
  effectiveTimeoutMs,
  serverDefaultTimeoutMs,
  unattendedDecision,
} from "../timeouts.ts";

describe("clampWaitTimeoutMs", () => {
  it("keeps null as null — it means the server default, not zero", () => {
    expect(clampWaitTimeoutMs(null)).toBeNull();
    expect(clampWaitTimeoutMs(undefined)).toBeNull();
    expect(clampWaitTimeoutMs(Number.NaN)).toBeNull();
  });

  it("clamps into the supported range", () => {
    expect(clampWaitTimeoutMs(1)).toBe(MIN_WAIT_TIMEOUT_MS);
    expect(clampWaitTimeoutMs(10 * MAX_WAIT_TIMEOUT_MS)).toBe(MAX_WAIT_TIMEOUT_MS);
    expect(clampWaitTimeoutMs(60_000)).toBe(60_000);
  });
});

describe("clampAutoContinues", () => {
  it("clamps to 0-3", () => {
    expect(clampAutoContinues(-2)).toBe(0);
    expect(clampAutoContinues(99)).toBe(3);
    expect(clampAutoContinues(2)).toBe(2);
    expect(clampAutoContinues(null)).toBeNull();
  });
});

describe("serverDefaultTimeoutMs", () => {
  const previous = process.env.APPROVAL_TIMEOUT_MS;
  afterEach(() => {
    if (previous === undefined) delete process.env.APPROVAL_TIMEOUT_MS;
    else process.env.APPROVAL_TIMEOUT_MS = previous;
  });

  it("is ten minutes when the operator has said nothing", () => {
    delete process.env.APPROVAL_TIMEOUT_MS;
    expect(serverDefaultTimeoutMs()).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it("follows the env, read at call time, with no lower bound", () => {
    process.env.APPROVAL_TIMEOUT_MS = "50";
    expect(serverDefaultTimeoutMs()).toBe(50);
  });

  it("never exceeds the ceiling — far below where Node turns a delay into 1 ms", () => {
    process.env.APPROVAL_TIMEOUT_MS = String(30 * 24 * 60 * 60_000);
    expect(serverDefaultTimeoutMs()).toBe(MAX_WAIT_TIMEOUT_MS);
    expect(MAX_WAIT_TIMEOUT_MS).toBeLessThan(2 ** 31 - 1);
  });

  it("ignores garbage", () => {
    for (const bad of ["", "abc", "-5", "0"]) {
      process.env.APPROVAL_TIMEOUT_MS = bad;
      expect(serverDefaultTimeoutMs()).toBe(DEFAULT_WAIT_TIMEOUT_MS);
    }
  });
});

describe("effectiveTimeoutMs", () => {
  it("uses the setting when the run has been quick", () => {
    expect(effectiveTimeoutMs({ baseMs: 600_000, adaptive: true, slowestTurnMs: 30_000 })).toEqual({
      ms: 600_000,
      basis: "setting",
    });
  });

  it("stretches to twice the slowest model request on a slow backend", () => {
    // A 22-minute turn, as on the beta box: ten minutes is not a coherent ask.
    const turn = 22 * 60_000;
    expect(effectiveTimeoutMs({ baseMs: 600_000, adaptive: true, slowestTurnMs: turn })).toEqual({
      ms: 2 * turn,
      basis: "adaptive",
    });
  });

  it("does not stretch with adaptive off", () => {
    expect(effectiveTimeoutMs({ baseMs: 600_000, adaptive: false, slowestTurnMs: 60 * 60_000 })).toEqual({
      ms: 600_000,
      basis: "setting",
    });
  });

  it("never exceeds the ceiling", () => {
    expect(effectiveTimeoutMs({ baseMs: 600_000, adaptive: true, slowestTurnMs: MAX_WAIT_TIMEOUT_MS }).ms).toBe(
      MAX_WAIT_TIMEOUT_MS,
    );
  });
});

describe("unattendedDecision", () => {
  it("walks the ladder: keep going twice, then wrap up", () => {
    expect([0, 1, 2, 3].map((prior) => unattendedDecision(prior, 2, "timeout"))).toEqual([
      "continue",
      "continue",
      "answer",
      "answer",
    ]);
  });

  it("wraps up straight away with no auto-continues", () => {
    expect(unattendedDecision(0, 0, "timeout")).toBe("answer");
  });

  it("always wraps up when the run has gone", () => {
    expect(unattendedDecision(0, 3, "gone")).toBe("answer");
  });
});
