import type { LoadSettings } from "./load-settings.ts";
import type { MemoryBreakdown } from "./memory.ts";
import { CACHE_BYTES, DEFAULT_DRAFT_MAX, DEFAULT_SLOTS, DEFAULT_UBATCH, mtpCost, mtpKvBytes, shapeCost, type ModelShape } from "./shape.ts";

/**
 * Will a model fit? The label every screen shows beside a download, computed
 * here and only here so the search results, the quant list, the installed rows
 * and the settings sheet can never disagree.
 *
 * It is an estimate, and says so by construction: weights are exact (file
 * sizes); the KV cache, recurrent state and compute buffers come from the
 * model's attention layout (shape.ts, measured against llama.cpp's own
 * allocations) when the file described it, and from a rough per-layer figure
 * when it did not — `basis` says which. The thresholds are generous at the top and
 * honest at the bottom — "might fit" covers the band where llama.cpp's own
 * `--fit` (on by default) would shrink the context or leave a few layers on the
 * CPU to make it load. `unknown` when memory could not be measured, and never
 * reported as "will fit".
 */

export type FitLabel = "will-fit" | "might-fit" | "wont-fit" | "unknown";

export interface FitEstimate {
  label: FitLabel;
  /** What the model needs on the device(s), in bytes. */
  requiredBytes: number;
  /** What the device(s) have, or null when unknown. */
  availableBytes: number | null;
  /** Where the estimate is measured against. */
  target: "gpu" | "cpu";
  /** How `availableBytes` is made up on a GPU — free now, what our unpinned
   * models would give back, what pinned models and other programs hold. Absent
   * for the CPU and before a runtime has listed its devices. */
  breakdown?: MemoryBreakdown | null;
  /** `shape` when priced from the model's own attention layout, `rough` when
   * the file did not describe it (search results, older downloads). */
  basis?: "shape" | "rough";
}

export interface FitInput {
  /** Weights plus, when used, the vision projector. */
  weightBytes: number;
  nLayers?: number | null;
  /** The attention layout from the GGUF header, when known. */
  shape?: ModelShape | null;
  settings?: LoadSettings;
  /** Memory of the devices models are offloaded to, or of system RAM when the
   * backend is CPU. Null when unknown. */
  memoryBytes: number | null;
  cpu: boolean;
  /** The MTP head the load drafts with, when MTP is on and the model has
   * one: its layer count and, for a separate head file, that file's size (a
   * head inside the model's own file is already in `weightBytes`). */
  mtp?: { layers: number; headBytes: number } | null;
}

/** When no context length is set, llama.cpp's `--fit` shrinks the context down
 * to this before giving up (its `--fit-ctx` default), so it is the context a
 * default-settings model is judged at. */
const FIT_MIN_CTX = 4096;
/** A typical grouped-query KV width (8 heads × 128), for a model whose file
 * did not describe its attention. Wrong for some models in either direction;
 * right enough to tell 4k of context from 128k. */
const KV_DIM = 1024;
const DEFAULT_LAYERS = 32;

/** The rough KV figure, for a model with no known shape. */
export function kvCacheBytes(ctx: number, nLayers: number, settings: LoadSettings = {}): number {
  const k = CACHE_BYTES[String(settings.cacheTypeK ?? "f16")] ?? 2;
  const v = CACHE_BYTES[String(settings.cacheTypeV ?? "f16")] ?? 2;
  return ctx * nLayers * KV_DIM * (k + v);
}

export function estimateFit(input: FitInput): FitEstimate {
  const settings = input.settings ?? {};
  const nLayers = input.shape?.nLayers ?? input.nLayers ?? DEFAULT_LAYERS;
  const ctx = typeof settings.ctxSize === "number" ? settings.ctxSize : FIT_MIN_CTX;

  let contextBytes: number;
  let kv: number;
  let basis: "shape" | "rough";
  const mtp = input.mtp ?? null;
  const draftMax = typeof settings.mtpDraftMax === "number" ? settings.mtpDraftMax : DEFAULT_DRAFT_MAX;
  if (input.shape) {
    const costInput = {
      ctx,
      slots: typeof settings.parallel === "number" ? settings.parallel : DEFAULT_SLOTS,
      ubatch: typeof settings.ubatchSize === "number" ? settings.ubatchSize : DEFAULT_UBATCH,
      cacheTypeK: String(settings.cacheTypeK ?? "f16"),
      cacheTypeV: String(settings.cacheTypeV ?? "f16"),
      flashAttention: settings.flashAttention !== "off",
    };
    const cost = shapeCost(input.shape, costInput);
    kv = cost.kvBytes;
    contextBytes = cost.recurrentBytes + cost.computeBytes;
    if (mtp) {
      // The head's cache is a KV cache like the model's, and goes where the
      // model's does; the rest of its draft context stays on the GPU.
      const headKv = mtpKvBytes(input.shape, mtp.layers, ctx);
      kv += headKv;
      contextBytes += mtpCost(input.shape, mtp.layers, draftMax, costInput) - headKv;
    }
    basis = "shape";
  } else {
    kv = kvCacheBytes(ctx, nLayers, settings);
    // Compute buffers: a few hundred MB plus a slice proportional to the model.
    contextBytes = 300 * 1024 * 1024 + input.weightBytes * 0.05;
    if (mtp) {
      // The head's own cache and a second compute buffer, as roughly. The
      // cache is f16 whatever the model's is, as on the measured path.
      kv += kvCacheBytes(ctx, mtp.layers);
      contextBytes += 300 * 1024 * 1024;
    }
    basis = "rough";
  }
  // A separate head's weights go wherever the model's do.
  const headBytes = mtp?.headBytes ?? 0;

  let required: number;
  if (input.cpu) {
    required = input.weightBytes + headBytes + kv + contextBytes;
  } else {
    // A partial offload only needs its share of the weights on the GPU. The
    // KV cache follows it unless offloading the cache was switched off.
    const layers = settings.gpuLayers;
    const share = typeof layers === "number" ? Math.min(1, layers / (nLayers + 1)) : 1;
    const kvOnGpu = settings.kvOffload === false ? 0 : kv;
    required = (input.weightBytes + headBytes) * share + kvOnGpu + contextBytes;
  }
  required = Math.round(required);

  const target = input.cpu ? "cpu" : "gpu";
  if (input.memoryBytes === null || input.memoryBytes <= 0) {
    return { label: "unknown", requiredBytes: required, availableBytes: null, target, basis };
  }
  return { label: labelFor(required, input.memoryBytes), requiredBytes: required, availableBytes: input.memoryBytes, target, basis };
}

/** The label for needing `required` bytes out of `memory`. */
export function labelFor(required: number, memory: number | null): FitLabel {
  if (memory === null || memory <= 0) return "unknown";
  const ratio = required / memory;
  return ratio <= 0.85 ? "will-fit" : ratio <= 1.1 ? "might-fit" : "wont-fit";
}

const RANK: Record<FitLabel, number> = { "will-fit": 3, "might-fit": 2, unknown: 1, "wont-fit": 0 };

/** The best label among several quants — what a search result shows. */
export function bestFit(labels: FitLabel[]): FitLabel {
  return labels.reduce<FitLabel>((best, l) => (RANK[l] > RANK[best] ? l : best), labels.length ? "wont-fit" : "unknown");
}
