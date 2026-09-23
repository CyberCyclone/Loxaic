import type { LoadSettings } from "./load-settings.ts";

/**
 * Will a model fit? The label every screen shows beside a download, computed
 * here and only here so the search results, the quant list, the installed rows
 * and the settings sheet can never disagree.
 *
 * It is an estimate, and says so by construction: weights are exact (file
 * sizes), the KV cache and compute buffers are approximated from the model's
 * layer count and the context. The thresholds are generous at the top and
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
}

export interface FitInput {
  /** Weights plus, when used, the vision projector. */
  weightBytes: number;
  nLayers?: number | null;
  settings?: LoadSettings;
  /** Memory of the devices models are offloaded to, or of system RAM when the
   * backend is CPU. Null when unknown. */
  memoryBytes: number | null;
  cpu: boolean;
}

/** When no context length is set, llama.cpp's `--fit` shrinks the context down
 * to this before giving up (its `--fit-ctx` default), so it is the context a
 * default-settings model is judged at. */
const FIT_MIN_CTX = 4096;
/** A typical grouped-query KV width (8 heads × 128). Wrong for some models in
 * either direction; right enough to tell 4k of context from 128k. */
const KV_DIM = 1024;
const DEFAULT_LAYERS = 32;

const CACHE_BYTES: Partial<Record<string, number>> = {
  f32: 4, f16: 2, bf16: 2, q8_0: 1.0625, q5_1: 0.75, q5_0: 0.6875, q4_1: 0.625, q4_0: 0.5625, iq4_nl: 0.5625,
};

export function kvCacheBytes(ctx: number, nLayers: number, settings: LoadSettings = {}): number {
  const k = CACHE_BYTES[String(settings.cacheTypeK ?? "f16")] ?? 2;
  const v = CACHE_BYTES[String(settings.cacheTypeV ?? "f16")] ?? 2;
  return ctx * nLayers * KV_DIM * (k + v);
}

export function estimateFit(input: FitInput): FitEstimate {
  const settings = input.settings ?? {};
  const nLayers = input.nLayers ?? DEFAULT_LAYERS;
  const ctx = typeof settings.ctxSize === "number" ? settings.ctxSize : FIT_MIN_CTX;
  const kv = kvCacheBytes(ctx, nLayers, settings);
  // Compute buffers: a few hundred MB plus a slice proportional to the model.
  const overhead = 300 * 1024 * 1024 + input.weightBytes * 0.05;

  let required: number;
  if (input.cpu) {
    required = input.weightBytes + kv + overhead;
  } else {
    // A partial offload only needs its share of the weights on the GPU. The
    // KV cache follows it unless offloading the cache was switched off.
    const layers = settings.gpuLayers;
    const share = typeof layers === "number" ? Math.min(1, layers / (nLayers + 1)) : 1;
    const kvOnGpu = settings.kvOffload === false ? 0 : kv;
    required = input.weightBytes * share + kvOnGpu + overhead;
  }
  required = Math.round(required);

  const target = input.cpu ? "cpu" : "gpu";
  if (input.memoryBytes === null || input.memoryBytes <= 0) {
    return { label: "unknown", requiredBytes: required, availableBytes: null, target };
  }
  const ratio = required / input.memoryBytes;
  const label: FitLabel = ratio <= 0.85 ? "will-fit" : ratio <= 1.1 ? "might-fit" : "wont-fit";
  return { label, requiredBytes: required, availableBytes: input.memoryBytes, target };
}

const RANK: Record<FitLabel, number> = { "will-fit": 3, "might-fit": 2, unknown: 1, "wont-fit": 0 };

/** The best label among several quants — what a search result shows. */
export function bestFit(labels: FitLabel[]): FitLabel {
  return labels.reduce<FitLabel>((best, l) => (RANK[l] > RANK[best] ? l : best), labels.length ? "wont-fit" : "unknown");
}
