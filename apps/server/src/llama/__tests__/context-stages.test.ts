import { describe, expect, it } from "vitest";
import {
  activeStageIndex,
  effectiveSettings,
  normalizeContextStages,
  stageContexts,
  stageFactor,
  yarnFactorOf,
  yarnLines,
} from "../context-stages.ts";
import { LoadSettingsError } from "../load-settings.ts";
import { renderPreset } from "../preset.ts";

const meta = { nCtxTrain: 262144, nLayers: 64 };
const K = 1024;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "unsloth/Qwen3.8-27B-GGUF:UD-Q5_K_XL",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    revision: "4ca720788d1e0000000000000000000000000000",
    files: [{ path: "Qwen3.8-27B-UD-Q5_K_XL.gguf", size: 1, sha256: "a".repeat(64) }],
    mmproj: null,
    loadSettings: {},
    meta,
    contextStages: { enabled: true, stages: [{ ctxSize: 512 * K }, { ctxSize: 768 * K }, { ctxSize: 1024 * K, cacheTypeK: "q8_0", cacheTypeV: "q8_0" }] },
    activeStage: 0,
    ...over,
  } as never;
}

describe("context stages", () => {
  it("fills in who may change it and what happens when full, compact by default", () => {
    expect(normalizeContextStages({ enabled: true, stages: [{ ctxSize: 512 * K }] }, meta, {})).toEqual({
      enabled: true,
      whoMayChange: "everyone",
      whenFull: "compact",
      stages: [{ ctxSize: 512 * K }],
    });
  });

  it("derives the YaRN factor from the stage's context — it follows the context, not the admin", () => {
    expect(stageFactor({ ctxSize: 512 * K }, meta)).toBe(2);
    expect(stageFactor({ ctxSize: 768 * K }, meta)).toBe(3);
    expect(stageFactor({ ctxSize: 1024 * K }, meta)).toBe(4);
    expect(stageFactor({ ctxSize: 393216 }, meta)).toBe(1.5);
    expect(stageFactor({ ctxSize: 1024 * K, ropeScale: 3.5 }, meta)).toBe(3.5);
    expect(stageFactor({ ctxSize: 1024 * K, yarnOrigCtx: 131072 }, meta)).toBe(8);
  });

  it("a stage no larger than the trained context is a bigger ctx-size, not YaRN", () => {
    const low = row({ loadSettings: { ctxSize: 65536 }, meta: { nCtxTrain: 262144, nLayers: 64 }, contextStages: { enabled: true, stages: [{ ctxSize: 131072 }, { ctxSize: 512 * K }] } });
    expect(yarnLines(low, 1)).toEqual([]); // 128K < 256K trained: 0.5×
    expect(yarnLines(low, 2)).toEqual(["rope-scaling = yarn", "rope-scale = 2", "yarn-orig-ctx = 262144"]);
    expect(yarnFactorOf({ ctxSize: 262144 }, meta)).toBeNull(); // exactly trained: 1×
    expect(yarnFactorOf({ ctxSize: 512 * K }, meta)).toBe(2);
    expect(yarnFactorOf({ ctxSize: 512 * K, ropeScale: 3 }, meta)).toBe(3);
  });

  it("refuses stages that do not grow, and a factor nothing can derive", () => {
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 200_000 }] }, meta, {})).toThrow(/larger than the standard context \(262144\)/);
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 600_000 }, { ctxSize: 600_000 }] }, meta, {})).toThrow(/larger than stage 1/);
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 600_000 }] }, {}, { ctxSize: 4096 })).toThrow(/YaRN factor/);
    expect(() => normalizeContextStages({ enabled: true, stages: [] }, meta, {})).toThrow(/at least one/);
    expect(() => normalizeContextStages({ enabled: true, stages: Array.from({ length: 7 }, (_, i) => ({ ctxSize: 300_000 + i * 1000 })) }, meta, {})).toThrow(/at most 6/);
  });

  it("refuses anything that could reach the preset as something other than a checked number", () => {
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 600_000, ropeScale: "2\n[evil]" }] }, meta, {})).toThrow(LoadSettingsError);
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 600_000, cacheTypeK: "q8_0 = x" }] }, meta, {})).toThrow();
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 600_000, mlock: true }] }, meta, {})).toThrow(/not a stage setting/);
    expect(() => normalizeContextStages({ enabled: true, extra: 1, stages: [] }, meta, {})).toThrow(/not a context stage setting/);
  });

  it("refuses YaRN on top of a manual frequency scale — the two set the same parameter", () => {
    expect(() => normalizeContextStages({ enabled: true, stages: [{ ctxSize: 600_000 }] }, meta, { ropeFreqScale: 0.5 })).toThrow(/RoPE frequency scale/);
  });

  it("loads the active stage's context and cache types on top of the base settings", () => {
    const r = row({ loadSettings: { gpuLayers: "all", flashAttention: "on" }, activeStage: 3 });
    expect(effectiveSettings(r)).toEqual({ gpuLayers: "all", flashAttention: "on", ctxSize: 1024 * K, cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
    expect(effectiveSettings(row({ activeStage: 0 }))).toEqual({});
    expect(stageContexts(r)).toEqual([262144, 512 * K, 768 * K, 1024 * K]);
  });

  it("clamps the active stage to what exists, and to standard when stages are off", () => {
    expect(activeStageIndex(row({ activeStage: 9 }))).toBe(3);
    expect(activeStageIndex(row({ activeStage: 2, contextStages: { enabled: false, stages: [] } }))).toBe(0);
    // A stored value that no longer validates reads as no stages at all.
    expect(activeStageIndex(row({ activeStage: 2, loadSettings: { ropeFreqScale: 0.5 } }))).toBe(0);
  });

  it("writes the YaRN keys the real router accepts, and none for the standard stage", () => {
    expect(yarnLines(row(), 0)).toEqual([]);
    expect(yarnLines(row(), 1)).toEqual(["rope-scaling = yarn", "rope-scale = 2", "yarn-orig-ctx = 262144"]);
    const withKnobs = row({ contextStages: { enabled: true, stages: [{ ctxSize: 512 * K, extFactor: -1, attnFactor: 1, betaSlow: 1, betaFast: 32 }] } });
    expect(yarnLines(withKnobs, 1)).toEqual([
      "rope-scaling = yarn", "rope-scale = 2", "yarn-orig-ctx = 262144",
      "yarn-ext-factor = -1", "yarn-attn-factor = 1", "yarn-beta-slow = 1", "yarn-beta-fast = 32",
    ]);
  });

  it("renders the active stage into the model's preset section", () => {
    const standard = renderPreset([row()], { devices: null });
    expect(standard).not.toContain("rope-scaling");
    expect(standard).not.toContain("ctx-size");
    const million = renderPreset([row({ activeStage: 3 })], { devices: null });
    expect(million).toContain("ctx-size = 1048576\ncache-type-k = q8_0\ncache-type-v = q8_0\nrope-scaling = yarn\nrope-scale = 4\nyarn-orig-ctx = 262144");
  });
});

