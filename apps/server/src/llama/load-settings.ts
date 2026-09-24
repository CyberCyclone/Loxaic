/**
 * The per-model load settings an admin can set — everything LM Studio offers
 * when loading a model — and the one place they become `llama-server`
 * arguments.
 *
 * They reach the router as keys in its preset INI file, and **an unknown or
 * malformed key there stops the router from starting at all** (measured against
 * b11149: `option 'mlock' not recognized in preset …`, fatal at boot, HTTP 500
 * on a live reload). So nothing an admin types reaches the file as a string:
 * every value is typed, range-checked, and rendered by this module from a
 * whitelist. The key names are llama.cpp's long flag names, checked against a
 * real router — `mlock`/`no-mmap` are *not* preset keys, `load-mode` is.
 */

export type LoadSettingGroup = "context" | "offload" | "performance" | "sampling" | "other";

interface Base {
  key: string;
  /** The preset key (llama.cpp's long flag name, no dashes). */
  flag: string;
  group: LoadSettingGroup;
  label: string;
  /** One line the settings sheet shows under the control. */
  help: string;
}

export interface IntSpec extends Base {
  type: "int";
  min: number;
  /** A fixed ceiling, or a model fact the ceiling comes from. */
  max: number | "nCtxTrain" | "nLayers";
  /** Values accepted besides numbers, e.g. `all` for GPU layers. */
  words?: readonly string[];
}

export interface FloatSpec extends Base {
  type: "float";
  min: number;
  max: number;
}

export interface BoolSpec extends Base {
  type: "bool";
}

export interface EnumSpec extends Base {
  type: "enum";
  values: readonly string[];
}

export type LoadSettingSpec = IntSpec | FloatSpec | BoolSpec | EnumSpec;

const CACHE_TYPES = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"] as const;

