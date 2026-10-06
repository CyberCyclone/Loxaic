import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import { randomBytes } from "node:crypto";
import { decryptApiKey, encryptApiKey } from "../inference/provider-secrets.ts";
import { allowedBuildUrl, OFFICIAL_TAG } from "./runtime-assets.ts";

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
  /** At most this many models loaded at once, 0 (the default) for no count
   * limit. Loxaic enforces it, not llama.cpp: the router is started with
   * `--models-max 0` so that it never unloads anything on its own, because it
   * unloads by count with no notion of a pinned model. What normally decides
   * how many models stay loaded is memory (llama/room.ts). */
  modelsMax: number;
}

/**
 * Which llama.cpp this host runs. `bundled` is the build this version of
 * Loxaic pins and was tested with, and follows that pin across updates.
 * Anything else is an admin's own choice and stays until they change it.
 */
export type RuntimeSelection =
  | { kind: "bundled" }
  | { kind: "official"; tag: string }
  | { kind: "custom"; id: string };

/** The backend a third-party build was made for. Never `auto`: nothing about
 * an arbitrary archive says what it runs on, so the admin does. */
export type CustomBackend = Exclude<LlamaBackend, "auto">;
const CUSTOM_BACKENDS: readonly CustomBackend[] = ["metal", "cuda", "vulkan", "rocm", "cpu"];

/** A llama.cpp build from somewhere other than the official releases. */
export interface CustomBuild {
  id: string;
  name: string;
  url: string;
  /** What the admin said the archive hashes to, or null when they gave none. */
  sha256Expected: string | null;
  /** What the archive that was downloaded and unpacked hashed to. */
  sha256Actual: string | null;
  backend: CustomBackend;
  addedAt: string;
  addedBy: string | null;
}

interface HostRuntime {
  selected?: RuntimeSelection;
  customBuilds?: CustomBuild[];
}

export interface RuntimeSelectionView {
  selected: RuntimeSelection;
  /** `LLAMA_RUNTIME_TAG` decides the version; the API refuses to change it. */
  envPinned: boolean;
  customBuilds: CustomBuild[];
  /** False under `LLAMA_CUSTOM_RUNTIMES=off`. */
  customAllowed: boolean;
}

export interface LocalModelsSettingsView extends LocalModelsSettings {
  mode: LlamaMode;
  /** Whether a HuggingFace token is configured. The token itself is never
   * returned, not even to an admin. */
  hasHfToken: boolean;
  envOverrides: { mode: boolean; backend: boolean; modelsMax: boolean; hfToken: boolean; runtime: boolean };
}

const KEY = "localModels";

const DEFAULTS: LocalModelsSettings = { backend: "auto", cpuAcknowledged: false, devices: null, modelsMax: 0 };

