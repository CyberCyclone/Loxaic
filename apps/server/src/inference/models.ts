import { DEFAULT_PROVIDER_ID, formatModelRef, type ModelInfo } from "@loxaic/types";
import { selfHost } from "../cluster.ts";
import { redactSecrets } from "./provider-secrets.ts";
import {
  defaultProvider,
  getProviderById,
  listEnabledProviders,
  resolveModelRef,
  type ResolvedProvider,
} from "./providers.ts";

// Read at call time, not module load — see provider.ts.
const MOCK_MODE = () => process.env.MOCK_INFERENCE === "true";
/** A backend on this machine or this LAN answers in milliseconds or not at
 * all, and its list changes whenever someone loads a model. */
const LOCAL_TTL_MS = 5000;
/**
 * A hosted provider's list is a catalogue, not a machine state: OpenRouter's
 * 300-odd entries change a few times a week, and re-fetching them every five
 * seconds would spend a round trip per picker open for a list that is the same
 * every time.
 */
const REMOTE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 2000;
/** More patience for a provider across the internet than for one on the LAN,
 * and still far less than any request a person is waiting on. */
const REMOTE_FETCH_TIMEOUT_MS = 8000;

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
    provider_id: DEFAULT_PROVIDER_ID,
    provider_name: "Built-in",
    upstream_id: "llama-3.1-8b-instruct",
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
    provider_id: DEFAULT_PROVIDER_ID,
    provider_name: "Built-in",
    upstream_id: "qwen2.5-14b-instruct",
  },
];

/**
 * One cache entry per provider, keyed by provider id.
 *
 * Per provider rather than one list, because a fan-out is only as fast as its
 * slowest member: a single dead LAN provider would otherwise expire the whole
 * cache on its own schedule and put its timeout in front of every model lookup
 * the server makes.
 *
 * `inflight` is what makes a slow provider cost one request rather than one
 * per caller, and `at`/`models` are kept after expiry so a refresh can be
 * served stale — a picker opening while OpenRouter is slow shows the list it
 * showed a minute ago instead of an empty group.
 */
interface ProviderCacheEntry {
  at: number;
  models: ModelInfo[];
  inflight: Promise<ModelInfo[]> | null;
}

const caches = new Map<string, ProviderCacheEntry>();

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
  /** How many requests llama.cpp can hold prefixes for at once — its
   * `--parallel`. Absent on every other backend. */
  total_slots?: number;
}

/** A model entry from an OpenAI-compatible `/models`, plus the fields the
 * various backends add: `context_length` and `pricing` (OpenRouter),
 * `max_model_len` (vLLM), `max_input_tokens` (Anthropic), `meta.n_ctx_train`
 * (llama.cpp). OpenAI itself reports none of them, which is exactly why an
 * unknown window has to stay unknown rather than defaulting. */
interface OpenAiModel {
  id: string;
  name?: string;
  display_name?: string;
  meta?: { n_ctx_train?: number };
  context_length?: number;
  max_model_len?: number;
  max_input_tokens?: number;
  pricing?: { prompt?: string | number };
}

interface OpenAiModelsResponse {
  data?: OpenAiModel[];
}

function authHeaders(provider: ResolvedProvider): Record<string, string> {
  return {
    ...provider.headers,
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
  };
}

