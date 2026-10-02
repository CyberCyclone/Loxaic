import { describe, expect, it } from "vitest";
import { estimateFit } from "../fit.ts";
import { mtpCost, shapeCost, shapeFromKeys } from "../shape.ts";

/**
 * The figures below are llama.cpp b11149's own allocation log for real files,
 * loaded on Metal (`llama_kv_cache: size`, `llama_memory_recurrent: size`,
 * `sched_reserve: MTL0 compute buffer size`). The shape keys are those files'
 * GGUF headers, `<arch>.` prefix removed. If llama.cpp changes how it
 * allocates, re-measure rather than loosening the tolerances.
 */
const MiB = 1024 * 1024;

function shapeOf(keys: Parameters<typeof shapeFromKeys>[0]) {
  const shape = shapeFromKeys(keys);
  if (!shape) throw new Error("expected a shape");
  return shape;
}

const QWEN35_9B = {
  block_count: 32,
  context_length: 262144,
  embedding_length: 4096,
  "attention.head_count": 16,
  "attention.head_count_kv": 4,
  "attention.key_length": 256,
  "attention.value_length": 256,
  "ssm.conv_kernel": 4,
  "ssm.state_size": 128,
  "ssm.group_count": 16,
  "ssm.inner_size": 4096,
  full_attention_interval: 4,
};

/** Qwen3.5-0.8B (unsloth/Qwen3.5-0.8B-MTP-GGUF), whose file carries an MTP
 * head — measured on b11342. */
const QWEN35_08B = {
  block_count: 25,
  context_length: 262144,
  embedding_length: 1024,
  "attention.head_count": 8,
  "attention.head_count_kv": 2,
  "attention.key_length": 256,
  "attention.value_length": 256,
  "ssm.conv_kernel": 4,
  "ssm.state_size": 128,
  "ssm.group_count": 16,
  "ssm.inner_size": 2048,
  full_attention_interval: 4,
  nextn_predict_layers: 1,
};

/** The beta box's model: same layout, larger, plus a multi-token-prediction layer. */
const QWEN38_27B = {
  ...QWEN35_9B,
  block_count: 65,
  nextn_predict_layers: 1,
  embedding_length: 5120,
  "attention.head_count": 24,
  "ssm.inner_size": 6144,
};

const GEMMA4_E4B = {
  block_count: 42,
  context_length: 131072,
  embedding_length: 2560,
  "attention.head_count": 8,
  "attention.head_count_kv": 2,
  "attention.key_length": 512,
  "attention.value_length": 512,
  "attention.key_length_swa": 256,
  "attention.value_length_swa": 256,
  "attention.sliding_window": 512,
  "attention.shared_kv_layers": 18,
  "attention.sliding_window_pattern": Array.from({ length: 42 }, (_, i) => (i + 1) % 6 !== 0),
};

const defaults = { slots: 4, ubatch: 512, cacheTypeK: "f16", cacheTypeV: "f16", flashAttention: true };

function within(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(tolerance);
}

