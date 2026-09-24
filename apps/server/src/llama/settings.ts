import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import { decryptApiKey, encryptApiKey } from "../inference/provider-secrets.ts";

/**
 * Deployment-wide settings for the managed llama.cpp runtime.
 *
 * Same precedence as every other settings group — **env > `server_settings`
 * row > default** — with an env-pinned field refused by the API (409) and shown
 * read-only. Reads are sync against a cache loaded at boot, because the
 * provider resolution that consults `mode` is on every request's path.
 *
 * Its own module rather than another group in `settings.ts`, which is already
 * a thousand lines; `loadServerSettings()` calls in here so there is still one
 * boot read.
 */

/** How the built-in provider reaches llama.cpp. `managed`: this server installs
 * and supervises `llama-server` itself. `attach`: something else runs the
 * router (Compose's sidecar) against the models directory this server fills.
 * `off`: no local models at all. Env-only — it describes how the deployment was
 * assembled, which is not something an admin can change from a screen. */
export type LlamaMode = "managed" | "attach" | "off";

export type LlamaBackend = "auto" | "metal" | "cuda" | "vulkan" | "rocm" | "cpu";
const BACKENDS: readonly LlamaBackend[] = ["auto", "metal", "cuda", "vulkan", "rocm", "cpu"];

export interface LocalModelsSettings {
  /** `auto` picks from the hardware and never picks `cpu` — CPU inference is
   * only ever an admin's explicit, acknowledged choice. */
  backend: LlamaBackend;
  /** The admin confirmed the CPU warning. `backend: "cpu"` is refused without
   * it, so the warning cannot be skipped by calling the API directly. */
  cpuAcknowledged: boolean;
  /** Device names from `--list-devices` (`Vulkan1`, `CUDA0`, `MTL0`), or null
   * for the default: every GPU with at least 4 GB. The default is what keeps a
   * 2 GB display card out of a split across a real inference card. */
  devices: string[] | null;
  /** How many models the router keeps loaded at once. 1 by default: loading a
   * second model on a single GPU usually means evicting the first anyway, and
   * doing it deliberately is cheaper than running out of VRAM. */
  modelsMax: number;
}

export interface LocalModelsSettingsView extends LocalModelsSettings {
  mode: LlamaMode;
  /** Whether a HuggingFace token is configured. The token itself is never
   * returned, not even to an admin. */
  hasHfToken: boolean;
  envOverrides: { mode: boolean; backend: boolean; modelsMax: boolean; hfToken: boolean };
}

const KEY = "localModels";

const DEFAULTS: LocalModelsSettings = { backend: "auto", cpuAcknowledged: false, devices: null, modelsMax: 1 };

interface Persisted extends Partial<LocalModelsSettings> {
  encryptedHfToken?: string | null;
}

let persisted: Persisted = {};

export class LocalModelsSettingsError extends Error {
  readonly code: "invalid" | "envOverride";
  constructor(message: string, code: "invalid" | "envOverride") {
    super(message);
    this.name = "LocalModelsSettingsError";
    this.code = code;
  }
}

function envStr(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function envMode(): LlamaMode | null {
  const value = envStr("LLAMA_MODE");
  if (value === undefined) return null;
  if (value === "managed" || value === "attach" || value === "off") return value;
  warnOnce("LLAMA_MODE", `[llama] ignoring unrecognized LLAMA_MODE="${value}" (expected managed|attach|off)`);
  return null;
}

function envBackend(): LlamaBackend | null {
  const value = envStr("LLAMA_BACKEND");
  if (value === undefined) return null;
  if ((BACKENDS as readonly string[]).includes(value)) return value as LlamaBackend;
  warnOnce("LLAMA_BACKEND", `[llama] ignoring unrecognized LLAMA_BACKEND="${value}"`);
  return null;
}

function envModelsMax(): number | null {
  const raw = envStr("LLAMA_MODELS_MAX");
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    warnOnce("LLAMA_MODELS_MAX", `[llama] ignoring LLAMA_MODELS_MAX="${raw}" (expected a whole number)`);
    return null;
  }
  return n;
}

export function getLlamaMode(): LlamaMode {
  return envMode() ?? "managed";
}

export function getLocalModelsSettings(): LocalModelsSettingsView {
  const mode = envMode();
  const backend = envBackend();
  const modelsMax = envModelsMax();
  const hfEnv = envStr("HF_TOKEN");
  return {
    mode: mode ?? "managed",
    // An env pin of `cpu` is the operator speaking directly, and counts as
    // acknowledged; nobody pins CPU by accident.
    backend: backend ?? persisted.backend ?? DEFAULTS.backend,
    cpuAcknowledged: backend === "cpu" || (persisted.cpuAcknowledged ?? DEFAULTS.cpuAcknowledged),
    devices: persisted.devices ?? DEFAULTS.devices,
    modelsMax: modelsMax ?? persisted.modelsMax ?? DEFAULTS.modelsMax,
    hasHfToken: hfEnv !== undefined || Boolean(persisted.encryptedHfToken),
    envOverrides: { mode: mode !== null, backend: backend !== null, modelsMax: modelsMax !== null, hfToken: hfEnv !== undefined },
  };
}

