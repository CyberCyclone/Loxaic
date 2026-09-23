import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
import { presetPath } from "./paths.ts";
import { renderPreset, sectionsById, writePreset, type PresetGlobals } from "./preset.ts";
import {
  anyRuntimeInstalled,
  binOverride,
  installedRuntime,
  installRuntime,
  pruneRuntimes,
  RUNTIME_MANIFEST,
  type InstalledRuntime,
  type InstallProgress,
} from "./runtime.ts";
import { getLlamaMode, getLocalModelsSettings, type LlamaBackend, type LlamaMode } from "./settings.ts";

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
  /** The pinned upstream build, e.g. `b11149`. */
  tag: string;
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

/** Attach mode's last health answer, refreshed on a timer and on demand. */
let attachHealthy: boolean | null = null;
/** Attach mode: whether the sidecar has recorded what `--list-devices` found
 * (infra/docker/llama-router.sh writes it into the shared volume). Until it
 * has, "no devices" means "not told", never "running on the CPU". */
let attachDevicesKnown = false;
let attachTimer: NodeJS.Timeout | null = null;

// ── Log capture ─────────────────────────────────────────────────────────────

const LOG_LINES = 200;
const logTail: string[] = [];

function recordLog(chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    logTail.push(line);
    if (logTail.length > LOG_LINES) logTail.shift();
  }
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
    return { apiBase: `${root}/v1`, nativeRoot: root, apiKey: process.env.LLAMA_API_KEY?.trim() ? process.env.LLAMA_API_KEY : null };
  }
  if (st.state !== "running" || st.port === null) return null;
  const root = `http://127.0.0.1:${String(st.port)}`;
  return { apiBase: `${root}/v1`, nativeRoot: root, apiKey: st.apiKey };
}

/** The sentence a request to the built-in provider fails with when there is no
 * router — instead of "connection refused" to an address nobody configured. */
