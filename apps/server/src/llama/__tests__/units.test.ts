import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bestFit, estimateFit } from "../fit.ts";
import { readGgufFacts } from "../gguf.ts";
import { cudaFlavourForDriver, defaultDevices, parseDeviceList, resolveFlavour } from "../hardware.ts";
import { groupQuants, isRepoId, quantOf } from "../hf.ts";
import { LoadSettingsError, normalizeLoadSettings, perRequestWindow, presetLines } from "../load-settings.ts";
import { isSafeSectionName, modelIdFromRouterName, renderPreset, routerModelName } from "../preset.ts";
import { explainRouterExit } from "../router.ts";
import { buildGguf, denseModel } from "./gguf-fixture.ts";

const GiB = 1024 ** 3;

describe("load settings", () => {
  it("refuses an unknown key rather than dropping it — one unknown preset key stops the whole router", () => {
    expect(() => normalizeLoadSettings({ mlock: true })).toThrow(LoadSettingsError);
    expect(() => normalizeLoadSettings({ ctxSize: 4096, "no-mmap": true })).toThrow(/not a load setting/);
  });

  it("range-checks against the model's own facts", () => {
    expect(normalizeLoadSettings({ ctxSize: 32768 }, { nCtxTrain: 40960 })).toEqual({ ctxSize: 32768 });
    expect(() => normalizeLoadSettings({ ctxSize: 65536 }, { nCtxTrain: 40960 })).toThrow(/512 to 40960/);
    // llama.cpp counts the output layer, so "all on the GPU" is n_layers + 1.
    expect(normalizeLoadSettings({ gpuLayers: 29 }, { nLayers: 28 })).toEqual({ gpuLayers: 29 });
    expect(() => normalizeLoadSettings({ gpuLayers: 30 }, { nLayers: 28 })).toThrow();
    expect(normalizeLoadSettings({ gpuLayers: "all" })).toEqual({ gpuLayers: "all" });
  });

  it("refuses a value that could break the preset file", () => {
    expect(() => normalizeLoadSettings({ flashAttention: "on\n[evil]" })).toThrow();
    expect(() => normalizeLoadSettings({ cacheTypeK: "q8_0 = x" })).toThrow();
    expect(() => normalizeLoadSettings({ temperature: "0.5" })).toThrow();
  });

  it("null resets a key, and a micro-batch may not exceed the batch", () => {
    expect(normalizeLoadSettings({ ctxSize: null, seed: 7 })).toEqual({ seed: 7 });
    expect(() => normalizeLoadSettings({ batchSize: 256, ubatchSize: 512 })).toThrow(/micro-batch/);
  });

  it("renders llama.cpp's own key names, and only them", () => {
    const lines = presetLines(
      { ctxSize: 8192, loadMode: "mmap+mlock", kvOffload: false, temperature: 0.6, gpuLayers: "all" },
      { mmprojPath: null },
    );
    expect(lines).toEqual(["ctx-size = 8192", "n-gpu-layers = all", "kv-offload = false", "load-mode = mmap+mlock", "temp = 0.6"]);
  });

  it("writes the vision projector unless vision was switched off", () => {
    expect(presetLines({}, { mmprojPath: "/m/mmproj.gguf" })).toEqual(["mmproj = /m/mmproj.gguf"]);
    expect(presetLines({ vision: false }, { mmprojPath: "/m/mmproj.gguf" })).toEqual([]);
  });

  it("a stored value that no longer validates falls back to defaults instead of reaching the file", () => {
    expect(presetLines({ bogus: 1 }, { mmprojPath: null })).toEqual([]);
  });

  it("predicts the per-request window: split between slots unless the KV cache is unified", () => {
    expect(perRequestWindow({}, 32768)).toBe(32768);
    expect(perRequestWindow({ parallel: 4, kvUnified: false }, 32768)).toBe(8192);
    expect(perRequestWindow({ parallel: 4, kvUnified: true }, 32768)).toBe(32768);
    expect(perRequestWindow({ parallel: 4 }, 32768)).toBe(8192);
  });
});