export const LOAD_SETTINGS: readonly LoadSettingSpec[] = [
  // ── Context
  {
    key: "ctxSize", flag: "ctx-size", group: "context", type: "int", min: 512, max: "nCtxTrain",
    label: "Context length",
    help: "How many tokens of conversation the model can see at once. Longer uses more memory.",
  },
  {
    key: "ropeFreqBase", flag: "rope-freq-base", group: "context", type: "float", min: 1, max: 1e9,
    label: "RoPE frequency base",
    help: "Stretches the model's positional encoding. Leave unset unless the model card says otherwise.",
  },
  {
    key: "ropeFreqScale", flag: "rope-freq-scale", group: "context", type: "float", min: 0.01, max: 10,
    label: "RoPE frequency scale",
    help: "Scales positions by 1/N to extend context. Leave unset unless the model card says otherwise.",
  },
  // ── Offload
  {
    key: "gpuLayers", flag: "n-gpu-layers", group: "offload", type: "int", min: 0, max: "nLayers",
    words: ["auto", "all"],
    label: "GPU offload",
    help: "How many of the model's layers run on the GPU. The rest run on the CPU, which is much slower.",
  },
  {
    key: "cpuMoeLayers", flag: "n-cpu-moe", group: "offload", type: "int", min: 0, max: "nLayers",
    label: "MoE experts kept on CPU",
    help: "For mixture-of-experts models: keep the expert weights of the first N layers in system memory to save VRAM.",
  },
  {
    key: "kvOffload", flag: "kv-offload", group: "offload", type: "bool",
    label: "Offload KV cache to GPU",
    help: "Keep the conversation's cache in VRAM. Faster; turn off to fit a longer context.",
  },
  {
    key: "loadMode", flag: "load-mode", group: "offload", type: "enum",
    values: ["auto", "mmap", "mlock", "mmap+mlock", "none"],
    label: "Memory mapping",
    help: "mmap loads faster and shares pages; mlock keeps the model in RAM instead of letting it be swapped out.",
  },
  // ── Performance
  {
    key: "threads", flag: "threads", group: "performance", type: "int", min: 1, max: 256,
    label: "CPU threads",
    help: "Threads used for generation on the CPU.",
  },
  {
    key: "threadsBatch", flag: "threads-batch", group: "performance", type: "int", min: 1, max: 256,
    label: "Batch threads",
    help: "Threads used while reading the prompt.",
  },
  {
    key: "batchSize", flag: "batch-size", group: "performance", type: "int", min: 32, max: 65536,
    label: "Evaluation batch size",
    help: "Tokens read per step while processing a prompt. Larger is faster and uses more memory.",
  },
  {
    key: "ubatchSize", flag: "ubatch-size", group: "performance", type: "int", min: 32, max: 65536,
    label: "Micro-batch size",
    help: "The physical batch the backend runs at once. Must not exceed the evaluation batch size.",
  },
  {
    key: "flashAttention", flag: "flash-attn", group: "performance", type: "enum", values: ["auto", "on", "off"],
    label: "Flash attention",
    help: "A faster, leaner attention kernel. Auto turns it on where the backend supports it.",
  },
  {
    key: "cacheTypeK", flag: "cache-type-k", group: "performance", type: "enum", values: CACHE_TYPES,
    label: "K cache type",
    help: "Precision of the attention keys cache. q8_0 roughly halves its memory with little quality loss.",
  },
  {
    key: "cacheTypeV", flag: "cache-type-v", group: "performance", type: "enum", values: CACHE_TYPES,
    label: "V cache type",
    help: "Precision of the attention values cache.",
  },
  {
    key: "parallel", flag: "parallel", group: "performance", type: "int", min: 1, max: 64,
    label: "Max concurrent predictions",
    help: "How many conversations the model serves at once. Each keeps its own cached prompt.",
  },
  {
    key: "kvUnified", flag: "kv-unified", group: "performance", type: "bool",
    label: "Unified KV cache",
    help: "Share one cache pool between concurrent predictions, so each can use the whole context length.",
  },
  // ── Sampling defaults
  {
    key: "temperature", flag: "temp", group: "sampling", type: "float", min: 0, max: 5,
    label: "Temperature",
    help: "Higher is more varied, lower is more predictable.",
  },
  {
    key: "topK", flag: "top-k", group: "sampling", type: "int", min: 0, max: 1000,
    label: "Top-k",
    help: "Only consider the k most likely next tokens. 0 turns it off.",
  },
  {
    key: "topP", flag: "top-p", group: "sampling", type: "float", min: 0, max: 1,
    label: "Top-p",
    help: "Only consider tokens within this cumulative probability. 1 turns it off.",
  },
  {
    key: "minP", flag: "min-p", group: "sampling", type: "float", min: 0, max: 1,
    label: "Min-p",
    help: "Drop tokens less likely than this fraction of the best one. 0 turns it off.",
  },
  {
    key: "repeatPenalty", flag: "repeat-penalty", group: "sampling", type: "float", min: 0, max: 5,
    label: "Repeat penalty",
    help: "Discourage repeating recent tokens. 1 turns it off.",
  },
  {
    key: "presencePenalty", flag: "presence-penalty", group: "sampling", type: "float", min: -2, max: 2,
    label: "Presence penalty",
    help: "Discourage tokens that have appeared at all.",
  },
  {
    key: "frequencyPenalty", flag: "frequency-penalty", group: "sampling", type: "float", min: -2, max: 2,
    label: "Frequency penalty",
    help: "Discourage tokens in proportion to how often they have appeared.",
  },
  // ── Other
  {
    key: "seed", flag: "seed", group: "other", type: "int", min: -1, max: 2 ** 31 - 1,
    label: "Seed",
    help: "Fix the random seed for reproducible output. -1 picks a new one each time.",
  },
  {
    key: "vision", flag: "mmproj", group: "other", type: "bool",
    label: "Vision",
    help: "Load the vision projector so the model can read images. Uses extra memory.",
  },
];

const BY_KEY = new Map(LOAD_SETTINGS.map((s) => [s.key, s]));

export type LoadSettingValue = number | string | boolean;
export type LoadSettings = Partial<Record<string, LoadSettingValue>>;

/** Facts about one model that bound its settings. */
export interface ModelFacts {
  nLayers?: number | null;
  nCtxTrain?: number | null;
}

export class LoadSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadSettingsError";
  }
}

function ceiling(spec: IntSpec, facts: ModelFacts): number {
  if (spec.max === "nCtxTrain") return facts.nCtxTrain ?? 1_048_576;
  // One more than the layer count: llama.cpp counts the output layer too, and
  // `n_layers + 1` is what "everything on the GPU" really is.
  if (spec.max === "nLayers") return facts.nLayers != null ? facts.nLayers + 1 : 1024;
  return spec.max;
}