interface Persisted extends Partial<LocalModelsSettings> {
  encryptedHfToken?: string | null;
  /** Keyed by `LOXAIC_INSTANCE_ID` ("" when unset), like `local_models`: a
   * build is files on one machine's disk, so which one runs is that machine's
   * setting even though the row is the deployment's. */
  runtimeByHost?: Record<string, HostRuntime>;
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

/** `LLAMA_RUNTIME_TAG=bundled|b<number>`: the operator's choice of version,
 * which the admin screen then shows read-only. */
function envRuntime(): RuntimeSelection | null {
  const value = envStr("LLAMA_RUNTIME_TAG");
  if (value === undefined) return null;
  if (value === "bundled") return { kind: "bundled" };
  if (OFFICIAL_TAG.test(value)) return { kind: "official", tag: value };
  warnOnce("LLAMA_RUNTIME_TAG", `[llama] ignoring LLAMA_RUNTIME_TAG="${value}" (expected "bundled" or a release tag like b11342)`);
  return null;
}

/** Third-party builds are binaries from wherever an admin points; an operator
 * who does not want that possible at all says so here. */
export function customRuntimesAllowed(): boolean {
  return envStr("LLAMA_CUSTOM_RUNTIMES") !== "off";
}

function hostId(): string {
  return process.env.LOXAIC_INSTANCE_ID ?? "";
}

function hostRuntime(): HostRuntime {
  return persisted.runtimeByHost?.[hostId()] ?? {};
}

export function getRuntimeSelection(): RuntimeSelectionView {
  const env = envRuntime();
  const host = hostRuntime();
  const customAllowed = customRuntimesAllowed();
  let selected = env ?? host.selected ?? { kind: "bundled" };
  // Switched off after one was chosen: the choice is not honoured, and the
  // bundled build runs. The row keeps it, so switching back on restores it.
  if (selected.kind === "custom" && !customAllowed) selected = { kind: "bundled" };
  return { selected, envPinned: env !== null, customBuilds: customAllowed ? (host.customBuilds ?? []) : [], customAllowed };
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
    envOverrides: {
      mode: mode !== null,
      backend: backend !== null,
      modelsMax: modelsMax !== null,
      hfToken: hfEnv !== undefined,
      runtime: envRuntime() !== null,
    },
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
  if (typeof v.runtimeByHost === "object" && v.runtimeByHost !== null && !Array.isArray(v.runtimeByHost)) {
    const hosts: Record<string, HostRuntime> = {};
    for (const [host, raw] of Object.entries(v.runtimeByHost as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const entry: HostRuntime = {};
      const selected = coerceSelection(r.selected);
      if (selected) entry.selected = selected;
      if (Array.isArray(r.customBuilds)) entry.customBuilds = r.customBuilds.flatMap((b) => coerceCustomBuild(b) ?? []);
      hosts[host] = entry;
    }
    out.runtimeByHost = hosts;
  }
  return out;
}

const CUSTOM_ID = /^[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function coerceSelection(raw: unknown): RuntimeSelection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.kind === "bundled") return { kind: "bundled" };
  if (v.kind === "official" && typeof v.tag === "string" && OFFICIAL_TAG.test(v.tag)) return { kind: "official", tag: v.tag };
  if (v.kind === "custom" && typeof v.id === "string" && CUSTOM_ID.test(v.id)) return { kind: "custom", id: v.id };
  return null;
}

/** A stored row is re-checked on the way in like anything else: its id names
 * a directory and its URL is fetched. */
function coerceCustomBuild(raw: unknown): CustomBuild | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !CUSTOM_ID.test(v.id)) return null;
  if (typeof v.name !== "string" || typeof v.url !== "string") return null;
  // The rule the API applies when a build is added, applied to whatever is
  // stored: a row can arrive by another route (a restored backup, a hand edit).
  if (!allowedBuildUrl(v.url)) return null;
  if (typeof v.backend !== "string" || !(CUSTOM_BACKENDS as readonly string[]).includes(v.backend)) return null;
  return {
    id: v.id,
    name: v.name,
    url: v.url,
    sha256Expected: typeof v.sha256Expected === "string" && SHA256.test(v.sha256Expected) ? v.sha256Expected : null,
    sha256Actual: typeof v.sha256Actual === "string" && SHA256.test(v.sha256Actual) ? v.sha256Actual : null,
    backend: v.backend as CustomBackend,
    addedAt: typeof v.addedAt === "string" ? v.addedAt : new Date(0).toISOString(),
    addedBy: typeof v.addedBy === "string" ? v.addedBy : null,
  };
}

export async function loadLocalModelsSettings(): Promise<void> {
  try {
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) });
    persisted = coerce(row?.value);
  } catch (err) {
    // Nothing here is a security posture to fail closed on: the defaults are
    // "auto-detect a GPU, as many models as fit", which is what a fresh install
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
  // From the row as it is now, not this process's copy: the row also holds
  // each host's choice of llama.cpp version, which another server sharing the
  // database writes, and a write from a stale copy would undo it (found in
  // review). Untouched fields are whatever is stored.
  const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) });
  const next: Persisted = { ...coerce(row?.value) };
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
    if (typeof body.modelsMax !== "number" || !Number.isInteger(body.modelsMax) || body.modelsMax < 0 || body.modelsMax > 16) {
      throw new LocalModelsSettingsError("modelsMax must be a whole number from 0 (no limit) to 16", "invalid");
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

  await persist(next);
  return getLocalModelsSettings();
}

async function persist(next: Persisted): Promise<void> {
  await db
    .insert(serverSettings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: next, updatedAt: new Date() } });
  persisted = next;
}

/**
 * Change this host's runtime entry, starting from the row as it is in the
 * database now rather than from this process's copy of it. Every other
 * setting in the row is deployment-wide and rarely written; this part is one
 * entry per machine, so two servers sharing a database each write it, and a
 * write from a stale copy would undo the other machine's choice of version.
 * A host back on the defaults has its entry removed.
 */
async function changeHostRuntime(change: (host: HostRuntime) => HostRuntime): Promise<void> {
  const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) });
  const fresh = coerce(row?.value);
  const id = hostId();
  const hosts = { ...fresh.runtimeByHost };
  const next = change(hosts[id] ?? {});
  const isDefault = (next.selected ?? { kind: "bundled" }).kind === "bundled" && (next.customBuilds ?? []).length === 0;
  if (isDefault) Reflect.deleteProperty(hosts, id);
  else hosts[id] = next;
  await persist({ ...fresh, runtimeByHost: hosts });
}

function refuseIfPinned(): void {
  if (envRuntime() !== null) {
    throw new LocalModelsSettingsError("The llama.cpp version is pinned by the LLAMA_RUNTIME_TAG environment variable", "envOverride");
  }
}

