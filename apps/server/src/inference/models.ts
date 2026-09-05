import type { ModelInfo } from "@loxaic/types";
import { selfHost } from "../cluster.ts";

// Read at call time, not module load — see provider.ts.
const BASE_URL = () => process.env.INFERENCE_BASE_URL ?? "http://localhost:4002";
const MOCK_MODE = () => process.env.MOCK_INFERENCE === "true";
const TTL_MS = 5000;
const FETCH_TIMEOUT_MS = 2000;

const MOCK_MODELS: ModelInfo[] = [
  {
    id: "llama-3.1-8b-instruct",
    display_name: "llama-3.1-8b-instruct",
    quant: "Q4_K_M",
    format: "gguf",
    // Deliberately loaded far below its max, so the "loaded ≪ max" UI path and
    // the over-100% ring are both reachable without a real GGUF.
    context_tokens: 4096,
    max_context_tokens: 131072,
    loaded_context_tokens: 4096,
    context_source: "loaded",
    location: "server",
    host_id: null,
    host_name: null,
    price: 0,
    loaded: true,
  },
  {
    id: "qwen2.5-14b-instruct",
    display_name: "qwen2.5-14b-instruct",
    quant: "Q5_K_M",
    format: "mlx",
    context_tokens: 32768,
    max_context_tokens: 32768,
    loaded_context_tokens: null,
    context_source: "max",
    location: "server",
    host_id: null,
    host_name: null,
    price: 0,
    loaded: false,
  },
];

let cache: { at: number; models: ModelInfo[] } | null = null;

/** A model entry from LM Studio's native `/api/v0/models`. */
interface LmStudioModel {
  id: string;
  type?: string;
  state?: string;
  loaded_context_length?: number;
  max_context_length?: number;
  quantization?: string;
  compatibility_type?: string;
}

interface LmStudioModelsResponse {
  data?: LmStudioModel[];
}

interface LlamaCppPropsResponse {
  default_generation_settings?: { n_ctx?: number };
}

/** A model entry from the OpenAI-compatible `/v1/models`. */
interface OpenAiModel {
  id: string;
  meta?: { n_ctx_train?: number };
}

interface OpenAiModelsResponse {
  data?: OpenAiModel[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${url} ${String(res.status)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** LM Studio's native REST API — richer than OpenAI's /v1/models (quant, context, load state). */
async function listViaLmStudioNative(): Promise<ModelInfo[]> {
  const data = await fetchJson<LmStudioModelsResponse>(`${BASE_URL()}/api/v0/models`);
  return (data.data ?? [])
    .filter((m) => m.type === "llm" || m.type === "vlm")
    .map((m): ModelInfo => {
      // `loaded_context_length` is only meaningful while the model is actually
      // loaded. `max_context_length` is what the model *could* do — reporting
      // that as the live window is how a 262,144 shows up next to an 8,192
      // reality, so the two are kept apart from here on.
      const loaded = m.state === "loaded" ? (m.loaded_context_length ?? null) : null;
      const max = m.max_context_length ?? m.loaded_context_length ?? 8192;
      return {
        id: m.id,
        display_name: m.id,
        quant: m.quantization ?? "—",
        format: typeof m.compatibility_type === "string" ? m.compatibility_type : "—",
        context_tokens: loaded ?? max,
        max_context_tokens: max,
        loaded_context_tokens: loaded,
        context_source: loaded != null ? "loaded" : m.max_context_length ? "max" : "default",
        location: "server",
        host_id: null,
        host_name: null,
        price: 0,
        loaded: m.state === "loaded",
      };
    });
}

/**
 * llama.cpp's actual loaded context. `n_ctx_train` on /v1/models is the
 * model's *training* context — an upper bound that says nothing about the
 * `-c` the server was launched with, so using it as a denominator just
 * relocates the bug this whole change exists to fix. /props reports what was
 * really allocated, and llama.cpp serves exactly one model, so it applies to
 * every entry in the list.
 */
async function fetchLoadedCtx(): Promise<number | null> {
  try {
    const props = await fetchJson<LlamaCppPropsResponse>(`${BASE_URL()}/props`);
    const ctx = props.default_generation_settings?.n_ctx;
    return typeof ctx === "number" && ctx > 0 ? ctx : null;
  } catch {
    // Not llama.cpp, older build, or unreachable — degrade to the training bound.
    return null;
  }
}

/** OpenAI-compatible fallback (llama.cpp and others) — no load-state or quant info. */
async function listViaOpenAiCompat(): Promise<ModelInfo[]> {
  const [data, loadedCtx] = await Promise.all([
    fetchJson<OpenAiModelsResponse>(`${BASE_URL()}/v1/models`),
    fetchLoadedCtx(),
  ]);
  return (data.data ?? []).map((m): ModelInfo => {
    const trained = m.meta?.n_ctx_train ?? null;
    const max = trained ?? loadedCtx ?? 8192;
    return {
      id: m.id,
      display_name: m.id,
      quant: "—",
      // This path only runs for llama.cpp (or compatible servers), which only
      // ever serves GGUF — unlike LM Studio's native API, there's no field for
      // it, but the runtime itself tells us.
      format: "gguf",
      context_tokens: loadedCtx ?? max,
      max_context_tokens: max,
      loaded_context_tokens: loadedCtx,
      context_source: loadedCtx != null ? "loaded" : trained != null ? "trained" : "default",
      location: "server",
      host_id: null,
      host_name: null,
      price: 0,
      loaded: loadedCtx != null,
    };
  });
}

/**
 * The context window in force for a model right now, or null if unknown.
 *
 * Worth calling twice around a run: before generating it may report the
 * model's *max* (nothing is loaded yet, so there's no allocated window to
 * report), and only once the backend has finished a JIT load does the real
 * figure exist. A 27B declaring 262,144 but loaded at 8,192 is the normal
 * case, not an edge one.
 */
export async function resolveWindow(model: string): Promise<number | null> {
  const found = (await listBackendModels()).find((m) => m.id === model);
  return found?.loaded_context_tokens ?? found?.context_tokens ?? null;
}

/** Drop the cached list. Called after a run that JIT-loaded a model, so the
 * client's post-stream refresh can't be served a snapshot taken before the
 * load — which is exactly when the context window changes. */
export function invalidateBackendModels(): void {
  cache = null;
}

export async function listBackendModels(): Promise<ModelInfo[]> {
  if (MOCK_MODE()) return MOCK_MODELS;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;

  let models: ModelInfo[] = [];
  try {
    models = await listViaLmStudioNative();
  } catch {
    // Not LM Studio (or it's down) — fall through to the OpenAI-compatible path.
  }
  if (models.length === 0) {
    try {
      models = await listViaOpenAiCompat();
    } catch {
      // Backend unreachable — cache the empty result so we don't hammer it.
    }
  }

  // Stamp every model with the host serving it. Done once here rather than in
  // each backend branch: the label is a property of *this instance*, not of
  // how its backend happens to report models.
  const host = await selfHost().catch(() => null);
  if (host) models = models.map((m) => ({ ...m, host_id: host.id, host_name: host.name }));

  cache = { at: Date.now(), models };
  return models;
}