describe("the fake router's preset keys", () => {
  it("accept every key the server can write, and so fail on any new one nobody added", async () => {
    const { readFileSync } = await import("node:fs");
    const { LOAD_SETTINGS, presetLines } = await import("../load-settings.ts");
    const fake = readFileSync(new URL("../../../test-fixtures/fake-llama-server.mjs", import.meta.url), "utf8");
    const listed = new Set(fake.slice(fake.indexOf("PRESET_KEYS = new Set"), fake.indexOf("]);", fake.indexOf("PRESET_KEYS"))).match(/"[a-z-]+"/g)?.map((k) => k.slice(1, -1)));
    const written = [
      ...LOAD_SETTINGS.map((s) => s.flag),
      // Keys written by presetLines itself rather than as a spec's flag: the
      // projector path and a separate MTP head.
      ...presetLines({ mtp: true, mtpDraftMax: 2 }, { mmprojPath: "/p.gguf", mtp: { draftModelPath: "/h.gguf" } }).map((l) => l.split(" = ")[0]),
      // The lookup table's placement, and the globals' log verbosity.
      ...presetLines({ tablePlacement: "ram" }, { mmprojPath: null, facts: { lookupTable: { bytes: 1 } } }).map((l) => l.split(" = ")[0]),
      ...renderPreset([], { devices: null, placementLog: true }).split("\n").filter((l) => l.includes(" = ")).map((l) => l.split(" = ")[0]),
      ...yarnLines(row({ contextStages: { enabled: true, stages: [{ ctxSize: 512 * K, extFactor: -1, attnFactor: 1, betaSlow: 1, betaFast: 32 }] } }), 1).map((l) => l.split(" = ")[0]),
    ];
    for (const key of written) expect(listed.has(key), key).toBe(true);
  });
});
