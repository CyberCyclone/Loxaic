/**
 * A model's attention layout, read from its GGUF header, and what that layout
 * costs in memory at a given context — the part of the fit estimate that grows
 * with the context, and so the part a YaRN stage is judged on.
 *
 * Every rule here was measured against llama.cpp b11149's own allocation log
 * (`llama_kv_cache: size = …`, `llama_memory_recurrent: …`, `sched_reserve: …
 * compute buffer size`) on real files, not derived from papers:
 *
 * - **Only some layers keep a KV cache.** A hybrid model (Qwen3.5+, `ssm.*`
 *   keys and `full_attention_interval = 4`) keeps one in every fourth layer; the
 *   rest hold a fixed recurrent state instead. A model with
 *   `attention.shared_kv_layers` (Gemma 4) lets its last N layers reuse
 *   earlier caches. Multi-token-prediction layers (`nextn_predict_layers`) are
 *   not part of the main cache. Counting every layer, as the old estimate did,
 *   put Qwen3.5-9B's 64k cache at 8 GiB; llama.cpp allocates 2 GiB.
 * - **A sliding-window layer's cache stops growing** at `n_swa × slots +
 *   ubatch` cells (Gemma 4 E4B: 2,560 cells whatever the context).
 * - **The KV cache is `ctx` cells in total**, unified or not — `parallel`
 *   divides it between slots, it does not multiply it. The recurrent state is
 *   per slot.
 * - **The compute buffer grows with the context too**: about 5 KiB a token with
 *   flash attention (both models measured, to within 1%), and `heads × ubatch
 *   × 4` bytes a token without it. At 1M that is 5 GiB, not a rounding error.
 */

export interface ModelShape {
  /** Layers in the main model (block_count minus multi-token-prediction ones). */
  nLayers: number;
  nHead: number | null;
  /** KV heads, per layer when the file gives an array. */
  nHeadKv: number | number[];
  keyLength: number;
  valueLength: number;
  keyLengthSwa: number | null;
  valueLengthSwa: number | null;
  /** The sliding window, 0/null for none. */
  slidingWindow: number | null;
  /** Per layer: true = sliding-window. Null when the model has no SWA layers
   * or the file does not say which they are. */
  swaLayers: boolean[] | null;
  /** The last N layers reuse earlier caches and hold none of their own. */
  sharedKvLayers: number;
  /** Every Nth layer is full attention and the rest are recurrent (hybrid). */
  fullAttentionInterval: number | null;
  /** The recurrent layers' state, per slot, in bytes. 0 for a plain transformer. */
  recurrentBytesPerSeq: number;
  /** What the file says about its own rope scaling, when it says anything. */
  ropeScaling: { type: string | null; factor: number | null; originalContext: number | null } | null;
}

export const CACHE_BYTES: Partial<Record<string, number>> = {
  f32: 4, f16: 2, bf16: 2, q8_0: 1.0625, q5_1: 0.75, q5_0: 0.6875, q4_1: 0.625, q4_0: 0.5625, iq4_nl: 0.5625,
};

/** llama-server's slot count when `parallel` is not set (measured: 4). */
export const DEFAULT_SLOTS = 4;
/** llama.cpp's default physical batch. */
export const DEFAULT_UBATCH = 512;
/** Measured compute buffer per token of context with flash attention, at the
 * default micro-batch. Scales with the micro-batch. */
const FA_COMPUTE_BYTES_PER_TOKEN = 5120;
/** The part of the compute buffer that does not depend on the context
 * (measured 57 MiB for Qwen3.5-9B, 78 MiB for Gemma 4 E4B). */
const COMPUTE_BASE_BYTES = 64 * 1024 * 1024;

type Scalars = Partial<Record<string, number | boolean | string | number[] | boolean[]>>;

function isNumbers(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number");
}