export function routerUnavailableReason(): string {
  const mode = getLlamaMode();
  if (mode === "off") return "Local models are turned off on this server. Pick a model from a provider instead.";
  if (mode === "attach") {
    return process.env.LLAMA_ROUTER_URL
      ? "The model server is not answering. Ask an admin to check the llama.cpp container."
      : "LLAMA_MODE is attach, but LLAMA_ROUTER_URL is not set. Ask an admin to fix the server's configuration.";
  }
  if (st.state === "installing" || st.state === "starting") {
    return "The built-in model runtime is still starting up. Try again in a moment.";
  }
  return "The built-in model runtime isn't running. An admin can set it up under Settings > Local models.";
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

/** The router's view of every preset model, or an empty map when it cannot be
 * asked. Never throws — a listing must not fail because the router is down. */
export async function routerModelStatuses(): Promise<Map<string, RouterModelStatus>> {
  const out = new Map<string, RouterModelStatus>();
  try {
    const res = await routerFetch("/models", {}, 2000);
    if (!res.ok) return out;
    const body = (await res.json()) as { data?: { id?: string; status?: { value?: string; failed?: boolean } }[] };
    for (const m of body.data ?? []) {
      if (typeof m.id !== "string") continue;
      out.set(m.id, { id: m.id, value: m.status?.value ?? "unloaded", failed: m.status?.failed === true });
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
    const res = await routerFetch(`/props?model=${encodeURIComponent(id)}&autoload=false`, {}, 2000);
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
    await routerFetch("/models/unload", { method: "POST", body: JSON.stringify({ model: id }) });
  } catch {
    // Not loaded, or no router — either way it is not holding memory.
  }
}

// ── The preset and live reloads ─────────────────────────────────────────────

let lastSections = new Map<string, string>();
let reloadPending = false;
let reloadTimer: NodeJS.Timeout | null = null;
let lastReloadError: string | null = null;

function presetGlobals(): PresetGlobals {
  return { devices: st.activeDevices === "none" ? "none" : st.activeDevices.length > 0 ? st.activeDevices : null };
}

/** How busy the built-in provider is. Imported lazily: the scheduler reaches
 * the model layer, which reaches this module. */
async function builtinRunsActive(): Promise<number> {
  const { schedulerState } = await import("../inference/scheduler.ts");
  return schedulerState(DEFAULT_PROVIDER_ID).running;
}

async function reloadNow(): Promise<void> {
  try {
    const res = await routerFetch("/models?reload=1", {}, 10_000);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastReloadError = `llama.cpp refused the model list (HTTP ${String(res.status)}): ${text.slice(0, 300)}`;
      console.error(`[llama] ${lastReloadError}`);
      return;
    }
    lastReloadError = null;
  } catch (err) {
    // No router yet: it reads the file when it starts.
    lastReloadError = null;
    void err;
  }
}

function scheduleDeferredReload(): void {
  reloadPending = true;
  if (reloadTimer) return;
  reloadTimer = setInterval(() => {
    void (async () => {
      if (!reloadPending) return;
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
}

/**
 * Rewrite the preset from the database and have the router re-read it.
 *
 * The router unloads a model whose section changed. Adding or removing a
 * section is harmless to a running conversation, but changing one that is
 * loaded mid-run is not — so that case waits until the built-in provider is
 * idle.
 */
export async function syncPreset(): Promise<SyncResult> {
  const mode = getLlamaMode();
  if (mode === "off") return { deferred: false };
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
  if (!routerEndpoint()) return { deferred: false };

  if (changed.length > 0) {
    const statuses = await routerModelStatuses();
    const touchesLoaded = changed.some((id) => {
      const s = statuses.get(id)?.value;
      return s === "loaded" || s === "loading";
    });
    if (touchesLoaded && (await builtinRunsActive()) > 0) {
      scheduleDeferredReload();
      return { deferred: true };
    }
  }
  await reloadNow();
  return { deferred: false };
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
  return env;
}

function listDevices(bin: string): Promise<RuntimeDevice[]> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--list-devices"],
      { timeout: 30_000, windowsHide: true, env: childEnv(bin, "unused") },
      (_err, stdout, stderr) => { resolve(parseDeviceList(`${stdout}\n${stderr}`)); },
    );
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
  const modelsMax = getLocalModelsSettings().modelsMax;
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--models-preset", presetPath(),
    "--models-max", String(modelsMax),
  ];
  st.state = "starting";
  st.reason = null;
  const child = spawn(runtime.bin, args, {
    env: childEnv(runtime.bin, apiKey),
    cwd: path.dirname(runtime.bin),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  installExitHook();
  live.add(child);
  if (child.pid) void writeFile(pidFile(), String(child.pid)).catch(() => undefined);
  child.stdout.setEncoding("utf8").on("data", recordLog);
  child.stderr.setEncoding("utf8").on("data", recordLog);
  const startedAt = Date.now();
  st.child = child;
  st.port = port;
  st.apiKey = apiKey;

  child.once("exit", (code, signal) => {
    live.delete(child);
    if (st.child !== child) return;
    st.child = null;
    st.port = null;
    st.apiKey = null;
    if (st.stopping) return;
    const why = explainRouterExit(logTail.slice(-40), code, signal);
    console.error(`[llama] router stopped: ${why}`);
    fastFails = Date.now() - startedAt < FAST_FAIL_MS ? fastFails + 1 : 1;
    if (fastFails >= MAX_FAST_FAILS) {
      st.state = "error";
      st.reason = `${why} It failed ${String(fastFails)} times in a row, so it will not be restarted automatically — fix the cause and press Restart.`;
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (fastFails - 1));
    st.state = "starting";
    st.reason = `${why} Restarting in ${String(Math.round(delay / 1000))} s.`;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (st.stopping || !st.runtime) return;
      void spawnRouter(st.runtime).catch((e: unknown) => {
        st.state = "error";
        st.reason = e instanceof Error ? e.message : String(e);
      });
    }, delay);
    restartTimer.unref();
  });
  child.once("error", (err) => {
    recordLog(`E spawn: ${err.message}`);
  });

  if (await waitForHealth(port, child)) {
    if (st.child === child) {
      st.state = "running";
      st.reason = null;
      // Only now is it safe to delete older builds: this one demonstrably runs.
      if (!binOverride()) void pruneRuntimes(runtime).catch(() => undefined);
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
  if (ensuring) return ensuring;
  ensuring = doEnsure(opts).finally(() => { ensuring = null; });
  return ensuring;
}

async function doEnsure(opts: { restart?: boolean }): Promise<void> {
  if (getLlamaMode() !== "managed") return;
  if (!opts.restart && (st.state === "running" || st.state === "starting") && st.child) return;
  if (opts.restart) {
    fastFails = 0;
    await stopChild();
  }
  const settings = getLocalModelsSettings();
  st.hardware ??= await detectHardware();
  const override = binOverride();

  let flavour: BuildFlavour | null = resolveFlavour(settings.backend, st.hardware);
  if (settings.backend === "cpu" && !settings.cpuAcknowledged) flavour = null;
  st.flavour = flavour;
  if (flavour === null) {
    st.state = "needs-gpu";
    st.reason = st.hardware.reason ?? "No supported GPU was found.";
    return;
  }

  let runtime: InstalledRuntime | null;
  if (override) {
    runtime = { key: "override", tag: "override", flavour, dir: path.dirname(override), bin: override };
  } else {
    runtime = await installedRuntime(flavour);
    if (!runtime) {
      st.state = "installing";
      st.reason = null;
      st.installProgress = { doneBytes: 0, totalBytes: 0 };
      try {
        runtime = await installRuntime(flavour, (p) => { st.installProgress = p; });
      } catch (err) {
        st.state = "error";
        st.reason = err instanceof Error ? err.message : String(err);
        return;
      } finally {
        st.installProgress = null;
      }
    }
  }
  st.runtime = runtime;

  st.devices = await listDevices(runtime.bin);
  if (flavour === "cpu") {
    st.activeDevices = "none";
  } else {
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
    await refreshAttachHealth();
    attachTimer = setInterval(() => { void refreshAttachHealth(); }, 15_000);
    attachTimer.unref();
    await syncPreset().catch((e: unknown) => { log(`Could not write the llama.cpp preset: ${String(e)}`); });
    return;
  }
  if (binOverride() || (await anyRuntimeInstalled())) {
    await ensureRuntime();
    if (st.state === "running") log(`llama.cpp ${RUNTIME_MANIFEST.tag} (${String(st.flavour)}) is running`);
    else if (st.reason) log(`llama.cpp is not running: ${st.reason}`);
  }
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
  if (reloadTimer) clearInterval(reloadTimer);
  reloadTimer = null;
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
  return {
    mode,
    state,
    reason: reason ?? lastReloadError,
    installProgress: st.installProgress,
    tag: RUNTIME_MANIFEST.tag,
    backend: settings.backend,
    flavour: st.flavour,
    hardware: st.hardware,
    devices: st.devices,
    activeDevices: st.activeDevices,
    gpuAvailable: mode === "attach" && attachDevicesKnown ? st.devices.length > 0 : gpuAvailable,
    cpuActive: st.flavour === "cpu" || (mode === "attach" && attachDevicesKnown && st.devices.length === 0),
    recentErrors: recentErrors(),
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
  reloadPending = false;
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