describe("preset file", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: "unsloth/Qwen3-0.6B-GGUF:Q4_K_M",
      repo: "unsloth/Qwen3-0.6B-GGUF",
      revision: "50968a4468ef4233ed78cd7c3de230dd1d61a56b",
      files: [{ path: "Qwen3-0.6B-Q4_K_M.gguf", size: 1, sha256: "a".repeat(64) }],
      mmproj: null,
      loadSettings: {},
      meta: {},
      ...over,
    }) as never;

  it("one section per model, named with no ':' for the router to rewrite", () => {
    const text = renderPreset([row({ loadSettings: { ctxSize: 4096 } })], { devices: ["Vulkan1"] });
    expect(text).toContain("[*]\njinja = true\ndevice = Vulkan1");
    // The file path carries the revision the model was downloaded at.
    expect(text).toMatch(/\[unsloth\/Qwen3-0\.6B-GGUF@Q4_K_M\]\nmodel = .*50968a4468ef.*Qwen3-0\.6B-Q4_K_M\.gguf\nctx-size = 4096/);
  });

  it("maps an id to its router name and back, one to one", () => {
    // b11149 rewrites a section name's quant after a ':' (uppercased, "UD-"
    // dropped), so the name it is given has none.
    for (const id of ["unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_XL", "a/b:q4_k_m", "a/b:Q4_K_M"]) {
      expect(routerModelName(id)).not.toContain(":");
      expect(modelIdFromRouterName(routerModelName(id))).toBe(id);
    }
    // Two quants the router's own rewrite would merge stay two names.
    expect(routerModelName("a/b:q4_k_m")).not.toBe(routerModelName("a/b:Q4_K_M"));
  });

  it("CPU only forces zero GPU layers, whatever the model's settings say", () => {
    const text = renderPreset([row({ loadSettings: { gpuLayers: "all" } })], { devices: "none" });
    expect(text).toContain("device = none");
    expect(text).toContain("n-gpu-layers = 0");
    expect(text).not.toContain("n-gpu-layers = all");
  });

  it("refuses section names that would corrupt the file", () => {
    expect(isSafeSectionName("a/b:Q4")).toBe(true);
    expect(isSafeSectionName("a/b:Q4]\n[x")).toBe(false);
    expect(renderPreset([row({ id: "a/b]:x" })], { devices: null })).not.toContain("a/b]");
  });
});

describe("hardware", () => {
  it("parses --list-devices and drops entries with no memory", () => {
    const devices = parseDeviceList(
      "Available devices:\n  MTL0: Apple M3 Max (28753 MiB, 28753 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n",
    );
    expect(devices).toEqual([{ name: "MTL0", description: "Apple M3 Max", totalBytes: 28753 * 1024 * 1024, freeBytes: 28753 * 1024 * 1024 }]);
  });

  it("leaves a small display card out of the default set (V620 beside a GT 1030)", () => {
    const devices = parseDeviceList(
      "  Vulkan0: NVIDIA GeForce GT 1030 (2048 MiB, 1900 MiB free)\n  Vulkan1: AMD Radeon Pro V620 (30720 MiB, 30000 MiB free)\n",
    );
    expect(defaultDevices(devices)).toEqual(["Vulkan1"]);
    // Every GPU small: use them all rather than none.
    expect(defaultDevices(devices.slice(0, 1))).toEqual(["Vulkan0"]);
  });

  it("leaves out a big GPU another program has filled (two V620s, LM Studio on one)", () => {
    // What --list-devices really printed on the beta box.
    const devices = parseDeviceList(
      "  Vulkan0: AMD Radeon Pro V620 (RADV NAVI21) (30704 MiB, 3880 MiB free)\n  Vulkan1: AMD Radeon Pro V620 (RADV NAVI21) (30704 MiB, 30687 MiB free)\n",
    );
    expect(defaultDevices(devices)).toEqual(["Vulkan1"]);
    // Both busy: fall back to the cards that are big at all.
    const busy = devices.map((d) => ({ ...d, freeBytes: 1024 ** 3 }));
    expect(defaultDevices(busy)).toEqual(["Vulkan0", "Vulkan1"]);
  });

  it("auto never resolves to the CPU", () => {
    expect(resolveFlavour("auto", { flavour: null, platform: "linux" })).toBeNull();
    expect(resolveFlavour("cpu", { flavour: null, platform: "linux" })).toBe("cpu");
    expect(resolveFlavour("auto", { flavour: "vulkan", platform: "linux" })).toBe("vulkan");
  });

  it("picks the CUDA build a driver can run", () => {
    expect(cudaFlavourForDriver(580)).toBe("cuda13");
    expect(cudaFlavourForDriver(560)).toBe("cuda12");
    expect(cudaFlavourForDriver(470)).toBeNull();
  });
});