/** The HuggingFace token for gated repos, or null. Env wins, as everywhere. A
 * stored token that no longer decrypts is treated as absent rather than
 * failing every download: the admin screen reports gated repos as needing a
 * token, which is the fix. */
export function getHfToken(): string | null {
  const env = envStr("HF_TOKEN");
  if (env) return env;
  if (!persisted.encryptedHfToken) return null;
  try {
    return decryptApiKey(persisted.encryptedHfToken);
  } catch {
    return null;
  }
}

function coerce(raw: unknown): Persisted {
  if (typeof raw !== "object" || raw === null) return {};
  const v = raw as Record<string, unknown>;
  const out: Persisted = {};
  if (typeof v.backend === "string" && (BACKENDS as readonly string[]).includes(v.backend)) {
    out.backend = v.backend as LlamaBackend;
  }
  if (typeof v.cpuAcknowledged === "boolean") out.cpuAcknowledged = v.cpuAcknowledged;
  if (Array.isArray(v.devices) && v.devices.every((d) => typeof d === "string")) out.devices = v.devices;
  if (v.devices === null) out.devices = null;
  if (typeof v.modelsMax === "number" && Number.isInteger(v.modelsMax) && v.modelsMax >= 0) out.modelsMax = v.modelsMax;
  if (typeof v.encryptedHfToken === "string") out.encryptedHfToken = v.encryptedHfToken;
  return out;
}

export async function loadLocalModelsSettings(): Promise<void> {
  try {
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) });
    persisted = coerce(row?.value);
  } catch (err) {
    // Nothing here is a security posture to fail closed on: the defaults are
    // "auto-detect a GPU, one model at a time", which is what a fresh install
    // gets anyway. CPU cannot be reached by this path — it needs the row.
    persisted = {};
    console.error(
      "[llama] could not read local model settings — using defaults: " + (err instanceof Error ? err.message : String(err)),
    );
  }
}

const DEVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * Apply a partial update. Absent keys are left alone; present ones are
 * validated; env-pinned ones are refused.
 */
export async function updateLocalModelsSettings(input: unknown): Promise<LocalModelsSettingsView> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LocalModelsSettingsError("body must be an object", "invalid");
  }
  const body = input as Record<string, unknown>;
  const current = getLocalModelsSettings();
  const next: Persisted = { ...persisted };
  let touched = false;

  if (body.backend !== undefined) {
    if (current.envOverrides.backend) {
      throw new LocalModelsSettingsError("The backend is pinned by the LLAMA_BACKEND environment variable", "envOverride");
    }
    if (typeof body.backend !== "string" || !(BACKENDS as readonly string[]).includes(body.backend)) {
      throw new LocalModelsSettingsError(`backend must be one of ${BACKENDS.join(", ")}`, "invalid");
    }
    const backend = body.backend as LlamaBackend;
    if (backend === "cpu" && body.cpuAcknowledged !== true) {
      throw new LocalModelsSettingsError(
        "Running models on the CPU needs cpuAcknowledged: true — it is much slower than a GPU, and only small models are usable.",
        "invalid",
      );
    }
    next.backend = backend;
    next.cpuAcknowledged = backend === "cpu";
    touched = true;
  }
  if (body.devices !== undefined) {
    if (body.devices === null) next.devices = null;
    else if (
      Array.isArray(body.devices) &&
      body.devices.length <= 16 &&
      body.devices.every((d) => typeof d === "string" && DEVICE_NAME.test(d))
    ) {
      // A device name reaches the preset file, so it is shape-checked like any
      // other value there; the router refuses one it does not know at load.
      next.devices = [...new Set(body.devices as string[])];
    } else {
      throw new LocalModelsSettingsError("devices must be null or a list of device names", "invalid");
    }
    touched = true;
  }
  if (body.modelsMax !== undefined) {
    if (current.envOverrides.modelsMax) {
      throw new LocalModelsSettingsError("modelsMax is pinned by the LLAMA_MODELS_MAX environment variable", "envOverride");
    }
    if (typeof body.modelsMax !== "number" || !Number.isInteger(body.modelsMax) || body.modelsMax < 1 || body.modelsMax > 16) {
      throw new LocalModelsSettingsError("modelsMax must be a whole number from 1 to 16", "invalid");
    }
    next.modelsMax = body.modelsMax;
    touched = true;
  }
  if (body.hfToken !== undefined) {
    if (current.envOverrides.hfToken) {
      throw new LocalModelsSettingsError("The HuggingFace token is pinned by the HF_TOKEN environment variable", "envOverride");
    }
    // A string sets it, null clears it — the same three-way shape the provider
    // API key uses, since the token is never sent back to round-trip.
    if (body.hfToken === null || body.hfToken === "") next.encryptedHfToken = null;
    else if (typeof body.hfToken === "string" && body.hfToken.length <= 512 && !/\s/.test(body.hfToken)) {
      next.encryptedHfToken = encryptApiKey(body.hfToken);
    } else throw new LocalModelsSettingsError("hfToken must be a token string, or null to clear it", "invalid");
    touched = true;
  }
  if (!touched) throw new LocalModelsSettingsError("nothing to update", "invalid");

  await db
    .insert(serverSettings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: next, updatedAt: new Date() } });
  persisted = next;
  return getLocalModelsSettings();
}

/** Test seam. */
export function __resetLocalModelsSettingsForTest(): void {
  persisted = {};
}