/**
 * Validate an admin's settings. Unknown keys are refused, never dropped — a
 * client that believes it set something must be told it did not. `null` for a
 * key means "back to llama.cpp's default" and removes it.
 */
export function normalizeLoadSettings(raw: unknown, facts: ModelFacts = {}): LoadSettings {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new LoadSettingsError("Load settings must be an object");
  const out: LoadSettings = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = BY_KEY.get(key);
    if (!spec) throw new LoadSettingsError(`"${key}" is not a load setting`);
    if (value === null) continue;
    out[key] = checkValue(spec, value, facts);
  }
  if (typeof out.batchSize === "number" && typeof out.ubatchSize === "number" && out.ubatchSize > out.batchSize) {
    throw new LoadSettingsError("The micro-batch size cannot be larger than the evaluation batch size");
  }
  return out;
}

function checkValue(spec: LoadSettingSpec, value: unknown, facts: ModelFacts): LoadSettingValue {
  switch (spec.type) {
    case "bool":
      if (typeof value !== "boolean") throw new LoadSettingsError(`${spec.label} must be on or off`);
      return value;
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) {
        throw new LoadSettingsError(`${spec.label} must be one of ${spec.values.join(", ")}`);
      }
      return value;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max) {
        throw new LoadSettingsError(`${spec.label} must be a number from ${String(spec.min)} to ${String(spec.max)}`);
      }
      return value;
    case "int": {
      if (typeof value === "string" && spec.words?.includes(value)) return value;
      const max = ceiling(spec, facts);
      if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > max) {
        const words = spec.words ? ` (or ${spec.words.join("/")})` : "";
        throw new LoadSettingsError(`${spec.label} must be a whole number from ${String(spec.min)} to ${String(max)}${words}`);
      }
      return value;
    }
  }
}

/**
 * Render validated settings as preset lines, `flag = value`.
 *
 * `vision` is the one setting that is not a flag value: it decides whether the
 * `mmproj` path is written at all, so the caller passes the path in. Values are
 * re-validated here as well — the row is plain data, and an unknown key in the
 * preset would take the whole router down rather than one model.
 */
export function presetLines(settings: LoadSettings, opts: { mmprojPath: string | null; facts?: ModelFacts }): string[] {
  let valid: LoadSettings;
  try {
    valid = normalizeLoadSettings(settings, opts.facts);
  } catch {
    // A stored value that no longer validates (a model re-described with fewer
    // layers, a hand-edited row) must not reach the file. Falling back to the
    // defaults loads the model; refusing would take every model down with it.
    valid = {};
  }
  const lines: string[] = [];
  for (const spec of LOAD_SETTINGS) {
    const value = valid[spec.key];
    if (spec.key === "vision") continue;
    if (value === undefined) continue;
    lines.push(`${spec.flag} = ${String(value)}`);
  }
  // Vision defaults on when a projector was downloaded — that is why it was.
  if (opts.mmprojPath && valid.vision !== false) lines.push(`mmproj = ${opts.mmprojPath}`);
  return lines;
}

/**
 * The context window a single request actually gets.
 *
 * llama-server divides `ctx-size` between its slots unless the KV cache is
 * unified, so a 32k context with `parallel = 4` is four 8k conversations. The
 * context meter and auto-compaction must be told the per-request figure, or a
 * conversation is compacted after the backend has already truncated it.
 * `kvUnified` is llama.cpp's default whenever `parallel` is left unset.
 *
 * Only the *prediction* for a model that is not loaded yet: once it is, the
 * router's `/props?model=` reports `n_ctx` per slot already (measured: 8192
 * across 4 non-unified slots reads 2048), and that figure wins.
 */
export function perRequestWindow(settings: LoadSettings, loadedCtx: number): number {
  const parallel = typeof settings.parallel === "number" ? settings.parallel : null;
  const unified = typeof settings.kvUnified === "boolean" ? settings.kvUnified : parallel === null;
  if (unified || parallel === null || parallel <= 1) return loadedCtx;
  return Math.floor(loadedCtx / parallel);
}
