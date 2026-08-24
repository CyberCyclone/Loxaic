import type { ModelInfo } from "@shannon/types";

const BASE_URL = process.env.INFERENCE_BASE_URL || "http://localhost:4002";
const MOCK_MODE = process.env.MOCK_INFERENCE === "true";
const TTL_MS = 5000;
const FETCH_TIMEOUT_MS = 2000;

const MOCK_MODELS: ModelInfo[] = [
  {
    id: "llama-3.1-8b-instruct",
    display_name: "llama-3.1-8b-instruct",
    quant: "Q4_K_M",
    context_tokens: 32768,
    location: "server",
    price: 0,
    loaded: true,
  },
  {
    id: "qwen2.5-14b-instruct",
    display_name: "qwen2.5-14b-instruct",
    quant: "Q5_K_M",
    context_tokens: 32768,
    location: "server",
    price: 0,
    loaded: false,
  },
];

let cache: { at: number; models: ModelInfo[] } | null = null;

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${url} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** LM Studio's native REST API — richer than OpenAI's /v1/models (quant, context, load state). */
async function listViaLmStudioNative(): Promise<ModelInfo[]> {
  const data = await fetchJson(`${BASE_URL}/api/v0/models`);
  return (data.data ?? [])
    .filter((m: any) => m.type === "llm" || m.type === "vlm")
    .map((m: any): ModelInfo => ({
      id: m.id,
      display_name: m.id,
      quant: m.quantization || "—",
      context_tokens: m.loaded_context_length ?? m.max_context_length ?? 8192,
      location: "server",
      price: 0,
      loaded: m.state === "loaded",
    }));
}

/** OpenAI-compatible fallback (llama.cpp and others) — no load-state or quant info. */
async function listViaOpenAiCompat(): Promise<ModelInfo[]> {
  const data = await fetchJson(`${BASE_URL}/v1/models`);
  return (data.data ?? []).map((m: any): ModelInfo => ({
    id: m.id,
    display_name: m.id,
    quant: "—",
    context_tokens: m.meta?.n_ctx_train ?? 8192,
    location: "server",
    price: 0,
    loaded: false,
  }));
}

export async function listBackendModels(): Promise<ModelInfo[]> {
  if (MOCK_MODE) return MOCK_MODELS;
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

  cache = { at: Date.now(), models };
  return models;
}