async function fetchJson<T>(url: string, provider: ResolvedProvider): Promise<T> {
  const controller = new AbortController();
  const timeout = provider.isDefault ? FETCH_TIMEOUT_MS : REMOTE_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => { controller.abort(); }, timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: authHeaders(provider),
      // A redirect would carry the Authorization header to wherever it points.
      redirect: "error",
    });
    if (!res.ok) throw new Error(`GET ${url} ${String(res.status)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** LM Studio's native REST API — richer than OpenAI's /v1/models (quant, context, load state). */
async function listViaLmStudioNative(provider: ResolvedProvider): Promise<ModelInfo[]> {
  const data = await fetchJson<LmStudioModelsResponse>(`${provider.nativeRoot}/api/v0/models`, provider);
  return (data.data ?? [])
    .filter((m) => m.type === "llm" || m.type === "vlm")
    .map((m): ModelInfo => {
      // `loaded_context_length` is only meaningful while the model is actually
      // loaded. `max_context_length` is what the model *could* do — reporting
      // that as the live window is how a 262,144 shows up next to an 8,192
      // reality, so the two are kept apart from here on.
      const loaded = m.state === "loaded" ? (m.loaded_context_length ?? null) : null;
      const max = m.max_context_length ?? m.loaded_context_length ?? 8192;
      return stamp(provider, {
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
        provider_id: provider.id,
        provider_name: provider.name,
        upstream_id: m.id,
      });
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
async function fetchLoadedCtx(provider: ResolvedProvider): Promise<number | null> {
  try {
    const props = await fetchJson<LlamaCppPropsResponse>(`${provider.nativeRoot}/props`, provider);
    const ctx = props.default_generation_settings?.n_ctx;
    return typeof ctx === "number" && ctx > 0 ? ctx : null;
  } catch {
    // Not llama.cpp, older build, or unreachable — degrade to the training bound.
    return null;
  }
}

/**
 * How many concurrent requests a backend can serve **without evicting each
 * other's cached prompt prefix**.
 *
 * Only llama.cpp answers this, via `/props`'s `total_slots` (its `--parallel`).
 * That number is exactly the right one: llama.cpp keeps one KV cache per slot
 * and picks a slot by longest common prefix, so N slots really do mean N
 * conversations can stay warm at once.
 *
 * Null means "the backend does not say", which the scheduler reads as one —
 * the truth for LM Studio, which exposes nothing about slots on any endpoint,
 * and for llama.cpp's own default. Never guessed upward: over-estimating
 * silently restores the prefix thrashing the queue exists to prevent.
 */
export async function probeTotalSlots(provider?: ResolvedProvider): Promise<number | null> {
  const target = provider ?? defaultProvider();
  // A hosted provider has no slots to report and would spend the whole probe
  // timeout returning a 404 page, once per probe window, forever.
  if (target.preset !== null) return null;
  try {
    const props = await fetchJson<LlamaCppPropsResponse>(`${target.nativeRoot}/props`, target);
    const slots = props.total_slots;
    return typeof slots === "number" && slots > 0 ? slots : null;
  } catch {
    return null;
  }
}

/** Set the fields every branch reports the same way: the reference clients
 * store and send, and which provider it came from. */
function stamp(provider: ResolvedProvider, model: ModelInfo): ModelInfo {
  return { ...model, id: formatModelRef(provider.slug, model.upstream_id) };
}

/** OpenRouter prices per *token* as a decimal string; the picker shows a price
 * per million, which is how every vendor quotes one. */
function parsePrice(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0;
}

/**
 * The OpenAI-compatible `/models` list — the only listing path a hosted
 * provider has, and the fallback for a local one that is not LM Studio.
 *
 * `loadedCtx` is llama.cpp's allocated window and applies to every entry,
 * since it serves one model; a hosted provider has none and every entry
 * carries its own.
 */
async function listViaOpenAiCompat(provider: ResolvedProvider): Promise<ModelInfo[]> {
  const [data, loadedCtx] = await Promise.all([
    fetchJson<OpenAiModelsResponse>(`${provider.apiBase}/models`, provider),
    provider.preset === null ? fetchLoadedCtx(provider) : Promise.resolve(null),
  ]);
  return (data.data ?? []).map((m): ModelInfo => {
    const declared = m.context_length ?? m.max_model_len ?? m.max_input_tokens ?? m.meta?.n_ctx_train ?? null;
    const known = loadedCtx ?? declared;
    return stamp(provider, {
      id: m.id,
      display_name: m.name ?? m.display_name ?? m.id,
      quant: "—",
      // "gguf" only when the backend actually identified itself as llama.cpp
      // by answering /props — which is what `loadedCtx` being non-null means.
      // Keying it on "has no preset" instead was a claim about the weights of
      // every hand-entered provider, and it put a GGUF badge on Claude and
      // GPT the first time a custom provider was pointed at a hosted API.
      format: loadedCtx != null ? "gguf" : "—",
      // Still a number for display, but `context_source: "default"` is what
      // callers key on — see `windowFor`, which refuses to hand a guess to the
      // auto-compaction threshold.
      context_tokens: known ?? 8192,
      max_context_tokens: declared ?? known ?? 8192,
      loaded_context_tokens: loadedCtx,
      context_source: loadedCtx != null ? "loaded" : declared != null ? "trained" : "default",
      location: provider.isDefault ? "server" : "remote",
      host_id: null,
      host_name: null,
      price: parsePrice(m.pricing?.prompt),
      // A hosted model is always ready. Reporting it as unloaded would emit
      // `model.loading` on every turn and re-resolve the window after each one,
      // describing a JIT load that does not exist.
      loaded: provider.isDefault ? loadedCtx != null : true,
      provider_id: provider.id,
      provider_name: provider.name,
      upstream_id: m.id,
    });
  });
}

/**
 * Entries built from the admin's allowlist, for a provider whose own listing
 * failed or has none.
 *
 * A non-null allowlist is a list of model ids an admin typed, so it can stand
 * in as the catalogue itself. That is what makes a provider usable when its
 * `/models` needs a different auth scheme than its completions endpoint —
 * which is the shape of every vendor that has ever diverged there.
 */
function listFromAllowlist(provider: ResolvedProvider): ModelInfo[] {
  return (provider.modelAllowlist ?? []).map((id) =>
    stamp(provider, {
      id,
      display_name: id,
      quant: "—",
      format: "—",
      context_tokens: 8192,
      max_context_tokens: 8192,
      loaded_context_tokens: null,
      context_source: "default",
      location: provider.isDefault ? "server" : "remote",
      host_id: null,
      host_name: null,
      price: 0,
      loaded: true,
      provider_id: provider.id,
      provider_name: provider.name,
      upstream_id: id,
    }),
  );
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Everything a provider lists, before the allowlist is applied. The admin
 * screen's allowlist editor needs the unfiltered set; everything else wants
 * `providerModels`. */
export async function listProviderModelsUnfiltered(provider: ResolvedProvider): Promise<ModelInfo[]> {
  if (provider.isDefault && MOCK_MODE()) return MOCK_MODELS;

  let models: ModelInfo[] = [];
  // The OpenAI-compatible endpoint's failure, deliberately, and never the
  // native probe's. The probe is opportunistic — a guess that this backend
  // might be LM Studio — and it fails on every backend that is not, at a path
  // the admin never entered. Reporting "GET …/api/v0/models 401" to someone
  // who configured `…/v1` sends them looking for a URL that is not theirs.
  let reportable: Error | null = null;
  // LM Studio's native API is richer, but only a local backend has one; asking
  // a hosted provider for it spends a full timeout on a 404 every refresh.
  if (provider.preset === null) {
    try {
      models = await listViaLmStudioNative(provider);
    } catch {
      // Not LM Studio, or it is down — the OpenAI-compatible path below is
      // what every backend has, and its answer is the one worth reporting.
    }
  }
  if (models.length === 0) {
    try {
      models = await listViaOpenAiCompat(provider);
    } catch (err) {
      reportable = asError(err);
    }
  }
  if (models.length === 0 && provider.modelAllowlist) return listFromAllowlist(provider);
  if (models.length === 0 && reportable) throw reportable;
  return models;
}

async function fetchProviderModels(provider: ResolvedProvider): Promise<ModelInfo[]> {
  let models = await listProviderModelsUnfiltered(provider);
  if (provider.modelAllowlist) {
    const allowed = new Set(provider.modelAllowlist);
    models = models.filter((m) => allowed.has(m.upstream_id));
  }
  if (provider.isDefault) {
    // Stamp the built-in backend's models with the host serving them. A
    // property of *this instance*, so it is meaningless for a provider reached
    // over the internet — which is what `provider_name` is for there.
    const host = await selfHost().catch(() => null);
    if (host) models = models.map((m) => ({ ...m, host_id: host.id, host_name: host.name }));
  }
  return models;
}

/**
 * One provider's models, cached.
 *
 * Never throws: a provider that cannot be reached contributes nothing and the
 * others still list. An empty result is cached like any other so an unreachable
 * backend is asked once per window rather than once per caller.
 */
async function providerModels(provider: ResolvedProvider): Promise<ModelInfo[]> {
  const ttl = provider.isDefault || provider.preset === null ? LOCAL_TTL_MS : REMOTE_TTL_MS;
  const entry = caches.get(provider.id);
  if (entry && Date.now() - entry.at < ttl) return entry.models;
  if (entry?.inflight) return entry.inflight;

  const inflight = fetchProviderModels(provider)
    .then((models) => {
      caches.set(provider.id, { at: Date.now(), models, inflight: null });
      return models;
    })
    .catch(() => {
      // Keep whatever was last known and re-arm the window: a provider that
      // has gone away should not blank a list the user is looking at, and a
      // failure must not cost a request per caller until it recovers.
      const stale = caches.get(provider.id)?.models ?? [];
      caches.set(provider.id, { at: Date.now(), models: stale, inflight: null });
      return stale;
    });
  caches.set(provider.id, { at: entry?.at ?? 0, models: entry?.models ?? [], inflight });
  return inflight;
}

/**
 * The context window to use for a model, or null when it is genuinely unknown.
 *
 * Null rather than the 8192 in `context_tokens`, because the caller is the
 * auto-compaction threshold: OpenAI's `/models` reports no context length at
 * all, so a default would have every GPT conversation compacting at about 7k
 * tokens — a billed model call and a full prompt re-evaluation, over and over,
 * on a model whose real window is twenty times that. "An unknown window
 * disables it" is the existing rule; this keeps it true for models whose
 * window we cannot ask for.
 */
function windowFor(model: ModelInfo | null): number | null {
  if (!model) return null;
  if (model.loaded_context_tokens != null) return model.loaded_context_tokens;
  return model.context_source === "default" ? null : model.context_tokens;
}

/**
 * One model, from its own provider only.
 *
 * The run path uses this rather than searching `listBackendModels()`: that
 * fans out, so a single unreachable LAN provider would add its whole timeout
 * to every tool iteration of an unrelated run — while that run holds an
 * inference slot that may be the entire deployment.
 */
export async function getModelInfo(ref: string): Promise<ModelInfo | null> {
  let provider: ResolvedProvider;
  try {
    ({ provider } = await resolveModelRef(ref));
  } catch {
    // An unusable reference has no model info. The run starters refuse it by
    // name; here it is simply unknown, which callers already handle.
    return null;
  }
  const models = await providerModels(provider);
  return models.find((m) => m.id === ref) ?? null;
}

/** The window in force for a model right now, or null if unknown.
 *
 * Worth calling twice around a run: before generating it may report the
 * model's *max* (nothing is loaded yet, so there's no allocated window to
 * report), and only once the backend has finished a JIT load does the real
 * figure exist. A 27B declaring 262,144 but loaded at 8,192 is the normal
 * case, not an edge one. */
export async function resolveWindow(ref: string): Promise<number | null> {
  return windowFor(await getModelInfo(ref));
}

/** The window plus whether the model is loaded, in one lookup — what the run
 * path needs before its first request. */
export async function modelRunInfo(ref: string): Promise<{ windowTokens: number | null; loaded: boolean } | null> {
  const model = await getModelInfo(ref);
  if (!model) return null;
  return { windowTokens: windowFor(model), loaded: model.loaded };
}

/**
 * Drop cached models. With no argument, every provider — which is what a
 * provider write means, since a rename changes the `provider_name` on every
 * entry. With one, just that provider: a JIT load on the built-in backend
 * changes its own windows and says nothing about OpenRouter's catalogue.
 */
export function invalidateBackendModels(providerId?: string): void {
  if (providerId === undefined) caches.clear();
  else caches.delete(providerId);
}

/**
 * Every model this deployment can serve, built-in backend first.
 *
 * The only fan-out. Providers are asked in parallel and a failure contributes
 * an empty list rather than failing the call, so one dead backend cannot take
 * the picker down for the others.
 */
export async function listBackendModels(): Promise<ModelInfo[]> {
  const providers = await listEnabledProviders();
  const lists = await Promise.all(providers.map((p) => providerModels(p)));
  return lists.flat();
}

/** A provider's live model list for the admin screen, unfiltered and
 * uncached — an admin pressing Test or opening the allowlist editor is asking
 * about the provider *now*, not about what it said five minutes ago.
 * Credentials are scrubbed from the error, which is shown to the admin and
 * stored on the row. */
export async function probeProviderModels(providerId: string): Promise<ModelInfo[]> {
  const provider = await getProviderById(providerId);
  if (!provider) throw new Error("Provider not found");
  try {
    return await listProviderModelsUnfiltered(provider);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(text, [provider.apiKey, ...Object.values(provider.headers)]));
  }
}

/** Test seam: caches are process-global and vitest shares one process. */
export function __resetModelCachesForTest(): void {
  caches.clear();
}