describe("fit", () => {
  it("labels by the memory a model needs against what the devices have", () => {
    expect(estimateFit({ weightBytes: 4 * GiB, memoryBytes: 24 * GiB, cpu: false }).label).toBe("will-fit");
    expect(estimateFit({ weightBytes: 20 * GiB, memoryBytes: 24 * GiB, cpu: false }).label).toBe("might-fit");
    expect(estimateFit({ weightBytes: 40 * GiB, memoryBytes: 24 * GiB, cpu: false }).label).toBe("wont-fit");
  });

  it("is unknown — never 'will fit' — when memory could not be measured", () => {
    expect(estimateFit({ weightBytes: 1, memoryBytes: null, cpu: false }).label).toBe("unknown");
  });

  it("follows the settings: a long context costs memory, a partial offload saves it", () => {
    const base = { weightBytes: 14 * GiB, memoryBytes: 24 * GiB, cpu: false, nLayers: 48 };
    expect(estimateFit(base).label).toBe("will-fit");
    expect(estimateFit({ ...base, settings: { ctxSize: 131072 } }).label).toBe("wont-fit");
    expect(estimateFit({ ...base, weightBytes: 30 * GiB, settings: { gpuLayers: 20 } }).label).toBe("will-fit");
  });

  it("the best of several quants", () => {
    expect(bestFit(["wont-fit", "might-fit", "will-fit"])).toBe("will-fit");
    expect(bestFit(["wont-fit", "unknown"])).toBe("unknown");
  });
});

describe("HuggingFace file grouping", () => {
  it("reads the quant from the file name, or the folder", () => {
    expect(quantOf("Qwen3-0.6B-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("Qwen3-0.6B-UD-Q4_K_XL.gguf")).toBe("UD-Q4_K_XL");
    expect(quantOf("gemma-3-4b-it-BF16.gguf")).toBe("BF16");
    expect(quantOf("Q8_0/Kimi-K2-00001-of-00003.gguf")).toBe("Q8_0");
    expect(quantOf("model-IQ4_XS-00001-of-00002.gguf")).toBe("IQ4_XS");
  });

  it("groups split files, drops an incomplete split, and separates the vision projector", () => {
    const sha = "a".repeat(64);
    const { quants, mmproj } = groupQuants([
      { type: "file", path: "m-Q4_K_M.gguf", size: 400, lfs: { oid: sha, size: 400 } },
      { type: "file", path: "m-Q8_0-00001-of-00002.gguf", size: 500, lfs: { oid: sha, size: 500 } },
      { type: "file", path: "m-Q8_0-00002-of-00002.gguf", size: 300, lfs: { oid: sha, size: 300 } },
      { type: "file", path: "m-F16-00001-of-00002.gguf", size: 900, lfs: { oid: sha, size: 900 } },
      { type: "file", path: "mmproj-F16.gguf", size: 80, lfs: { oid: sha, size: 80 } },
      { type: "file", path: "README.md", size: 10 },
      { type: "directory", path: "Q8_0" },
    ]);
    expect(quants.map((q) => [q.quant, q.sizeBytes, q.files.length])).toEqual([
      ["Q4_K_M", 400, 1],
      ["Q8_0", 800, 2],
    ]);
    expect(quants[0].files[0].sha256).toBe(sha);
    expect(mmproj.map((m) => m.path)).toEqual(["mmproj-F16.gguf"]);
  });

  it("only accepts owner/name repo ids", () => {
    expect(isRepoId("unsloth/Qwen3-8B-GGUF")).toBe(true);
    expect(isRepoId("../etc/passwd")).toBe(false);
    expect(isRepoId("a/b/c")).toBe(false);
    expect(isRepoId("a/..")).toBe(false);
  });
});

describe("GGUF header", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-gguf-"));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads layers and context length past a vocabulary array", async () => {
    const file = path.join(dir, "m.gguf");
    writeFileSync(file, denseModel());
    await expect(readGgufFacts(file)).resolves.toEqual({ architecture: "qwen3", nLayers: 28, nCtxTrain: 40960, expertCount: null });
  });

  it("finds expert_count on a mixture-of-experts model", async () => {
    const file = path.join(dir, "moe.gguf");
    writeFileSync(
      file,
      buildGguf([
        ["general.architecture", { type: "str", v: "qwen3moe" }],
        ["qwen3moe.block_count", { type: "u32", v: 48 }],
        ["qwen3moe.context_length", { type: "u32", v: 262144 }],
        ["qwen3moe.expert_count", { type: "u32", v: 128 }],
      ]),
    );
    await expect(readGgufFacts(file)).resolves.toMatchObject({ nLayers: 48, expertCount: 128 });
  });

  it("refuses something that is not a GGUF", async () => {
    const file = path.join(dir, "no.gguf");
    writeFileSync(file, "hello world, not a model");
    await expect(readGgufFacts(file)).rejects.toThrow(/Not a GGUF/);
  });
});

describe("router exit explanation", () => {
  it("names llama.cpp's own error line, without its timestamp", () => {
    const why = explainRouterExit(
      [
        "0.00.000.592 I srv  llama_server: initializing ...",
        "0.00.067.911 E srv  llama_server: failed to initialize router models: option 'mlock' not recognized",
      ],
      1,
      null,
    );
    expect(why).toBe("llama.cpp exited with code 1: llama_server: failed to initialize router models: option 'mlock' not recognized");
  });
});