function isBooleans(v: unknown): v is boolean[] {
  return Array.isArray(v) && v.every((x) => typeof x === "boolean");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build the shape from a GGUF header's `<arch>.*` keys (arch prefix removed).
 * Null when the file lacks the attention facts the estimate needs — the
 * caller then falls back to the rough estimate and says so.
 */
export function shapeFromKeys(k: Scalars): ModelShape | null {
  const blocks = num(k.block_count);
  const headKvRaw = k["attention.head_count_kv"];
  const nHeadKv = isNumbers(headKvRaw) ? headKvRaw : num(headKvRaw);
  const nHead = num(k["attention.head_count"]);
  const embd = num(k.embedding_length);
  const keyLength = num(k["attention.key_length"]) ?? (embd && nHead ? embd / nHead : null);
  const valueLength = num(k["attention.value_length"]) ?? keyLength;
  if (blocks === null || nHeadKv === null || keyLength === null || valueLength === null) return null;

  const nextn = num(k.nextn_predict_layers) ?? 0;
  const nLayers = Math.max(1, blocks - nextn);
  const slidingWindow = num(k["attention.sliding_window"]);

  let swaLayers: boolean[] | null = null;
  const pattern = k["attention.sliding_window_pattern"];
  const every = num(pattern);
  if (isBooleans(pattern)) {
    swaLayers = pattern;
  } else if (every && slidingWindow) {
    // A number N: every Nth layer is dense, the rest slide (llama.cpp's
    // set_swa_pattern).
    swaLayers = Array.from({ length: nLayers }, (_, i) => (i + 1) % every !== 0);
  }
  if (!slidingWindow) swaLayers = null;

  const interval = num(k.full_attention_interval);
  const stateSize = num(k["ssm.state_size"]);
  const innerSize = num(k["ssm.inner_size"]);
  const conv = num(k["ssm.conv_kernel"]);
  const groups = num(k["ssm.group_count"]) ?? 1;
  let recurrentBytesPerSeq = 0;
  if (stateSize && innerSize) {
    const recurrentLayers = interval ? nLayers - Math.floor(nLayers / interval) : nLayers;
    // S: state × inner, R: the conv window over inner plus B and C; f32 each.
    const perLayer = stateSize * innerSize * 4 + (conv ? (conv - 1) * (innerSize + 2 * groups * stateSize) * 4 : 0);
    recurrentBytesPerSeq = recurrentLayers * perLayer;
  }

  const rawType = k["rope.scaling.type"];
  const scalingType = typeof rawType === "string" ? rawType : null;
  const factor = num(k["rope.scaling.factor"]);
  const original = num(k["rope.scaling.original_context_length"]);
  return {
    nLayers,
    nHead,
    nHeadKv,
    keyLength,
    valueLength,
    keyLengthSwa: num(k["attention.key_length_swa"]),
    valueLengthSwa: num(k["attention.value_length_swa"]),
    slidingWindow,
    swaLayers,
    sharedKvLayers: num(k["attention.shared_kv_layers"]) ?? 0,
    fullAttentionInterval: interval,
    recurrentBytesPerSeq,
    ropeScaling: scalingType || factor || original ? { type: scalingType, factor, originalContext: original } : null,
  };
}

export interface ShapeCostInput {
  ctx: number;
  slots: number;
  ubatch: number;
  cacheTypeK: string;
  cacheTypeV: string;
  flashAttention: boolean;
}

export interface ShapeCost {
  kvBytes: number;
  recurrentBytes: number;
  computeBytes: number;
}

/** What the context-dependent parts of a load cost for a model of this shape. */
export function shapeCost(shape: ModelShape, input: ShapeCostInput): ShapeCost {
  const k = CACHE_BYTES[input.cacheTypeK] ?? 2;
  const v = CACHE_BYTES[input.cacheTypeV] ?? 2;
  const kvLayers = Math.max(0, shape.nLayers - shape.sharedKvLayers);
  const swaCells = shape.slidingWindow ? Math.min(input.ctx, shape.slidingWindow * input.slots + input.ubatch) : input.ctx;
  let kvBytes = 0;
  for (let i = 0; i < kvLayers; i++) {
    // A hybrid model's non-attention layers are recurrent: no KV.
    if (shape.fullAttentionInterval && (i + 1) % shape.fullAttentionInterval !== 0) continue;
    const heads = Array.isArray(shape.nHeadKv) ? (shape.nHeadKv[i] ?? 0) : shape.nHeadKv;
    const swa = shape.swaLayers?.[i] === true;
    const kLen = swa ? (shape.keyLengthSwa ?? shape.keyLength) : shape.keyLength;
    const vLen = swa ? (shape.valueLengthSwa ?? shape.valueLength) : shape.valueLength;
    const cells = swa ? swaCells : input.ctx;
    kvBytes += cells * heads * (kLen * k + vLen * v);
  }
  const perToken = input.flashAttention
    ? FA_COMPUTE_BYTES_PER_TOKEN * (input.ubatch / DEFAULT_UBATCH)
    : (shape.nHead ?? 32) * input.ubatch * 4 + FA_COMPUTE_BYTES_PER_TOKEN * (input.ubatch / DEFAULT_UBATCH);
  return {
    kvBytes: Math.round(kvBytes),
    recurrentBytes: shape.recurrentBytesPerSeq * input.slots,
    computeBytes: Math.round(COMPUTE_BASE_BYTES + perToken * input.ctx),
  };
}
