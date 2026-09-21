import { beforeEach, describe, expect, it } from "vitest";
import { __resetPrefillRatesForTest, prefillRate, recordPrefill, sampleFrom } from "../prefill-rate.ts";

const base = { promptTps: null, promptTokens: 10_000, exactReusableTokens: 2_000, ttftMs: 40_000, loadedModel: false };

describe("sampleFrom", () => {
  it("prefers the backend's own evaluation rate", () => {
    expect(sampleFrom({ ...base, promptTps: 312 })).toBe(312);
  });

  it("divides only the evaluated tokens, never the whole prompt", () => {
    // 8,000 evaluated in 40 s — not 10,000 / 40.
    expect(sampleFrom(base)).toBe(200);
  });

  it("refuses anything it cannot measure exactly", () => {
    expect(sampleFrom({ ...base, exactReusableTokens: null })).toBeNull();
    expect(sampleFrom({ ...base, loadedModel: true })).toBeNull();
    expect(sampleFrom({ ...base, ttftMs: null })).toBeNull();
    expect(sampleFrom({ ...base, ttftMs: 0 })).toBeNull();
    // A fully reused prompt evaluates a handful of tokens; its TTFT is
    // overhead, and dividing by it is the 47,742 tok/s bug.
    expect(sampleFrom({ ...base, exactReusableTokens: 9_900 })).toBeNull();
  });
});

describe("prefillRate", () => {
  beforeEach(() => {
    __resetPrefillRatesForTest();
  });

  it("is null until there is a sample", () => {
    expect(prefillRate("m")).toBeNull();
  });

  it("is the median of recent samples, per model", () => {
    for (const tps of [100, 200, 10_000]) recordPrefill("m", { ...base, promptTps: tps });
    recordPrefill("other", { ...base, promptTps: 5 });
    expect(prefillRate("m")).toBe(200);
    expect(prefillRate("other")).toBe(5);
  });

  it("keeps only the most recent eight", () => {
    for (let i = 0; i < 8; i++) recordPrefill("m", { ...base, promptTps: 1 });
    for (let i = 0; i < 8; i++) recordPrefill("m", { ...base, promptTps: 50 });
    expect(prefillRate("m")).toBe(50);
  });

  it("ignores an observation that yields no sample", () => {
    recordPrefill("m", { ...base, loadedModel: true });
    expect(prefillRate("m")).toBeNull();
  });
});
