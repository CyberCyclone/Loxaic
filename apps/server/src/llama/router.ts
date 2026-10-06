import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROVIDER_ID } from "@loxaic/types";
import { listServableModels } from "./catalog.ts";
import {
  defaultDevices,
  detectHardware,
  parseDeviceList,
  resolveFlavour,
  type BuildFlavour,
  type HardwareGuess,
  type RuntimeDevice,
} from "./hardware.ts";
import { presetPath, routerLogPath } from "./paths.ts";
import { foldPlacementLine, newPlacementTracker, type RawPlacement } from "./placement.ts";
import { carriesPrompt, lineSplitter, openRouterLog, type RouterLog } from "./router-log.ts";
import {
  modelIdFromRouterName,
  renderPreset,
  routerModelName,
  sectionsById,
  writePreset,
  type PresetGlobals,
} from "./preset.ts";
import {
  anyRuntimeInstalled,
  binOverride,
  pruneRuntimes,
  recordRuntimeVersion,
  RUNTIME_MANIFEST,
  type InstalledRuntime,
  type InstallProgress,
} from "./runtime.ts";
import {
  customFlavour,
  findCustomBuild,
  installedForSelection,
  installSelection,
  olderTag,
  versionDownloads,
  type VersionDownload,
} from "./runtime-versions.ts";
import {
  getLlamaMode,
  getLocalModelsSettings,
  getRuntimeSelection,
  type LlamaBackend,
  type LlamaMode,
  type RuntimeSelection,
} from "./settings.ts";

/**
 * The llama.cpp router the built-in provider talks to.
 *
 * In `managed` mode this module owns a `llama-server` process in router mode:
 * one parent that spawns a child per loaded model, picks it by the request's
 * `model` field, and loads and unloads on demand. It is started with the
 * preset file (preset.ts) and a random API key, bound to loopback, with an
 * environment built from scratch. In `attach` mode someone else runs the
 * router (Compose's sidecar) and this module only talks to it. In `off` mode
 * there is no router.
 *
 * Everything the rest of the server needs is `routerEndpoint()` (where to send
 * requests, sync, for `defaultProvider()`) and `runtimeView()` (what to tell
 * an admin).
 */

export type RuntimeState =
  | "off"
  | "not-installed"
  | "needs-gpu"
  | "installing"
  | "starting"
  | "running"
  | "error";

export interface RuntimeView {
  mode: LlamaMode;
  state: RuntimeState;
  /** Why the state is what it is, in a sentence an admin can act on. */
  reason: string | null;
  installProgress: InstallProgress | null;
  /** The build this host runs, or is set to run: a release tag such as
   * `b11149`, or a third-party build's name. */
  tag: string;
  /** Which llama.cpp was chosen, and how it relates to the bundled one. */
  version: RuntimeVersionView;
  /** Versions being downloaded from the picker, and downloads that failed. */
  versionDownloads: VersionDownload[];
  backend: LlamaBackend;
  /** What the backend resolved to on this machine, or null when nothing fits. */
  flavour: BuildFlavour | null;
  hardware: HardwareGuess | null;
  /** From the runtime's own `--list-devices`, once one is installed. */
  devices: RuntimeDevice[];
  /** The devices models are offloaded to, or `none` for CPU only. */
  activeDevices: string[] | "none";
  /** Whether this machine has a GPU at all — decides which CPU warning the
   * admin screen shows. */
  gpuAvailable: boolean;
  cpuActive: boolean;
  /** The last lines llama.cpp wrote that look like errors, newest last. */
  recentErrors: string[];
  /** A restart under way, from the moment it is asked for (or the router
   * crashed) until the pinned models are back, or null. `state` alone cannot
   * say this: a restart passes through `starting` for a second or two, which
   * a 15-second poll — or a 1-second one — mostly never sees. */
  restart: RestartView | null;
  /** This host's RAM, for settings that put part of a model there. */
  hostMemory: { totalBytes: number; freeBytes: number };
}

export interface RuntimeVersionView {
  /** `external` in attach mode: the version is the sidecar's image, which
   * this server neither chose nor can read. */
  kind: RuntimeSelection["kind"] | "external";
  /** The release tag, for a bundled or official build. */
  tag: string | null;
  /** A third-party build's name. */
  name: string | null;
  /** What the running binary's `--version` printed, when it has been asked. */
  reported: string | null;
  /** The release this version of Loxaic pins and was tested with. */
  bundledTag: string;
  /** An official release was chosen and Loxaic's own is newer than it. */
  bundledNewer: boolean;
  /** Something other than the bundled build is chosen, and the admin may
   * switch back. What the card offers when that build will not start. */
  canRevert: boolean;
  /** `LLAMA_RUNTIME_TAG` decides the version. */
  envPinned: boolean;
  /** Third-party builds may be added (not `LLAMA_CUSTOM_RUNTIMES=off`). */
  customAllowed: boolean;
}

export type RestartPhase = "stopping" | "starting" | "loading-pinned";

export interface RestartView {
  phase: RestartPhase;
  /** Why: an admin pressed Restart (or changed the backend or devices), or
   * the router stopped on its own and is being started again. */
  cause: "requested" | "crashed";
  startedAt: string;
}

interface State {
  state: RuntimeState;
  reason: string | null;
  installProgress: InstallProgress | null;
  flavour: BuildFlavour | null;
  hardware: HardwareGuess | null;
  devices: RuntimeDevice[];
  activeDevices: string[] | "none";
  runtime: InstalledRuntime | null;
  child: ChildProcess | null;
  port: number | null;
  apiKey: string | null;
  stopping: boolean;
}

const st: State = {
  state: "not-installed",
  reason: null,
  installProgress: null,
  flavour: null,
  hardware: null,
  devices: [],
  activeDevices: [],
  runtime: null,
  child: null,
  port: null,
  apiKey: null,
  stopping: false,
};

/** The restart under way (see `RuntimeView.restart`). Replaced, never
 * mutated by a later restart, so a pass that finishes late clears only its
 * own. */
let restart: { phase: RestartPhase; cause: RestartView["cause"]; startedAt: number } | null = null;

/** Attach mode's last health answer, refreshed on a timer and on demand. */
let attachHealthy: boolean | null = null;
/**
 * Attach mode's API key. The sidecar must not answer unauthenticated any more
 * than the managed router may (llama.cpp allows every CORS origin, so a page in
 * the operator's browser could otherwise unload models or reload the list), and
 * the two processes have no channel but the shared volume — so the key lives
 * there, in a 0600 file the server mints once and the sidecar's entrypoint
 * reads before it starts. `LLAMA_API_KEY` in both environments overrides it.
 */
let attachKey: string | null = null;

async function ensureAttachKey(): Promise<void> {
  if (process.env.LLAMA_API_KEY?.trim()) return;
  const file = path.join(path.dirname(presetPath()), "router.key");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{32,}$/.test(existing)) {
      attachKey = existing;
      return;
    }
  } catch {
    // not minted yet
  }
  const key = randomBytes(24).toString("hex");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  attachKey = key;
}
/** Attach mode: whether the sidecar has recorded what `--list-devices` found
 * (infra/docker/llama-router.sh writes it into the shared volume). Until it
 * has, "no devices" means "not told", never "running on the CPU". */