function refuseIfCustomOff(): void {
  if (!customRuntimesAllowed()) {
    throw new LocalModelsSettingsError("Third-party llama.cpp builds are switched off on this server (LLAMA_CUSTOM_RUNTIMES=off)", "envOverride");
  }
}

/** Choose the version this host runs. The caller has already made sure it is
 * downloaded; this only checks that it names something that can exist. */
export async function setRuntimeSelection(input: unknown): Promise<RuntimeSelection> {
  refuseIfPinned();
  const selected = coerceSelection(input);
  if (!selected) {
    throw new LocalModelsSettingsError('Choose { kind: "bundled" }, { kind: "official", tag } or { kind: "custom", id }', "invalid");
  }
  if (selected.kind === "custom") {
    refuseIfCustomOff();
    if (!(hostRuntime().customBuilds ?? []).some((b) => b.id === selected.id)) {
      throw new LocalModelsSettingsError("No such third-party build", "invalid");
    }
  }
  await changeHostRuntime((h) => ({ ...h, selected }));
  return selected;
}

const MAX_CUSTOM_BUILDS = 16;

export async function addCustomBuild(input: unknown, addedBy: string | null): Promise<CustomBuild> {
  refuseIfCustomOff();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LocalModelsSettingsError("body must be an object", "invalid");
  }
  const body = input as Record<string, unknown>;
  // Shown on the admin screen and written to the router's log: one line of
  // printable text.
  // eslint-disable-next-line no-control-regex
  const name = typeof body.name === "string" ? body.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 60) throw new LocalModelsSettingsError("Give the build a name of up to 60 characters", "invalid");
  if (typeof body.url !== "string" || body.url.length > 2000 || !allowedBuildUrl(body.url)) {
    throw new LocalModelsSettingsError("The download address must be an https:// link to the build's archive, with no username or password in it", "invalid");
  }
  let sha256Expected: string | null = null;
  if (body.sha256 !== undefined && body.sha256 !== null && body.sha256 !== "") {
    const sha = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase().replace(/^sha256:/, "") : "";
    if (!SHA256.test(sha)) throw new LocalModelsSettingsError("The SHA-256 must be 64 hexadecimal characters", "invalid");
    sha256Expected = sha;
  }
  if (typeof body.backend !== "string" || !(CUSTOM_BACKENDS as readonly string[]).includes(body.backend)) {
    throw new LocalModelsSettingsError(`backend must be one of ${CUSTOM_BACKENDS.join(", ")}`, "invalid");
  }
  if (body.backend === "cpu" && body.cpuAcknowledged !== true) {
    throw new LocalModelsSettingsError(
      "A CPU build needs cpuAcknowledged: true — it is much slower than a GPU, and only small models are usable.",
      "invalid",
    );
  }
  const have = hostRuntime().customBuilds ?? [];
  if (have.length >= MAX_CUSTOM_BUILDS) {
    throw new LocalModelsSettingsError(`At most ${String(MAX_CUSTOM_BUILDS)} third-party builds can be kept; remove one first`, "invalid");
  }
  const build: CustomBuild = {
    id: randomBytes(6).toString("hex"),
    name,
    url: body.url,
    sha256Expected,
    sha256Actual: null,
    backend: body.backend as CustomBackend,
    addedAt: new Date().toISOString(),
    addedBy,
  };
  await changeHostRuntime((h) => ({ ...h, customBuilds: [...(h.customBuilds ?? []), build] }));
  return build;
}

/** Forget a third-party build. Refused while it is the one chosen: the caller
 * removes its files, and a selection naming nothing is a runtime that cannot
 * start. */
export async function removeCustomBuild(id: string): Promise<void> {
  const host = hostRuntime();
  if (!(host.customBuilds ?? []).some((b) => b.id === id)) throw new LocalModelsSettingsError("No such third-party build", "invalid");
  if (host.selected?.kind === "custom" && host.selected.id === id) {
    throw new LocalModelsSettingsError("This build is the one in use. Switch to another version first.", "invalid");
  }
  await changeHostRuntime((h) => ({ ...h, customBuilds: (h.customBuilds ?? []).filter((b) => b.id !== id) }));
}

/** Record what a third-party build's archive hashed to, once it is unpacked. */
export async function recordCustomBuildHash(id: string, sha256: string): Promise<void> {
  if (!(hostRuntime().customBuilds ?? []).some((b) => b.id === id)) return;
  await changeHostRuntime((h) => ({
    ...h,
    customBuilds: (h.customBuilds ?? []).map((b) => (b.id === id ? { ...b, sha256Actual: sha256 } : b)),
  }));
}

/** Test seam. */
export function __resetLocalModelsSettingsForTest(): void {
  persisted = {};
}
