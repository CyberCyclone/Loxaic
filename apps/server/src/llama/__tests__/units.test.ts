import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bestFit, estimateFit } from "../fit.ts";
import { readGgufFacts } from "../gguf.ts";
import { cudaFlavourForDriver, defaultDevices, parseDeviceList, resolveFlavour } from "../hardware.ts";
import { groupQuants, isMtpHeadFile, isProjectorFile, isRepoId, quantOf } from "../hf.ts";
import { checkMtpSetting, LoadSettingsError, normalizeLoadSettings, perRequestWindow, presetLines } from "../load-settings.ts";
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
    // The trained context is advice (RoPE scaling exists to exceed it); only
    // llama.cpp's 32-bit ceiling and the floor are limits.
    expect(normalizeLoadSettings({ ctxSize: 1_048_576 }, { nCtxTrain: 262144 })).toEqual({ ctxSize: 1_048_576 });
    expect(() => normalizeLoadSettings({ ctxSize: 2 ** 31 }, { nCtxTrain: 40960 })).toThrow(/512 to 2147483647/);
    expect(() => normalizeLoadSettings({ ctxSize: 256 }, { nCtxTrain: 40960 })).toThrow();
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

  describe("multi-token prediction", () => {
    it("writes draft-mtp for a head in the model's own file, and the head's path for a separate one", () => {
      expect(presetLines({ ctxSize: 8192, mtp: true }, { mmprojPath: null, mtp: { draftModelPath: null } })).toEqual([
        "ctx-size = 8192",
        "spec-type = draft-mtp",
      ]);
      expect(
        presetLines({ mtp: true, mtpDraftMax: 2 }, { mmprojPath: null, mtp: { draftModelPath: "/m/MTP/mtp-x-Q8_0.gguf" } }),
      ).toEqual(["spec-type = draft-mtp", "spec-draft-model = /m/MTP/mtp-x-Q8_0.gguf", "spec-draft-n-max = 2"]);
    });

    it("writes nothing for MTP while the head is not ready — and keeps every other setting", () => {
      // A head mid-download, or deleted after MTP was turned on, must cost the
      // model its MTP lines only: the fallback for an invalid row drops all.
      expect(presetLines({ ctxSize: 8192, mtp: true, mtpDraftMax: 2 }, { mmprojPath: null, mtp: null })).toEqual(["ctx-size = 8192"]);
      expect(presetLines({ mtp: false }, { mmprojPath: null, mtp: { draftModelPath: null } })).toEqual([]);
    });

    it("refuses MTP for a model with no head, and a draft length without MTP", () => {
      expect(() => { checkMtpSetting({ mtp: true }, null); }).toThrow(/no multi-token-prediction head/);
      expect(() => { checkMtpSetting({ mtpDraftMax: 2 }, "embedded"); }).toThrow(/only applies/);
      expect(() => { checkMtpSetting({ mtp: true, mtpDraftMax: 2 }, "head-pending"); }).not.toThrow();
      expect(() => { checkMtpSetting({ mtp: false }, null); }).not.toThrow();
      expect(() => normalizeLoadSettings({ mtpDraftMax: 9 })).toThrow(/1 to 8/);
    });
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
      mtpHead: null,
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

  it("drafts with the model's own head, or a separate one under the head's own revision once it is ready", () => {
    const own = renderPreset([row({ loadSettings: { mtp: true }, meta: { mtp: { layers: 1 } } })], { devices: null });
    expect(own).toContain("spec-type = draft-mtp");
    expect(own).not.toContain("spec-draft-model");
    const head = (status: string) => ({
      path: "MTP/mtp-Qwen3-0.6B-Q8_0.gguf", size: 1, sha256: "b".repeat(64),
      revision: "c".repeat(40), status, bytesDone: 0, error: null, layers: 1,
    });
    const ready = renderPreset([row({ loadSettings: { mtp: true, mtpDraftMax: 2 }, mtpHead: head("ready") })], { devices: null });
    // A head resolved at a later commit than the model lives under that commit.
    expect(ready).toMatch(/spec-draft-model = .*cccccccccccc.*MTP\/mtp-Qwen3-0\.6B-Q8_0\.gguf\nspec-draft-n-max = 2/);
    const pending = renderPreset([row({ loadSettings: { mtp: true, ctxSize: 4096 }, mtpHead: head("downloading") })], { devices: null });
    expect(pending).not.toContain("spec-");
    expect(pending).toContain("ctx-size = 4096");
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

  it("never offers a vision projector as a quant, wherever its name says mmproj", () => {
    // prism-ml/Ternary-Bonsai-2-27B-gguf's own file list: the two projectors
    // were offered as quants "BF16" and "Q8_0", and one was downloaded as the
    // model, which llama.cpp cannot load.
    const sha = "a".repeat(64);
    const entry = (path: string, size: number) => ({ type: "file", path, size, lfs: { oid: sha, size } });
    const { quants, mmproj } = groupQuants([
      entry("Ternary-Bonsai-2-27B-F16.gguf", 900),
      entry("Ternary-Bonsai-2-27B-mmproj-BF16.gguf", 93),
      entry("Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", 63),
    ]);
    expect(quants.map((q) => q.quant)).toEqual(["F16"]);
    expect(mmproj.map((m) => m.path)).toEqual([
      "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
      "Ternary-Bonsai-2-27B-mmproj-BF16.gguf",
    ]);
    for (const p of ["mmproj-F16.gguf", "mmproj-model-f16.gguf", "gemma-3-mmproj-BF16.gguf", "model.mmproj-Q8_0.gguf", "sub/Qwen2.5-VL-mmproj.gguf"]) {
      expect(isProjectorFile(p)).toBe(true);
    }
    // A word, not a substring: a model that merely contains the letters is a model.
    expect(isProjectorFile("Mmprojector-7B-Q4_K_M.gguf")).toBe(false);
  });

  it("keeps MTP heads out of the quants, so a split quant beside them survives (Qwen3.8-Flash-Next)", () => {
    // unsloth/Qwen3.8-Flash-Next-GGUF's layout: a three-part Q8_0 in its own
    // folder, and MTP/mtp-…-Q8_0.gguf, which quantOf also reads as "Q8_0".
    // Grouped together, the split failed "all parts and nothing else" and the
    // Q8_0 quant vanished from Discover.
    const sha = "a".repeat(64);
    const entry = (path: string, size: number) => ({ type: "file", path, size, lfs: { oid: sha, size } });
    const { quants, mtpHeads } = groupQuants([
      entry("Q8_0/Qwen3.8-Flash-Next-Q8_0-00001-of-00003.gguf", 500),
      entry("Q8_0/Qwen3.8-Flash-Next-Q8_0-00002-of-00003.gguf", 500),
      entry("Q8_0/Qwen3.8-Flash-Next-Q8_0-00003-of-00003.gguf", 300),
      entry("MTP/mtp-Qwen3.8-Flash-Next-Q8_0.gguf", 40),
      entry("MTP/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf", 26),
      entry("MTP/mtp-Qwen3.8-Flash-Next-BF16.gguf", 72),
    ]);
    expect(quants.map((q) => [q.quant, q.files.length])).toEqual([["Q8_0", 3]]);
    expect(mtpHeads.map((h) => [h.path, h.shared])).toEqual([
      ["MTP/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf", true],
      ["MTP/mtp-Qwen3.8-Flash-Next-Q8_0.gguf", false],
      ["MTP/mtp-Qwen3.8-Flash-Next-BF16.gguf", false],
    ]);
    // llama.cpp's own rule, case-sensitive at a word start: a full model
    // named for its built-in head is still a model.
    expect(isMtpHeadFile("Qwen3.5-0.8B-MTP-Q4_K_M.gguf")).toBe(false);
    expect(isMtpHeadFile("Model-mtp-Q8_0.gguf")).toBe(true);
    expect(isMtpHeadFile("Smtp-server-Q4_0.gguf")).toBe(false);
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
    await expect(readGgufFacts(file)).resolves.toEqual({
      architecture: "qwen3",
      nLayers: 28,
      nCtxTrain: 40960,
      expertCount: null,
      // The fixture describes no attention heads: the fit stays rough.
      shape: null,
      chatTemplate: null,
      mtp: null,
    });
  });

  it("reads the chat template past the vocabulary arrays, and model keys wherever they come", async () => {
    const file = path.join(dir, "template.gguf");
    const template = "{%- if enable_thinking is defined and enable_thinking is false %}<think></think>{%- endif %}";
    writeFileSync(
      file,
      buildGguf([
        ["general.architecture", { type: "str", v: "qwen35" }],
        ["qwen35.block_count", { type: "u32", v: 32 }],
        ["tokenizer.ggml.tokens", { type: "strs", v: Array.from({ length: 5000 }, (_, i) => `tok${String(i)}`) }],
        ["tokenizer.ggml.token_type", { type: "u32s", v: Array.from({ length: 5000 }, () => 1) }],
        // GGUF fixes no key order: a model key after the tokenizer's is
        // still the model's.
        ["qwen35.context_length", { type: "u32", v: 999 }],
        ["tokenizer.chat_template", { type: "str", v: template }],
      ]),
    );
    const facts = await readGgufFacts(file);
    expect(facts.chatTemplate).toBe(template);
    expect(facts.nLayers).toBe(32);
    expect(facts.nCtxTrain).toBe(999);
  });

  it("reads the attention layout, per-layer arrays included, before and after the tokenizer", async () => {
    const file = path.join(dir, "shape.gguf");
    writeFileSync(
      file,
      buildGguf([
        ["general.architecture", { type: "str", v: "gemma4" }],
        ["gemma4.block_count", { type: "u32", v: 6 }],
        ["gemma4.context_length", { type: "u32", v: 131072 }],
        ["gemma4.attention.head_count", { type: "u32", v: 8 }],
        ["gemma4.attention.head_count_kv", { type: "u32s", v: [2, 2, 2, 2, 2, 4] }],
        ["gemma4.attention.key_length", { type: "u32", v: 512 }],
        ["gemma4.attention.value_length", { type: "u32", v: 512 }],
        ["gemma4.attention.sliding_window", { type: "u32", v: 512 }],
        ["gemma4.attention.sliding_window_pattern", { type: "bools", v: [true, true, true, true, true, false] }],
        ["gemma4.rope.scaling.factor", { type: "f32", v: 4 }],
        ["tokenizer.ggml.tokens", { type: "strs", v: Array.from({ length: 5000 }, (_, i) => `tok${String(i)}`) }],
        // Past the tokenizer, and read all the same.
        ["gemma4.attention.shared_kv_layers", { type: "u32", v: 3 }],
      ]),
    );
    const facts = await readGgufFacts(file);
    expect(facts.shape).toMatchObject({
      nLayers: 6,
      nHeadKv: [2, 2, 2, 2, 2, 4],
      slidingWindow: 512,
      swaLayers: [true, true, true, true, true, false],
      sharedKvLayers: 3,
      ropeScaling: { factor: 4 },
    });
  });

  it("reads the architecture when a tokenizer key comes before it", async () => {
    // GGUF does not fix key order: a tokenizer key first must not end the
    // reading of model keys before the architecture is even known.
    const file = path.join(dir, "early-tokenizer.gguf");
    writeFileSync(
      file,
      buildGguf([
        ["tokenizer.ggml.model", { type: "str", v: "gpt2" }],
        ["general.architecture", { type: "str", v: "qwen3" }],
        ["qwen3.block_count", { type: "u32", v: 28 }],
        ["qwen3.context_length", { type: "u32", v: 40960 }],
        ["tokenizer.ggml.tokens", { type: "strs", v: ["a", "b"] }],
        ["tokenizer.chat_template", { type: "str", v: "{{ enable_thinking }}" }],
      ]),
    );
    await expect(readGgufFacts(file)).resolves.toMatchObject({
      architecture: "qwen3",
      nLayers: 28,
      nCtxTrain: 40960,
      chatTemplate: "{{ enable_thinking }}",
    });
  });

  it("walks a large vocabulary to the chat template quickly", async () => {
    const file = path.join(dir, "big-vocab.gguf");
    writeFileSync(
      file,
      buildGguf([
        ["general.architecture", { type: "str", v: "qwen3" }],
        ["qwen3.block_count", { type: "u32", v: 28 }],
        ["tokenizer.ggml.tokens", { type: "strs", v: Array.from({ length: 250_000 }, (_, i) => `token-${String(i)}`) }],
        ["tokenizer.ggml.merges", { type: "strs", v: Array.from({ length: 250_000 }, (_, i) => `m ${String(i)}`) }],
        ["tokenizer.chat_template", { type: "str", v: "{{ reasoning_effort }}" }],
      ]),
    );
    const started = Date.now();
    expect((await readGgufFacts(file)).chatTemplate).toBe("{{ reasoning_effort }}");
    expect(Date.now() - started).toBeLessThan(1000);
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

  describe("multi-token prediction head", () => {
    const tokens = Array.from({ length: 5000 }, (_, i) => `tok${String(i)}`);
    const tensorNames = (layer: number, nextn: boolean) => [
      "token_embd.weight",
      ...Array.from({ length: 200 }, (_, i) => `blk.${String(i % layer)}.attn_q.weight`),
      ...(nextn ? [`blk.${String(layer)}.nextn.eh_proj.weight`, `blk.${String(layer)}.nextn.enorm.weight`] : []),
      "output.weight",
    ];
    const model = (opts: { nextn?: number; tensors: boolean; shared?: boolean }) =>
      buildGguf(
        [
          ["general.architecture", { type: "str", v: "qwen35" }],
          ["qwen35.block_count", { type: "u32", v: 65 }],
          ...(opts.nextn !== undefined ? [["qwen35.nextn_predict_layers", { type: "u32", v: opts.nextn }] as [string, { type: "u32"; v: number }]] : []),
          ...(opts.shared ? [["qwen35.nextn_shared_target_tensors", { type: "bool", v: true }] as [string, { type: "bool"; v: boolean }]] : []),
          ["tokenizer.ggml.tokens", { type: "strs", v: tokens }],
          // The template comes before the tensor list: the reader must not
          // stop there when the file claims a head.
          ["tokenizer.chat_template", { type: "str", v: "{{ x }}" }],
          ["tokenizer.ggml.eos_token_id", { type: "u32", v: 1 }],
        ],
        0,
        tensorNames(64, opts.tensors),
      );

    it("finds an embedded head: the key and its nextn tensors (Qwen3.8-27B's layout)", async () => {
      const file = path.join(dir, "mtp.gguf");
      writeFileSync(file, model({ nextn: 1, tensors: true }));
      await expect(readGgufFacts(file)).resolves.toMatchObject({ chatTemplate: "{{ x }}", mtp: { layers: 1, sharedTarget: false } });
    });

    it("reports no head when the key survived but a quantizer dropped the tensors", async () => {
      const file = path.join(dir, "mtp-stripped.gguf");
      writeFileSync(file, model({ nextn: 1, tensors: false }));
      await expect(readGgufFacts(file)).resolves.toMatchObject({ mtp: null, nLayers: 65 });
    });

    it("reports no head without the key, even with nextn-looking tensors", async () => {
      const file = path.join(dir, "mtp-nokey.gguf");
      writeFileSync(file, model({ tensors: true }));
      await expect(readGgufFacts(file)).resolves.toMatchObject({ mtp: null });
    });

    it("marks a shared head, which borrows the main model's tensors", async () => {
      const file = path.join(dir, "mtp-shared.gguf");
      writeFileSync(file, model({ nextn: 1, tensors: true, shared: true }));
      await expect(readGgufFacts(file)).resolves.toMatchObject({ mtp: { layers: 1, sharedTarget: true } });
    });

    it("reads model keys written after the tokenizer's, the head and the layer count included", async () => {
      // GGUF does not fix key order. A file that puts its tokenizer between
      // the architecture and the rest of its model keys must not lose them —
      // and a lost head would stay lost, since the boot backfill skips a row
      // whose facts are stored, null included.
      const file = path.join(dir, "mtp-late-keys.gguf");
      writeFileSync(
        file,
        buildGguf(
          [
            ["general.architecture", { type: "str", v: "qwen35" }],
            ["tokenizer.ggml.tokens", { type: "strs", v: tokens }],
            ["tokenizer.chat_template", { type: "str", v: "{{ x }}" }],
            ["qwen35.block_count", { type: "u32", v: 65 }],
            ["qwen35.nextn_predict_layers", { type: "u32", v: 1 }],
          ],
          0,
          tensorNames(64, true),
        ),
      );
      await expect(readGgufFacts(file)).resolves.toMatchObject({ nLayers: 65, chatTemplate: "{{ x }}", mtp: { layers: 1, sharedTarget: false } });
    });

    it("keeps every other fact when the tensor list is malformed or claims too many tensors", async () => {
      const file = path.join(dir, "mtp-hostile.gguf");
      const good = model({ nextn: 1, tensors: true });
      // Tensor count is the u64 at offset 8: claim a billion.
      const bad = Buffer.from(good);
      bad.writeBigUInt64LE(1_000_000_000n, 8);
      writeFileSync(file, bad);
      const started = Date.now();
      await expect(readGgufFacts(file)).resolves.toMatchObject({ mtp: null, nLayers: 65, chatTemplate: "{{ x }}" });
      expect(Date.now() - started).toBeLessThan(1000);
    });
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