let attachDevicesKnown = false;
let attachTimer: NodeJS.Timeout | null = null;

// ── Log capture ─────────────────────────────────────────────────────────────

/** Enough for a model that crashed while loading: its error line comes just
 * before a backtrace of thirty-odd lines, and other models keep logging. A
 * model's load writes a few hundred lines at the verbosity placement needs
 * (preset.ts `placementLog`), and each request some forty. */
const LOG_LINES = 2000;
const logTail: string[] = [];
/** Everything the router prints, on disk as well (router-log.ts): the tail
 * above is what this process explains failures from, the file is what a person
 * reads after a restart. Opened at the first spawn, so a server that never runs
 * a router writes nothing. */
let routerLog: RouterLog | null = null;

/** Where each loaded model's memory went, folded from the log as it arrives
 * (placement.ts). */
const placements = newPlacementTracker();
/** One line splitter per output stream (`lineSplitter`): stdout and stderr
 * are read independently, so one shared carry-over could join the end of a
 * stderr chunk to the start of a stdout one, making a line that is neither. */
const splitters = new Map<string, (chunk: string) => string[]>();

function recordLog(chunk: string, stream = "stderr"): void {
  let split = splitters.get(stream);
  if (!split) {
    split = lineSplitter();
    splitters.set(stream, split);
  }
  const kept = split(chunk).filter((line) => !carriesPrompt(line));
  if (kept.length > 0) routerLog?.write(`${kept.join("\n")}\n`);
  for (const line of kept) {
    if (!line.trim()) continue;
    logTail.push(line);
    if (logTail.length > LOG_LINES) logTail.shift();
    foldPlacementLine(placements, line);
  }
}

/** What the newest load of host model `id` allocated, while it is loaded. */
export function rawPlacementFor(id: string): RawPlacement | null {
  return placements.byName.get(routerModelName(id)) ?? null;
}

/** The router's pid, whose children serve the models. */
export function routerPid(): number | null {
  return getLlamaMode() === "managed" ? (st.child?.pid ?? null) : null;
}

/** llama.cpp marks errors with ` E ` after its timestamp, in the router's own
 * lines and in the `[port]`-prefixed lines of each model child. */
function recentErrors(): string[] {
  return logTail.filter((l) => l.includes(" E ") || /error/i.test(l)).slice(-8);
}

/**
 * One sentence from a dead router's stderr, in the order most likely to be
 * the real cause. Modelled on the tsnet sidecar's `explainExit`.
 */
export function explainRouterExit(lines: string[], code: number | null, signal: NodeJS.Signals | null): string {
  const errors = lines.filter((l) => l.includes(" E "));
  const pick = errors.at(-1) ?? lines.at(-1);
  const how = signal ? `was killed (${signal})` : `exited with code ${String(code)}`;
  if (!pick) return `llama.cpp ${how}.`;
  // Strip llama.cpp's own timestamp and level prefix: `0.00.067.911 E srv  llama_server: `.
  const text = pick.replace(/^\[\d+\]\s*/, "").replace(/^[\d.]+\s+[A-Z]\s+\w+\s+/, "").trim();
  return `llama.cpp ${how}: ${text}`;
}

const SPAWN_LINE = /spawning server instance with name=(\S+) on port (\d+)/;
const CHILD_LINE = /^\[\s*(\d+)\]\s?(.*)$/;

/**
 * Why a model's own llama-server stopped while loading, from the router's
 * output — the router itself only answers `model name=… failed to load`.
 *
 * The router logs `spawning server instance with name=<name> on port <P>` and
 * forwards that child's stdout and stderr as `[    P] line`, so the lines
 * after the newest spawn of this model, on its port, are its own. Of those, an
 * assertion (`GGML_ASSERT(buffer) failed`, which is how llama.cpp b11342 dies
 * loading Qwen3.8-Flash-Next with unsloth's MTP head) wins, then an error-level
 * line, then anything that says it failed — never a backtrace frame or
 * gdb's chatter. Source paths are cut to the file name: the reason reaches
 * the chat, and the CI runner's home directory means nothing there.
 */
export function explainModelLoadFailure(lines: string[], routerName: string): string | null {
  let port = "";
  let from = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = SPAWN_LINE.exec(lines[i] ?? "");
    if (m?.[1] === routerName) {
      port = m[2];
      from = i;
    }
  }
  if (from < 0) return null;
  const own: string[] = [];
  for (const line of lines.slice(from + 1)) {
    const m = CHILD_LINE.exec(line);
    if (m?.[1] === port && m[2]) own.push(m[2].trim());
  }
  const candidates = own.filter((l) => !/^#\d+\s/.test(l) && !/^warning:/i.test(l) && !/^\[(Inferior|New Thread|Thread debugging)/.test(l) && !l.includes("⚠"));
  const last = (test: (l: string) => boolean) => [...candidates].reverse().find(test);
  const pick =
    last((l) => l.includes("GGML_ASSERT")) ??
    last((l) => /^[\d.]+\s+E\s/.test(l)) ??
    last((l) => /\b(error|failed|abort(ed)?|terminate called)\b/i.test(l));
  if (!pick) return null;
  const text = pick
    .replace(/^[\d.]+\s+[A-Z]\s+\S+\s+/, "")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s:\\/]+[\\/])+([^\s:\\/]+)/g, "$1")
    .trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text || null;
}

/** `explainModelLoadFailure` over what this process has seen the router print. */
export function modelLoadFailureReason(id: string): string | null {
  return explainModelLoadFailure(logTail, routerModelName(id));
}

// ── Where requests go ───────────────────────────────────────────────────────

export interface RouterEndpoint {
  /** `…/v1` — what `defaultProvider().apiBase` is. */
  apiBase: string;
  /** The router root, where `/models`, `/props` and `/health` live. */
  nativeRoot: string;
  apiKey: string | null;
}

/**
 * Where the built-in provider sends requests right now, or null when there is
 * no router to send them to. Sync, because `defaultProvider()` is.
 */
export function routerEndpoint(): RouterEndpoint | null {
  const mode = getLlamaMode();
  if (mode === "off") return null;
  if (mode === "attach") {
    const url = process.env.LLAMA_ROUTER_URL;
    if (!url) return null;
    const root = url.replace(/\/+$/, "").replace(/\/v1$/, "");
    return { apiBase: `${root}/v1`, nativeRoot: root, apiKey: process.env.LLAMA_API_KEY?.trim() ? process.env.LLAMA_API_KEY : attachKey };
  }
  if (st.state !== "running" || st.port === null) return null;
  const root = `http://127.0.0.1:${String(st.port)}`;
  return { apiBase: `${root}/v1`, nativeRoot: root, apiKey: st.apiKey };
}

/** The sentence a request to the built-in provider fails with when there is no
 * router — instead of "connection refused" to an address nobody configured. */