describe("model shape against llama.cpp's own allocations", () => {
  const qwen = shapeOf(QWEN35_9B);
  const gemma = shapeOf(GEMMA4_E4B);

  it("reads a hybrid model: KV in one layer of every four, recurrent state in the rest", () => {
    expect(qwen.fullAttentionInterval).toBe(4);
    // 16k, 64k, 256k and 512k all measured: 8 layers × 4 heads × 256, f16.
    for (const [ctx, mib] of [[16384, 512], [65536, 2048], [262144, 8192], [524288, 16384]] as const) {
      expect(shapeCost(qwen, { ...defaults, ctx }).kvBytes).toBe(mib * MiB);
    }
    // Recurrent state is per slot, whatever the context: 201 MiB at 4 slots, 50.25 at 1.
    within(shapeCost(qwen, { ...defaults, ctx: 65536 }).recurrentBytes, 201 * MiB, 0.01);
    within(shapeCost(qwen, { ...defaults, ctx: 262144, slots: 1 }).recurrentBytes, 50.25 * MiB, 0.01);
  });

  it("prices a quantized cache by its block size", () => {
    const q8 = shapeCost(qwen, { ...defaults, ctx: 262144, slots: 1, cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
    expect(q8.kvBytes).toBe(4352 * MiB);
  });

  it("grows the compute buffer with the context, and far faster without flash attention", () => {
    for (const [ctx, mib] of [[16384, 137.22], [65536, 377.27], [262144, 1337.45], [524288, 2617.7]] as const) {
      within(shapeCost(qwen, { ...defaults, ctx }).computeBytes, mib * MiB, 0.1);
    }
    within(shapeCost(qwen, { ...defaults, ctx: 65536, flashAttention: false }).computeBytes, 2212.01 * MiB, 0.1);
  });

  it("caps sliding-window layers and skips the layers that share a cache", () => {
    // 24 of 42 layers keep a cache: 4 full (2 heads × 512) and 20 sliding
    // (2 heads × 256, capped at 512 × 4 slots + 512 = 2,560 cells).
    for (const [ctx, mib] of [[8192, 128 + 100], [131072, 2048 + 100]] as const) {
      expect(shapeCost(gemma, { ...defaults, ctx }).kvBytes).toBe(mib * MiB);
    }
    within(shapeCost(gemma, { ...defaults, ctx: 131072 }).computeBytes, 718.27 * MiB, 0.1);
  });

  it("does not count a multi-token-prediction layer as part of the main cache", () => {
    const big = shapeOf(QWEN38_27B);
    expect(big.nLayers).toBe(64);
    // 16 attention layers × 4 × 256 × (2 + 2) bytes per token.
    expect(shapeCost(big, { ...defaults, ctx: 1_048_576 }).kvBytes).toBe(64 * 1024 * MiB);
  });

  it("puts a whole load within 10% of llama.cpp's own projection", () => {
    // `common_params_fit_impl: projected to use 14864 MiB` for the 5.97 GB file
    // at 256k, and 24336 MiB at 512k with YaRN.
    const weightBytes = 5_966_095_584;
    for (const [ctx, mib] of [[262144, 14864], [524288, 24336]] as const) {
      const fit = estimateFit({ weightBytes, shape: qwen, settings: { ctxSize: ctx }, memoryBytes: null, cpu: false });
      expect(fit.basis).toBe("shape");
      within(fit.requiredBytes, mib * MiB, 0.1);
    }
  });

  it("falls back to the rough figure, and says so, when the file described nothing", () => {
    expect(shapeFromKeys({ block_count: 28, context_length: 40960 })).toBeNull();
    const fit = estimateFit({ weightBytes: 1e9, nLayers: 28, settings: { ctxSize: 8192 }, memoryBytes: null, cpu: false });
    expect(fit.basis).toBe("rough");
  });

  it("reads a numeric sliding-window pattern as every Nth layer dense", () => {
    const shape = shapeOf({ ...GEMMA4_E4B, "attention.sliding_window_pattern": 6 });
    expect(shape.swaLayers?.slice(0, 6)).toEqual([true, true, true, true, true, false]);
  });

  it("treats a header with a zero or negative size as lacking the fact, not as a cheap model", () => {
    // These keys come from a file in a stranger's repository. A finite negative
    // would make the KV estimate negative, label an oversized stage "will fit"
    // and skip eviction for a load that then fails.
    for (const bad of [
      { "attention.key_length": -4096 },
      { "attention.key_length": 0 },
      { "attention.value_length": -1 },
      { block_count: -32 },
      { block_count: 0 },
      { "attention.head_count_kv": -4 },
      { "attention.head_count_kv": [4, -4, 4, -4] },
    ]) {
      const shape = shapeFromKeys({ ...QWEN35_9B, ...bad });
      // Either rejected outright (the rough estimate, which says so), or — for
      // a fact with a fallback — never a negative cost.
      if (shape) expect(shapeCost(shape, { ...defaults, ctx: 262144 }).kvBytes).toBeGreaterThanOrEqual(0);
      else expect(shape).toBeNull();
    }
    // A negative sliding window, key length or recurrent size is ignored rather than trusted.
    const swa = shapeOf({ ...GEMMA4_E4B, "attention.sliding_window": -512, "attention.key_length_swa": -256 });
    expect(swa.slidingWindow).toBeNull();
    expect(swa.keyLengthSwa).toBeNull();
    expect(shapeCost(swa, { ...defaults, ctx: 262144 }).kvBytes).toBeGreaterThan(0);
    const ssm = shapeOf({ ...QWEN35_9B, "ssm.state_size": -128 });
    expect(ssm.recurrentBytesPerSeq).toBeGreaterThanOrEqual(0);
    // A layer with no KV heads is real (a recurrent layer in a hybrid), so zero stays valid.
    expect(shapeFromKeys({ ...QWEN35_9B, "attention.head_count_kv": [4, 0, 4, 0], block_count: 4 })).not.toBeNull();
  });

  it("uses a per-layer KV head count when the file gives one", () => {
    const shape = shapeOf({ ...QWEN35_9B, full_attention_interval: undefined, "ssm.state_size": undefined, "attention.head_count_kv": [4, 0, 4, 0] , block_count: 4 });
    expect(shapeCost(shape, { ...defaults, ctx: 1024 }).kvBytes).toBe(1024 * 2 * 4 * 512 * 2);
  });

  it("prices multi-token prediction as llama.cpp b11342 allocates it", () => {
    // `--spec-type draft-mtp`, 32k cells: the draft context's
    // `llama_kv_cache: size = 64.00 MiB (32768 cells, 1 layers)` beside the
    // main 384 MiB (6 layers), a draft compute buffer equal to the main one,
    // and `llama_memory_recurrent` growing 19.27 → 57.80 MiB at n-max 2 (one
    // slot) and to 308.25 MiB at n-max 3 with four slots.
    const small = shapeOf(QWEN35_08B);
    const input = { ...defaults, ctx: 32768, slots: 1 };
    const main = shapeCost(small, input);
    expect(main.kvBytes).toBe(384 * MiB);
    within(main.recurrentBytes, 19.27 * MiB, 0.01);
    const extra = mtpCost(small, 1, 2, input);
    within(extra - main.computeBytes, 64 * MiB + (57.8 - 19.27) * MiB, 0.01);
    const four = { ...input, slots: 4, ctx: 32768 };
    within(mtpCost(small, 1, 3, four) - shapeCost(small, four).computeBytes - 64 * MiB, (308.25 - 77.06) * MiB, 0.01);
  });

  it("adds a separate head's weights and its draft context to the fit, and nothing when MTP is off", () => {
    const small = shapeOf(QWEN35_08B);
    const base = { weightBytes: 500 * MiB, shape: small, settings: { ctxSize: 32768, parallel: 1 }, memoryBytes: null, cpu: false };
    const off = estimateFit(base).requiredBytes;
    const on = estimateFit({ ...base, settings: { ...base.settings, mtp: true }, mtp: { layers: 1, headBytes: 100 * MiB } }).requiredBytes;
    const draftOnly = mtpCost(small, 1, 3, { ...defaults, ctx: 32768, slots: 1 });
    within(on - off, 100 * MiB + draftOnly, 0.001);
  });

  it("prices the draft cache in f16 even when the model's cache is q8_0 (Qwen3.8-27B on Pheonix, b11342)", () => {
    // Vulkan, 65,536 cells, q8_0: `llama_kv_cache: size = 2176.00 MiB (16
    // layers)` for the model and `256.00 MiB (1 layers) K (f16)` for the head;
    // recurrent 149.62 MiB → 448.88 at n-max 2 → 598.50 at n-max 3.
    const big = shapeOf(QWEN38_27B);
    const input = { ...defaults, ctx: 65536, slots: 1, cacheTypeK: "q8_0", cacheTypeV: "q8_0" };
    const main = shapeCost(big, input);
    expect(main.kvBytes).toBe(2176 * MiB);
    for (const [n, recurrent] of [[2, 448.88], [3, 598.5]] as const) {
      const extra = mtpCost(big, 1, n, input) - main.computeBytes;
      within(extra, 256 * MiB + (recurrent - 149.62) * MiB, 0.02);
    }
  });
});