export function routerUnavailableReason(): string {
  const mode = getLlamaMode();
  if (mode === "off") return "Host models are turned off on this server. Pick a model from a provider instead.";
  if (mode === "attach") {
    return process.env.LLAMA_ROUTER_URL
      ? "The model server is not answering. Ask an admin to check the llama.cpp container."
      : "LLAMA_MODE is attach, but LLAMA_ROUTER_URL is not set. Ask an admin to fix the server's configuration.";
  }
  if (st.state === "installing" || st.state === "starting") {
    return "The built-in model runtime is still starting up. Try again in a moment.";
  }
  return "The built-in model runtime isn't running. An admin can set it up under Settings > Host models.";
}

async function routerFetch(pathname: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const ep = routerEndpoint();
  if (!ep) throw new Error(routerUnavailableReason());
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    return await fetch(`${ep.nativeRoot}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface RouterModelStatus {
  id: string;
  /** `unloaded | loading | loaded | sleeping` */
  value: string;
  failed: boolean;
}

/** The router's view of every preset model, keyed by model id (not by the name
 * the router uses — see routerModelName), or an empty map when it cannot be
 * asked. Never throws — a listing must not fail because the router is down. */
export async function routerModelStatuses(): Promise<Map<string, RouterModelStatus>> {
  const out = new Map<string, RouterModelStatus>();
  try {
    const res = await routerFetch("/models", {}, 2000);
    if (!res.ok) return out;
    const body = (await res.json()) as { data?: { id?: string; status?: { value?: string; failed?: boolean } }[] };
    for (const m of body.data ?? []) {
      if (typeof m.id !== "string") continue;
      const id = modelIdFromRouterName(m.id);
      out.set(id, { id, value: m.status?.value ?? "unloaded", failed: m.status?.failed === true });
    }
  } catch {
    // Router down or unreachable — callers show every model as not loaded.
  }
  return out;
}

/** `/props` for one model. The router requires `?model=`; without it the
 * answer is a 400. Null when the model is not loaded or cannot be asked. */
export async function routerModelProps(
  id: string,
): Promise<{ nCtx: number | null; totalSlots: number | null } | null> {
  try {
    const res = await routerFetch(`/props?model=${encodeURIComponent(routerModelName(id))}&autoload=false`, {}, 2000);
    if (!res.ok) return null;
    const body = (await res.json()) as { total_slots?: number; default_generation_settings?: { n_ctx?: number } };
    const nCtx = body.default_generation_settings?.n_ctx;
    return {
      nCtx: typeof nCtx === "number" && nCtx > 0 ? nCtx : null,
      totalSlots: typeof body.total_slots === "number" && body.total_slots > 0 ? body.total_slots : null,
    };
  } catch {
    return null;
  }
}

export async function unloadModel(id: string): Promise<void> {
  try {
    await routerFetch("/models/unload", { method: "POST", body: JSON.stringify({ model: routerModelName(id) }) });
  } catch {
    // Not loaded, or no router — either way it is not holding memory.
  }
}

/**
 * Wait until the router reports `id` as `want`, or until the deadline. The
 * router answers `/models/load` and `/models/unload` before the child process
 * has finished starting or exiting, and memory is only back once it has
 * exited, so anything that measures memory next has to wait for the status.
 * Resolves to the last status seen (undefined when the model is not listed).
 */
export async function waitForModelStatus(
  id: string,
  want: "loaded" | "unloaded",
  timeoutMs: number,
): Promise<RouterModelStatus | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: RouterModelStatus | undefined;
  for (;;) {
    last = (await routerModelStatuses()).get(id);
    const value = last?.value ?? "unloaded";
    if (value === want) return last;
    // A load that failed will not become loaded by waiting.
    if (want === "loaded" && last?.failed && value !== "loading") return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Ask the router to load a model now rather than on its first request — how
 * a pinned model is kept loaded. Throws with the router's own words when it
 * refuses outright; whether the load then succeeded is `waitForModelStatus`. */
export async function loadModel(id: string): Promise<void> {
  const res = await routerFetch("/models/load", { method: "POST", body: JSON.stringify({ model: routerModelName(id) }) }, 30_000);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // not JSON
    }
    throw new Error(message.slice(0, 300) || `llama.cpp refused to load the model (HTTP ${String(res.status)})`);
  }
}

// ── The preset and live reloads ─────────────────────────────────────────────

let lastSections = new Map<string, string>();
let reloadPending = false;
let reloadTimer: NodeJS.Timeout | null = null;
let lastReloadError: string | null = null;
/** Loaded models whose sections an admin's write changed, to be loaded again
 * once the router has re-read the preset (which unloads them). Held across a
 * deferred reload — that is when `reloadPendingFor` says so. */
const restoreAfterReload = new Set<string>();

/** A loaded model's new settings are waiting for a run to end. */
export function reloadPendingFor(id: string): boolean {
  return reloadPending && restoreAfterReload.has(id);
}

/** Forget a deferred reload: the flag, its timer and the models held for it
 * go together, so the row never says "reload pending" with nothing left to
 * act on it, and no timer outlives the reload it was waiting to run. */
function endDeferredReload(): void {
  reloadPending = false;
  if (reloadTimer) clearInterval(reloadTimer);
  reloadTimer = null;
  restoreAfterReload.clear();
}

function presetGlobals(): PresetGlobals {
  return {
    devices: st.activeDevices === "none" ? "none" : st.activeDevices.length > 0 ? st.activeDevices : null,
    placementLog: getLlamaMode() === "managed" && verifiedLogs(),
  };
}

/**
 * Whether the build being run is the one whose log was checked. Placement
 * needs `log-verbosity = 4`, and at that level only the bundled release is
 * known to print no prompt text (AGENTS.md, "Host model state"). Another
 * release or a fork may print a request's body at a level we would be asking
 * for, straight into `router.log` — so a chosen build runs at llama.cpp's
 * default verbosity and shows no placement detail.
 */
function verifiedLogs(): boolean {
  const { selected } = getRuntimeSelection();
  return selected.kind === "bundled" || (selected.kind === "official" && selected.tag === RUNTIME_MANIFEST.tag);
}

/** How busy the built-in provider is. Imported lazily: the scheduler reaches
 * the model layer, which reaches this module. */
async function builtinRunsActive(): Promise<number> {
  const { schedulerState } = await import("../inference/scheduler.ts");
  const s = schedulerState(DEFAULT_PROVIDER_ID);
  // An exclusive holder is a context-stage switch, the one thing that wants
  // this reload now — no reply is running under it.
  return s.exclusive ? 0 : s.running;
}

/** Have the router re-read the preset. False when it did not: a refused
 * reload keeps the router's old list, so nothing was unloaded and the models
 * held to be loaded again are owed nothing — kept, a later, unrelated reload
 * would load them, maybe after an admin had unloaded one. */
async function reloadNow(): Promise<boolean> {
  try {
    const res = await routerFetch("/models?reload=1", {}, 10_000);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastReloadError = `llama.cpp refused the model list (HTTP ${String(res.status)}): ${text.slice(0, 300)}`;
      console.error(`[llama] ${lastReloadError}`);
      restoreAfterReload.clear();
      return false;
    }
    lastReloadError = null;
  } catch (err) {
    // No router yet: it reads the file when it starts, with nothing loaded.
    lastReloadError = null;
    void err;
    restoreAfterReload.clear();
    return false;
  }
  // A reload unloads every loaded model whose section changed, a pinned one
  // included, and a newly pinned model has only just been written into the
  // preset: either way, pinned models are loaded again from here.
  void keepPinnedLoaded();
  // So are the unpinned ones that were loaded when an admin changed them: an
  // admin who saves a loaded model's settings expects it to come back with
  // them, not to wait for whoever happens to ask it next.
  if (restoreAfterReload.size > 0) {
    const ids = [...restoreAfterReload];
    restoreAfterReload.clear();
    void import("./room.ts")
      .then((m) => { m.restoreModels(ids); })
      .catch((e: unknown) => { console.error(`[llama] could not reload models: ${e instanceof Error ? e.message : String(e)}`); });
  }
  return true;
}

/** Load every pinned model that is not loaded. Imported lazily: room.ts
 * reaches this module for everything it does. Never awaited by the caller — a
 * load can take minutes, and nothing that triggered it should wait on it. */
export function keepPinnedLoaded(): Promise<void> {
  return import("./room.ts")
    .then((m) => m.loadPinnedModels())
    .catch((e: unknown) => { console.error(`[llama] could not load pinned models: ${e instanceof Error ? e.message : String(e)}`); });
}

function scheduleDeferredReload(): void {
  reloadPending = true;
  if (reloadTimer) return;
  reloadTimer = setInterval(() => {
    void (async () => {
      if (!reloadPending) {
        // Ended elsewhere (a restart): nothing left for this timer to do.
        if (reloadTimer) clearInterval(reloadTimer);
        reloadTimer = null;
        return;
      }
      if ((await builtinRunsActive()) > 0) return;
      reloadPending = false;
      if (reloadTimer) clearInterval(reloadTimer);
      reloadTimer = null;
      await reloadNow();
    })();
  }, 2000);
  reloadTimer.unref();
}

export interface SyncResult {
  /** A changed model is loaded and a run is using the built-in provider, so
   * the router re-reads its settings once that run is done. Reloading now
   * would unload the model under the run. */
  deferred: boolean;
  /** Loaded models the reload unloads (or will, when deferred) and that are
   * being loaded again with their new settings — `restoreLoaded` only. */
  reloading: string[];
}

export interface SyncOptions {
  /** Load models again that were loaded when their sections changed. An
   * admin's write wants this; a context-stage switch loads for itself. */
  restoreLoaded?: boolean;
}

/**
 * Rewrite the preset from the database and have the router re-read it.
 *
 * The router unloads a model whose section changed. Adding or removing a
 * section is harmless to a running conversation, but changing one that is
 * loaded mid-run is not — so that case waits until the built-in provider is
 * idle.
 */
/** Rewrites are serialised: `syncPreset` is reachable from an admin's write
 * and from the runtime starting, and two overlapping read-modify-writes of the
 * preset would otherwise race each other's view of `lastSections`. */
let presetChain: Promise<unknown> = Promise.resolve();

export function syncPreset(opts: SyncOptions = {}): Promise<SyncResult> {
  const run = () => syncPresetNow(opts);
  const next = presetChain.then(run, run);
  presetChain = next.catch(() => undefined);
  return next;
}

async function syncPresetNow(opts: SyncOptions): Promise<SyncResult> {
  const mode = getLlamaMode();
  if (mode === "off") return { deferred: false, reloading: [] };
  const rows = await listServableModels();
  const globals = presetGlobals();
  const sections = sectionsById(rows, globals);
  await writePreset(renderPreset(rows, globals));

  // A section that changed *or disappeared* makes the router unload that model
  // on reload — disabling or deleting a model mid-run would cut the run off.
  const changed = [
    ...[...sections].filter(([id, text]) => lastSections.has(id) && lastSections.get(id) !== text).map(([id]) => id),
    ...[...lastSections.keys()].filter((id) => !sections.has(id)),
  ];
  lastSections = sections;
  if (!routerEndpoint()) return { deferred: false, reloading: [] };

  let reloading: string[] = [];
  if (changed.length > 0) {
    const statuses = await routerModelStatuses();
    const loaded = changed.filter((id) => {
      const s = statuses.get(id)?.value;
      return s === "loaded" || s === "loading";
    });
    // Only a model still in the preset comes back: one disabled or deleted by
    // this write is meant to stay unloaded.
    if (opts.restoreLoaded) {
      reloading = loaded.filter((id) => sections.has(id));
      for (const id of reloading) restoreAfterReload.add(id);
    }
    if (loaded.length > 0 && (await builtinRunsActive()) > 0) {
      scheduleDeferredReload();
      return { deferred: true, reloading };
    }
  }
  // A refused reload unloaded nothing, so nothing is being loaded again.
  const reloaded = await reloadNow();
  return { deferred: false, reloading: reloaded ? reloading : [] };
}

// ── Process management (managed mode) ───────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => { resolve(port); });
    });
  });
}

/**
 * The child's environment, built from scratch — never `process.env`, which
 * carries the database URL, the auth secret and every provider key. The API
 * key goes in the environment rather than argv so it is not in `ps`; model
 * children inherit it from the router.
 */
function childEnv(bin: string, apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LLAMA_API_KEY: apiKey,
  };
  if (process.platform === "linux") env.LD_LIBRARY_PATH = path.dirname(bin);
  if (process.platform === "win32") {
    for (const k of ["SystemRoot", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
      if (process.env[k]) env[k] = process.env[k];
    }
  }
  // Tests only: the fake router records the preset it loaded here.
  if (process.env.LOXAIC_FAKE_ROUTER_LOG) env.LOXAIC_FAKE_ROUTER_LOG = process.env.LOXAIC_FAKE_ROUTER_LOG;
  if (process.env.LOXAIC_FAKE_DEVICES) env.LOXAIC_FAKE_DEVICES = process.env.LOXAIC_FAKE_DEVICES;
  if (process.env.LOXAIC_FAKE_HARDWARE) env.LOXAIC_FAKE_HARDWARE = process.env.LOXAIC_FAKE_HARDWARE;
  if (process.env.LOXAIC_FAKE_MODEL_MIB) env.LOXAIC_FAKE_MODEL_MIB = process.env.LOXAIC_FAKE_MODEL_MIB;
  if (process.env.LOXAIC_FAKE_LOAD_MS) env.LOXAIC_FAKE_LOAD_MS = process.env.LOXAIC_FAKE_LOAD_MS;
  if (process.env.LOXAIC_FAKE_VRAM_STATE) env.LOXAIC_FAKE_VRAM_STATE = process.env.LOXAIC_FAKE_VRAM_STATE;
  if (process.env.LOXAIC_FAKE_RELOAD_FAIL) env.LOXAIC_FAKE_RELOAD_FAIL = process.env.LOXAIC_FAKE_RELOAD_FAIL;
  return env;
}

/**
 * What a build says its version is, or why it could not be run at all.
 *
 * Asked once per installed build, before anything else is asked of it: a
 * binary for another architecture, or one missing a library, fails here with
 * the system's own words. `--list-devices` swallows that and reports an empty
 * list, which reads as "no GPU" — the wrong problem to send an admin after.
 * llama.cpp prints the version while parsing arguments, before any backend is
 * loaded, so this costs a process start.
 */
function reportedVersion(bin: string): Promise<{ version: string | null; failure: string | null }> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        ["--version"],
        { timeout: 5000, windowsHide: true, env: childEnv(bin, "unused") },
        (err, stdout, stderr) => {
          const out = `${stdout}\n${stderr}`;
          const m = /^version:\s*(.+)$/m.exec(out);
          if (m) {
            resolve({ version: m[1].trim().slice(0, 80), failure: null });
            return;
          }
          if (!err) {
            resolve({ version: null, failure: null });
            return;
          }
          const said = stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
          resolve({ version: null, failure: (said ?? err.message).slice(0, 300) });
        },
      );
    } catch (err) {
      // A file that is not a program at all (ENOEXEC) is thrown by the spawn
      // itself rather than handed to the callback.
      resolve({ version: null, failure: notRunnable(err) });
    }
  });
}

/** Why the system would not start a binary, without the path it lives at. */
function notRunnable(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === "ENOEXEC") return "it is not a program this system can run (it may be built for another kind of machine).";
  if (code === "EACCES") return "the system refused to run it (permission denied).";
  return code ? `the system could not start it (${code}).` : "the system could not start it.";
}

const LIST_DEVICES_TIMEOUT_MS = 30_000;
const LIST_DEVICES_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The GPUs a build lists, or why the list cannot be trusted.
 *
 * A listing that was cut off — killed at its timeout, or past `maxBuffer` —
 * still calls back with the output so far, which parses as a *shorter* list.
 * Read as the whole list, that put models on a subset of the GPUs with nothing
 * saying why (#263's symptom), from builds nobody here tested (found in review).
 * A build that exits non-zero after listing is taken at its word.
 */
export function listDevicesOutcome(
  err: (Error & { code?: unknown; killed?: boolean }) | null,
  stdout: string,
  stderr: string,
): { devices: RuntimeDevice[]; error: string | null } {
  if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { devices: [], error: "llama.cpp printed too much while listing its GPUs, so the list was cut off." };
  }
  if (err?.killed) {
    return { devices: [], error: `llama.cpp took longer than ${String(LIST_DEVICES_TIMEOUT_MS / 1000)} s to list its GPUs, so the list is incomplete.` };
  }
  return { devices: parseDeviceList(`${stdout}\n${stderr}`), error: null };
}

function listDevices(bin: string): Promise<{ devices: RuntimeDevice[]; error: string | null }> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        ["--list-devices"],
        { timeout: LIST_DEVICES_TIMEOUT_MS, maxBuffer: LIST_DEVICES_MAX_BUFFER, windowsHide: true, env: childEnv(bin, "unused") },
        (err, stdout, stderr) => { resolve(listDevicesOutcome(err, stdout, stderr)); },
      );
    } catch {
      // Not a program at all: nothing to list. `reportedVersion` is what says so.
      resolve({ devices: [], error: null });
    }
  });
}

// ── Free memory, measured now ───────────────────────────────────────────────

let measuredAt = 0;
let measuring: Promise<void> | null = null;

/**
 * Re-read each device's free memory from `--list-devices`.
 *
 * The listing at router start is a snapshot, and free memory moves: another
 * program (LM Studio on the same box) loads or unloads, and so do our own
 * models. Fit labels and the decision to unload a model to make room both
 * need the figure as it is now. Cached for `maxAgeMs` and shared between
 * concurrent callers, so a screen polling every second spawns at most one
 * listing at a time. `force` always starts a listing after the call — what a
 * caller needs right after unloading a model, when an older listing still in
 * flight would describe the memory before the unload.
 *
 * Only `freeBytes` changes: the device set, and which of them are active, are
 * fixed for the router's life (changing them restarts it). A listing that
 * comes back empty is a failed listing, not a machine that lost its GPUs, and
 * is ignored. Attach mode re-reads the sidecar's file, which is only as fresh
 * as the sidecar's own start.
 */
export function remeasureDevices(opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<void> {
  const maxAgeMs = opts.maxAgeMs ?? 10_000;
  const started = opts.force
    ? (measuring ?? Promise.resolve()).then(doRemeasure, doRemeasure)
    : measuring ?? (Date.now() - measuredAt < maxAgeMs ? null : doRemeasure());
  if (!started) return Promise.resolve();
  if (started === measuring) return started;
  // Compare against the promise actually stored. Comparing against `started`
  // — which is not what `measuring` holds — never matched, so `measuring` was
  // never cleared and every later call returned the first measurement's
  // settled promise: the figures froze at the first listing. Found in review.
  const tracked: Promise<void> = started.finally(() => { if (measuring === tracked) measuring = null; });
  measuring = tracked;
  return started;
}

async function doRemeasure(): Promise<void> {
  const mode = getLlamaMode();
  if (mode === "attach") {
    await refreshAttachHealth();
    measuredAt = Date.now();
    return;
  }
  const runtime = st.runtime;
  if (mode !== "managed" || !runtime || st.flavour === "cpu" || st.devices.length === 0) return;
  const { devices: fresh, error } = await listDevices(runtime.bin);
  measuredAt = Date.now();
  // A cut-off listing keeps the last figures rather than half-updating them.
  if (error !== null || fresh.length === 0) return;
  const byName = new Map(fresh.map((d) => [d.name, d]));
  st.devices = st.devices.map((d) => {
    const now = byName.get(d.name);
    return now ? { ...d, freeBytes: now.freeBytes } : d;
  });
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Live router processes, killed synchronously if this process exits without
 * a clean shutdown — a router outliving the server would hold the GPU with
 * nothing able to reach it (its port and key die with us). */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const c of live) {
      try {
        c.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

// ── A router left by a previous process ────────────────────────────────────

function pidFile(): string {
  return path.join(path.dirname(presetPath()), "router.pid");
}

/**
 * Stop a router a previous server process left running. The exit hook above
 * covers a clean exit and a crash, but not SIGKILL — the desktop supervisor's
 * last resort after ten seconds — and an orphaned router holds the GPU with
 * nothing able to reach it (its port and key died with the parent).
 *
 * Only a process whose command line shows it is *our* router is touched:
 * `llama-server` started with this install's preset file. A pid is reused, and
 * killing whatever now holds it would be far worse than a leaked router.
 */
async function reapStaleRouter(): Promise<void> {
  if (process.platform === "win32") return;
  let pid: number;
  try {
    pid = Number((await readFile(pidFile(), "utf8")).trim());
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  const command = await new Promise<string>((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
  if (!command.includes("--models-preset") || !command.includes(presetPath())) return;
  try {
    process.kill(pid, "SIGKILL");
    console.warn(`[llama] stopped a llama.cpp router (pid ${String(pid)}) left running by a previous server process`);
  } catch {
    // already gone
  }
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** A router that dies this soon after starting counts toward giving up. */
const FAST_FAIL_MS = 30_000;
const MAX_FAST_FAILS = 5;
let fastFails = 0;
let restartTimer: NodeJS.Timeout | null = null;

async function spawnRouter(runtime: InstalledRuntime): Promise<void> {
  const port = await freePort();
  const apiKey = randomBytes(24).toString("hex");
  // `--models-max 0`: the router never unloads a model on its own. It evicts
  // by count, least recently used, with no notion of a pinned model — so
  // Loxaic decides what to unload, by memory (room.ts).
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--models-preset", presetPath(),
    "--models-max", "0",
  ];
  st.state = "starting";
  st.reason = null;
  routerLog ??= openRouterLog(routerLogPath());
  // One line per start, so a run's timings can be matched to the build and
  // devices that produced them.
  routerLog.write(`=== llama-server ${runtime.tag} (${runtime.flavour}) starting on port ${String(port)}\n`);
  const child = spawn(runtime.bin, args, {
    env: childEnv(runtime.bin, apiKey),
    cwd: path.dirname(runtime.bin),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  installExitHook();
  live.add(child);
  if (child.pid) void writeFile(pidFile(), String(child.pid)).catch(() => undefined);
  child.stdout.setEncoding("utf8").on("data", (c: string) => { recordLog(c, "stdout"); });
  child.stderr.setEncoding("utf8").on("data", (c: string) => { recordLog(c, "stderr"); });
  const startedAt = Date.now();
  // Whether this start is of a build an admin chose over the bundled one,
  // and whether it ever answered: see the exit handler.
  const chosen = getRuntimeSelection().selected.kind !== "bundled";
  let cameUp = false;
  st.child = child;
  st.port = port;
  st.apiKey = apiKey;

  child.once("exit", (code, signal) => {
    live.delete(child);
    if (st.child !== child) return;
    // Its models went with it.
    placements.ports.clear();
    placements.byName.clear();
    st.child = null;
    st.port = null;
    st.apiKey = null;
    if (st.stopping) return;
    const why = explainRouterExit(logTail.slice(-40), code, signal);
    console.error(`[llama] router stopped: ${why}`);
    if (chosen && !cameUp) {
      // A build the admin chose that never answered is not retried. The
      // retries below are for a router that was working and stopped; this one
      // most likely refuses something Loxaic asks of it (a setting it does
      // not know ends llama.cpp at boot), which trying again cannot change.
      // It stays failed, with the reason, until the admin picks another
      // version or switches back to the bundled one — never by itself.
      restart = null;
      st.state = "error";
      st.reason = why;
      return;
    }
    fastFails = Date.now() - startedAt < FAST_FAIL_MS ? fastFails + 1 : 1;
    if (fastFails >= MAX_FAST_FAILS) {
      restart = null;
      st.state = "error";
      st.reason = `${why} It failed ${String(fastFails)} times in a row, so it will not be restarted automatically — fix the cause and press Restart.`;
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (fastFails - 1));
    st.state = "starting";
    st.reason = `${why} Restarting in ${String(Math.round(delay / 1000))} s.`;
    restart = { phase: "starting", cause: "crashed", startedAt: Date.now() };
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (st.stopping || !st.runtime) return;
      void spawnRouter(st.runtime).catch((e: unknown) => {
        restart = null;
        st.state = "error";
        st.reason = e instanceof Error ? e.message : String(e);
      });
    }, delay);
    restartTimer.unref();
  });
  child.once("error", (err) => {
    recordLog(`E spawn: ${err.message}\n`);
  });

  if (await waitForHealth(port, child)) {
    cameUp = true;
    if (st.child === child) {
      st.state = "running";
      st.reason = null;
      const pass = restart;
      if (pass) pass.phase = "loading-pinned";
      void keepPinnedLoaded().finally(() => {
        if (restart === pass) restart = null;
      });
      // Only now is it safe to delete older builds: this one demonstrably runs.
      if (runtime.key !== "override") void pruneRuntimes(runtime).catch(() => undefined);
    }
  } else if (st.child === child && child.exitCode === null) {
    // Up but never healthy: treat as a failure the exit handler reports.
    child.kill("SIGKILL");
  }
}

async function stopChild(): Promise<void> {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const child = st.child;
  if (!child) return;
  st.stopping = true;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
  st.child = null;
  st.port = null;
  st.apiKey = null;
  st.stopping = false;
}

/** The admin's device choice, narrowed to devices that exist; the default set
 * when there is none. */
function chosenDevices(devices: RuntimeDevice[]): string[] {
  const known = new Set(devices.map((d) => d.name));
  const chosen = getLocalModelsSettings().devices?.filter((d) => known.has(d)) ?? [];
  return chosen.length > 0 ? chosen : defaultDevices(devices);
}

let ensuring: Promise<void> | null = null;
/** A restart asked for while an attempt was already running, run once that
 * one ends — shared by every caller who asks in the meantime. */
let queuedRestart: Promise<void> | null = null;

/**
 * Make the managed runtime run: detect the hardware, install the pinned build
 * if needed, find its devices, write the preset and start the router.
 * Concurrent callers share one attempt; a running router is left alone.
 *
 * Never falls back to the CPU. A backend that resolves to nothing ends in
 * `needs-gpu` with the reason, which is where the admin screen offers CPU as
 * an explicit, warned choice.
 */
export function ensureRuntime(opts: { restart?: boolean } = {}): Promise<void> {
  if (ensuring) {
    if (!opts.restart) return ensuring;
    // A restart answers settings written *after* the running attempt read
    // them, so handing back that attempt would drop it: switching to the CPU
    // and straight back to Automatic left the CPU running with Automatic
    // selected, because the headline says "CPU" as soon as the attempt starts
    // and the second switch landed while it was still going.
    if (getLlamaMode() === "managed") restart = { phase: "stopping", cause: "requested", startedAt: Date.now() };
    queuedRestart ??= ensuring
      .catch(() => undefined)
      .then(() => {
        queuedRestart = null;
        return ensureRuntime({ restart: true });
      });
    return queuedRestart;
  }
  if (opts.restart && getLlamaMode() === "managed") {
    // A queued restart keeps the time it was asked for.
    const since = restart?.cause === "requested" ? restart.startedAt : Date.now();
    restart = { phase: "stopping", cause: "requested", startedAt: since };
  }
  const pass = restart;
  ensuring = doEnsure(opts).finally(() => {
    ensuring = null;
    // Anything short of a running router ends the restart here: the state and
    // its reason say what happened. A running one ends it once its pinned
    // models are back (spawnRouter).
    if (restart === pass && st.state !== "running") restart = null;
  });
  return ensuring;
}

async function doEnsure(opts: { restart?: boolean }): Promise<void> {
  if (getLlamaMode() !== "managed") return;
  if (!opts.restart && (st.state === "running" || st.state === "starting") && st.child) return;
  if (opts.restart) {
    fastFails = 0;
    await stopChild();
    if (restart) restart.phase = "starting";
    // A deliberate Restart re-detects: the error it may be answering says
    // "install the Vulkan loader and restart the runtime", and a cached
    // detection would render the identical error back.
    st.hardware = null;
  }
  const settings = getLocalModelsSettings();
  st.hardware ??= await detectHardware();
  const { selected } = getRuntimeSelection();

  let flavour: BuildFlavour | null;
  if (selected.kind === "custom") {
    // A third-party build runs on the backend it was made for, which the
    // admin named when adding it. Choosing a CPU build was acknowledged then.
    const build = findCustomBuild(selected.id);
    if (!build) {
      st.runtime = null;
      st.state = "error";
      st.reason = "The third-party llama.cpp build that was chosen is no longer in the list.";
      return;
    }
    flavour = customFlavour(build.backend);
  } else {
    flavour = resolveFlavour(settings.backend, st.hardware);
    if (settings.backend === "cpu" && !settings.cpuAcknowledged) flavour = null;
  }
  st.flavour = flavour;
  if (flavour === null) {
    // Nothing runs, so nothing was listed: drop the previous run's devices,
    // or the admin screen goes on offering a GPU that is no longer there and
    // the CPU warning names it as the one being left unused.
    st.devices = [];
    st.activeDevices = [];
    st.runtime = null;
    st.state = "needs-gpu";
    st.reason = st.hardware.reason ?? "No supported GPU was found.";
    return;
  }

  // The test seam stands in for the bundled build only, so the same harness
  // can install and run a chosen one.
  const override = selected.kind === "bundled" ? binOverride() : null;
  let runtime: InstalledRuntime | null;
  if (override) {
    runtime = {
      key: "override",
      tag: RUNTIME_MANIFEST.tag,
      flavour,
      dir: path.dirname(override),
      bin: override,
      source: "bundled",
      pinned: false,
      sha256: null,
      version: null,
    };
  } else {
    runtime = await installedForSelection(selected, flavour);
    if (!runtime) {
      // Not on disk for this backend: the first install, an upgrade of the
      // bundled build, or a chosen release whose other backend is now wanted.
      st.runtime = null;
      st.state = "installing";
      st.reason = null;
      st.installProgress = { doneBytes: 0, totalBytes: 0 };
      try {
        runtime = await installSelection(selected, flavour, (p) => { st.installProgress = p; });
      } catch (err) {
        st.state = "error";
        st.reason = err instanceof Error ? err.message : String(err);
        return;
      } finally {
        st.installProgress = null;
      }
    }
    if (runtime.version === undefined) {
      const { version, failure } = await reportedVersion(runtime.bin);
      if (failure !== null && selected.kind !== "bundled") {
        // Not recorded: the next start asks again, after whatever was missing
        // has been installed.
        st.runtime = null;
        st.devices = [];
        st.activeDevices = [];
        st.state = "error";
        st.reason = `This build of llama.cpp could not be run on this machine: ${failure}`;
        return;
      }
      await recordRuntimeVersion(runtime, version);
    }
  }
  st.runtime = runtime;

  const listed = await listDevices(runtime.bin);
  st.devices = listed.devices;
  measuredAt = Date.now();
  if (flavour === "cpu") {
    st.activeDevices = "none";
  } else {
    if (listed.error !== null) {
      // Starting on part of the list would load models onto some of the GPUs.
      st.activeDevices = [];
      st.state = "error";
      st.reason = listed.error;
      return;
    }
    st.activeDevices = chosenDevices(st.devices);
    if (st.devices.length === 0) {
      // The build started but found no GPU of its kind — a missing driver, or
      // the wrong backend for this card. Running anyway would silently put
      // every model on the CPU, which is exactly what must never happen
      // without the admin choosing it.
      st.state = "error";
      st.reason =
        `The ${flavour} build of llama.cpp found no GPU it can use. ` +
        (flavour === "vulkan"
          ? "Check the GPU driver and the Vulkan loader, or pick another backend."
          : "Check the GPU driver, or pick another backend.");
      return;
    }
  }

  lastSections = new Map();
  // A fresh router has nothing loaded to restore; only pinned models come
  // back after a restart (a restart is often how an admin gets out of a bad
  // load).
  endDeferredReload();
  await syncPreset();
  await reapStaleRouter();
  await spawnRouter(runtime);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Called once at boot. Starts a router that was set up before; installs the
 * pinned build unprompted only when a previous build existed (an upgrade of
 * something the admin already chose), never on a machine that has never had
 * one — that first install waits for an admin to open the screen.
 */
export async function bootLocalRuntime(log: (m: string) => void): Promise<void> {
  const mode = getLlamaMode();
  if (mode === "off") {
    st.state = "off";
    return;
  }
  if (mode === "attach") {
    await ensureAttachKey().catch((e: unknown) => { log(`Could not write the router key: ${String(e)}`); });
    await refreshAttachHealth();
    attachTimer = setInterval(() => { void refreshAttachHealth(); }, 15_000);
    attachTimer.unref();
    await syncPreset().catch((e: unknown) => { log(`Could not write the llama.cpp preset: ${String(e)}`); });
    return;
  }
  // Under MOCK_INFERENCE the built-in provider is served by the mock, so a
  // real llama.cpp would only hold the GPU for nothing; the fake router the
  // e2e lane points at (`LOXAIC_LLAMA_SERVER_BIN`) is the one exception.
  if (process.env.MOCK_INFERENCE === "true" && !binOverride()) return;
  if (binOverride() || (await anyRuntimeInstalled())) {
    await ensureRuntime();
    if (st.state === "running") log(`llama.cpp ${st.runtime?.tag ?? RUNTIME_MANIFEST.tag} (${String(st.flavour)}) is running`);
    else if (st.reason) log(`llama.cpp is not running: ${st.reason}`);
  }
}

/**
 * Re-read what can change behind this server's back — in attach mode, the
 * sidecar's health and its device list. Called when an admin opens the screen,
 * so it shows the state now rather than as of the last 15-second tick.
 */
export async function refreshRuntimeState(): Promise<void> {
  if (getLlamaMode() === "attach") await refreshAttachHealth();
}

async function refreshAttachHealth(): Promise<void> {
  try {
    const text = await readFile(path.join(path.dirname(presetPath()), "router-devices.txt"), "utf8");
    st.devices = parseDeviceList(text);
    st.activeDevices = st.devices.length > 0 ? chosenDevices(st.devices) : "none";
    attachDevicesKnown = true;
  } catch {
    attachDevicesKnown = false;
  }
  const ep = routerEndpoint();
  if (!ep) {
    attachHealthy = false;
    return;
  }
  try {
    const res = await fetch(`${ep.nativeRoot}/health`, { signal: AbortSignal.timeout(2000) });
    attachHealthy = res.ok;
  } catch {
    attachHealthy = false;
  }
}

export async function stopLocalRuntime(): Promise<void> {
  if (attachTimer) clearInterval(attachTimer);
  attachTimer = null;
  endDeferredReload();
  await stopChild();
}

export function runtimeView(): RuntimeView {
  const mode = getLlamaMode();
  const settings = getLocalModelsSettings();
  const gpuAvailable =
    st.devices.length > 0 ? true : Boolean(st.hardware && (st.hardware.flavour !== null || st.hardware.gpus.length > 0));
  let state = st.state;
  let reason = st.reason;
  if (mode === "off") {
    state = "off";
    reason = "LLAMA_MODE is off.";
  } else if (mode === "attach") {
    state = attachHealthy === null ? "starting" : attachHealthy ? "running" : "error";
    reason = attachHealthy === false ? routerUnavailableReason() : null;
    if (attachDevicesKnown && st.devices.length === 0 && state === "running") {
      reason =
        "The llama.cpp container cannot see a GPU, so models run on the CPU. Start it with the Compose override for your GPU (docker-compose.vulkan.yml, .cuda.yml or .rocm.yml).";
    }
  }
  const chosen = getRuntimeSelection();
  const sel = chosen.selected;
  const custom = sel.kind === "custom" ? findCustomBuild(sel.id) : null;
  const tag = sel.kind === "official" ? sel.tag : sel.kind === "bundled" ? RUNTIME_MANIFEST.tag : null;
  const version: RuntimeVersionView = {
    kind: mode === "attach" ? "external" : sel.kind,
    tag: mode === "attach" ? null : tag,
    name: custom?.name ?? null,
    reported: mode === "managed" ? (st.runtime?.version ?? null) : null,
    bundledTag: RUNTIME_MANIFEST.tag,
    bundledNewer: mode === "managed" && sel.kind === "official" && olderTag(sel.tag, RUNTIME_MANIFEST.tag),
    canRevert: mode === "managed" && sel.kind !== "bundled" && !chosen.envPinned,
    envPinned: chosen.envPinned,
    customAllowed: chosen.customAllowed,
  };
  return {
    mode,
    state,
    reason: reason ?? lastReloadError,
    installProgress: st.installProgress,
    // Kept for clients from before `version`: what the card names after
    // "llama.cpp".
    tag: tag ?? custom?.name ?? RUNTIME_MANIFEST.tag,
    version,
    versionDownloads: mode === "managed" ? versionDownloads() : [],
    backend: settings.backend,
    flavour: st.flavour,
    hardware: st.hardware,
    devices: st.devices,
    activeDevices: st.activeDevices,
    gpuAvailable: mode === "attach" && attachDevicesKnown ? st.devices.length > 0 : gpuAvailable,
    cpuActive: st.flavour === "cpu" || (mode === "attach" && attachDevicesKnown && st.devices.length === 0),
    recentErrors: recentErrors(),
    // Node reads MemAvailable on Linux: memory the kernel would hand over,
    // page cache included, not just what is idle.
    hostMemory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    restart: mode === "managed" && restart ? { phase: restart.phase, cause: restart.cause, startedAt: new Date(restart.startedAt).toISOString() } : null,
  };
}

/**
 * The memory models are measured against for the fit label: the active
 * devices' total once a runtime has listed them, the hardware guess before
 * that (the same "GPUs of 4 GB or more" rule the default device set uses), and
 * system RAM when the backend is — or can only be — the CPU.
 */
export function offloadMemory(): { bytes: number | null; cpu: boolean } {
  const settings = getLocalModelsSettings();
  if (st.flavour === "cpu" || (settings.backend === "cpu" && settings.cpuAcknowledged)) {
    return { bytes: os.totalmem(), cpu: true };
  }
  if (st.devices.length > 0) {
    // Free, not total, as llama.cpp listed it at router start — memory another
    // program holds is memory a model cannot use (see defaultDevices).
    const active = st.activeDevices === "none" ? [] : st.activeDevices;
    const devs = active.length > 0 ? st.devices.filter((d) => active.includes(d.name)) : st.devices;
    return { bytes: devs.reduce((n, d) => n + d.freeBytes, 0) || null, cpu: false };
  }
  const hw = st.hardware;
  if (hw?.flavour === null && hw.gpus.length === 0) return { bytes: os.totalmem(), cpu: true };
  const known = (hw?.gpus ?? []).filter((g) => g.memoryBytes !== null);
  if (known.length === 0) return { bytes: null, cpu: false };
  const big = known.filter((g) => (g.memoryBytes ?? 0) >= 4 * 1024 ** 3);
  return { bytes: (big.length > 0 ? big : known).reduce((n, g) => n + (g.memoryBytes ?? 0), 0), cpu: false };
}

/** Whether a model is loaded (or loading) and the built-in provider has a run
 * going — the state in which unloading it would cut a conversation off. */
export async function modelBusy(id: string): Promise<boolean> {
  if (!routerEndpoint()) return false;
  const status = (await routerModelStatuses()).get(id)?.value;
  if (status !== "loaded" && status !== "loading") return false;
  return (await builtinRunsActive()) > 0;
}

/**
 * The flavour an official build would run as on this machine: the admin's
 * backend against the hardware. Not `st.flavour`, which while a third-party
 * build is chosen is that build's own.
 */
export async function officialFlavour(): Promise<BuildFlavour | null> {
  st.hardware ??= await detectHardware();
  const settings = getLocalModelsSettings();
  if (settings.backend === "cpu" && !settings.cpuAcknowledged) return null;
  return resolveFlavour(settings.backend, st.hardware);
}

/** The build the router is running, or was last started with. */
export function runningRuntime(): InstalledRuntime | null {
  return st.child ? st.runtime : null;
}

/** Hardware detection runs once per process; this lets the admin screen show
 * what was found before anything is installed. */
export async function ensureHardwareDetected(): Promise<void> {
  st.hardware ??= await detectHardware();
  if (st.flavour === null && st.state === "not-installed") {
    st.flavour = resolveFlavour(getLocalModelsSettings().backend, st.hardware);
  }
}

/** Test seam: forget everything, stopping a live router first. */
export async function __resetRouterForTest(): Promise<void> {
  await stopLocalRuntime();
  await routerLog?.close();
  routerLog = null;
  Object.assign(st, {
    state: "not-installed",
    reason: null,
    installProgress: null,
    flavour: null,
    hardware: null,
    devices: [],
    activeDevices: [],
    runtime: null,
    child: null,
    port: null,
    apiKey: null,
    stopping: false,
  } satisfies State);
  lastSections = new Map();
  endDeferredReload();
  restart = null;
  placements.ports.clear();
  placements.byName.clear();
  splitters.clear();
  queuedRestart = null;
  lastReloadError = null;
  attachHealthy = null;
  attachDevicesKnown = false;
  fastFails = 0;
  logTail.length = 0;
}

/** Test seam: the live router's pid, to kill it from outside. */
export function __routerPidForTest(): number | null {
  return st.child?.pid ?? null;
}

/** Test seam: pretend the hardware is something else. */
export function __setHardwareForTest(hw: HardwareGuess | null): void {
  st.hardware = hw;
}
