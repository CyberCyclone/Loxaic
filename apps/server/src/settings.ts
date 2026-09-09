/**
 * Server-level settings: values that configure the whole deployment rather
 * than one user, persisted in the `server_settings` table and editable by an
 * admin through the GUI.
 *
 * Precedence is always **env > persisted > default**. An environment variable
 * pins its field: the API refuses to write it and the GUI renders it
 * read-only. That keeps the packaged desktop supervisor, Docker Compose, and
 * a systemd unit authoritative when they set something explicitly, while a
 * deployment that sets nothing is fully configurable from the UI.
 *
 * Reads are synchronous against an in-memory cache loaded once at boot
 * (`loadServerSettings()`), because `getSandboxMode()` is called on every
 * sandbox operation and is sync by contract. Before the cache loads — and in
 * tests that never load it — resolution falls back to env > default, which is
 * exactly the behaviour that existed before this table.
 */
import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import type { SandboxKind, SandboxMode } from "./sandbox/provider.ts";

/** Which container engine to talk to. "auto" is the historical discovery
 * behaviour (try the default Docker socket, then Podman's, then Colima's);
 * the rest pin a specific one. */
export type SandboxEngine = "auto" | "docker" | "podman" | "custom";

export interface SandboxSettings {
  mode: SandboxMode;
  engine: SandboxEngine;
  /** Socket path used when `engine` is "custom" (Colima, OrbStack, a remote
   * socket, or a CONTAINER_SOCKET pin). */
  customSocket: string | null;
  /** Give sandbox containers network access. Off by default: everything the
   * model produces runs in there, so an outbound network is an exfiltration
   * path. Host-mode sandboxes always have the host's network regardless. */
  allowNetwork: boolean;
  /**
   * How long a conversation's sandbox may sit unused before it is **stopped**
   * — paused with its filesystem intact, resumed by the next tool call.
   *
   * Generous by default (4h) because stopping is the cheap half of the
   * lifecycle: a stopped container costs disk, not memory or CPU, and the cost
   * of stopping too eagerly is a container start on the user's next message.
   */
  idleStopMs: number;
  /**
   * Whether long-unused sandboxes are eventually **destroyed**.
   *
   * This is the only timer in the system that can delete someone's work, so it
   * is separately switchable: an admin who would rather buy disks than lose a
   * checkout turns it off, and nothing else changes.
   */
  reapEnabled: boolean;
  /** How long a sandbox may go unused before {@link reapEnabled} destroys it. */
  reapAfterMs: number;
}

export interface SandboxSettingsView extends SandboxSettings {
  /** Fields pinned by an environment variable. The GUI shows these as
   * "set by environment" and disables their controls; PATCH rejects them. */
  envOverrides: {
    mode: boolean;
    socket: boolean;
    allowNetwork: boolean;
    idleStop: boolean;
    reapEnabled: boolean;
    reapAfter: boolean;
  };
}

export type SandboxSettingsPatch = Partial<{
  mode: SandboxMode;
  engine: SandboxEngine;
  customSocket: string | null;
  allowNetwork: boolean;
  idleStopMs: number;
  reapEnabled: boolean;
  reapAfterMs: number;
}>;

/**
 * How many agent/chat runs may hold the inference backend at once.
 *
 * Its own settings group rather than a field on the sandbox one: it is about
 * the model server, not about where tool calls execute, and the two are
 * routinely different machines.
 */
export interface InferenceSettings {
  /**
   * Null means "follow the backend" — ask llama.cpp how many slots it has and
   * assume one when it will not say. A number pins it.
   *
   * Null is the default because the right answer is a property of the backend
   * rather than a preference: it is exactly `--parallel`, and claiming more
   * slots than the backend has restores the prompt-cache thrashing the queue
   * exists to prevent — invisibly, as "everything is slow" rather than as an
   * error.
   */
  maxConcurrentRuns: number | null;
}

export interface InferenceSettingsView extends InferenceSettings {
  envOverrides: { maxConcurrentRuns: boolean };
}

/** Row keys for the two settings groups. */
const SANDBOX_KEY = "sandbox";
const INFERENCE_KEY = "inference";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Accepted range for `idleStopMs` through the API. A minute is the floor
 * because anything shorter would stop a sandbox mid-task on a slow model;
 * a month is the ceiling, which is "effectively never" without giving the
 * field an unbounded value to store. Env pins are not bounded — a harness
 * that wants an immediate stop is the reason they exist. */
const IDLE_STOP_RANGE = { min: 60_000, max: 30 * DAY_MS };
/** Accepted range for `reapAfterMs`: an hour to ten years. */
const REAP_AFTER_RANGE = { min: HOUR_MS, max: 3650 * DAY_MS };

const DEFAULTS: SandboxSettings = {
  mode: "container",
  engine: "auto",
  customSocket: null,
  allowNetwork: false,
  idleStopMs: 4 * HOUR_MS,
  reapEnabled: true,
  reapAfterMs: 30 * DAY_MS,
};

export class SettingsError extends Error {
  // Assigned in the body rather than as a constructor parameter property:
  // those are erasable-syntax-incompatible, and this repo runs raw TS under
  // Node's strip-only mode in some paths (see AGENTS.md).
  readonly code: "invalid" | "envOverride";

  constructor(message: string, code: "invalid" | "envOverride") {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

let persisted: Partial<SandboxSettings> = {};
let persistedInference: Partial<InferenceSettings> = {};
/**
 * True when this server is hosting for other users (the desktop supervisor
 * sets `LOXAIC_HOSTING=1` for Host mode).
 *
 * Read at call time, never at module load, matching every other env reader
 * here — the supervisor builds its child env late.
 */
export function isHosting(): boolean {
  return process.env.LOXAIC_HOSTING === "1";
}

/**
 * Hosting for other users requires **container** sandbox isolation.
 *
 * Host mode (`SANDBOX_MODE=host`) runs model-directed commands directly on
 * the machine with the host's own filesystem and network; `off` disables
 * tools but leaves no isolation story for a future switch. Neither is
 * defensible once someone else's chats execute here, so a hosting server
 * refuses to start rather than serving strangers from an unisolated box.
 *
 * Returns the reason it must not start, or null when it may. Solo installs
 * keep the full off/host/container flexibility — the requirement lands on
 * exactly the deployments that carry other people's work.
 */
export function hostingBlockedReason(): string | null {
  if (!isHosting()) return null;
  // Read through getSandboxSettings() rather than provider.ts's
  // getSandboxMode(): that module imports this one, and this is the same
  // resolved value it would return.
  const { mode } = getSandboxSettings();
  if (mode === "container") return null;
  return (
    `Host mode requires the container sandbox, but SANDBOX_MODE resolves to "${mode}". ` +
    `Hosting runs other users' agent commands on this machine, and neither "host" ` +
    `(no isolation) nor "off" is safe for that. Install Docker or Podman and set the ` +
    `sandbox mode to "container", or run this instance in Solo mode.`
  );
}

/** Set when loadServerSettings() couldn't read the row — see there. */
let loadFailed = false;

// ── Environment reads ─────────────────────────────────────
// All at call time, never cached at module load, so a supervisor can set the
// child's env before the first sandbox use without an import-order trap.

/** `FOO=` in a .env file yields "", which must read as unset, not as a value. */
function envStr(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

let badModeWarned = false;

function envMode(): SandboxMode | null {
  const value = envStr("SANDBOX_MODE");
  if (value === undefined) return null;
  if (value === "host" || value === "off" || value === "container") return value;
  if (!badModeWarned) {
    badModeWarned = true;
    console.warn(`[settings] ignoring unrecognized SANDBOX_MODE="${value}" (expected container|host|off)`);
  }
  return null;
}

function envSocket(): string | null {
  return envStr("CONTAINER_SOCKET") ?? null;
}

function envAllowNetwork(): boolean | null {
  const value = envStr("SANDBOX_ALLOW_NETWORK")?.toLowerCase();
  if (value === undefined) return null;
  return value === "1" || value === "true" || value === "yes";
}

/** Durations are pinned in milliseconds rather than the hours/days the GUI
 * shows, so a test harness can ask for a one-second idle stop — the whole
 * reason these pins exist. Deliberately not range-checked the way the API is:
 * an env pin is the operator speaking directly. */
function envPositiveInt(name: string): number | null {
  const raw = envStr(name);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    warnOnce(name, `[settings] ignoring ${name}="${raw}" (expected a positive integer of milliseconds)`);
    return null;
  }
  return value;
}

function envReapEnabled(): boolean | null {
  const value = envStr("SANDBOX_REAP_ENABLED")?.toLowerCase();
  if (value === undefined) return null;
  return value === "1" || value === "true" || value === "yes";
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// ── Resolution ────────────────────────────────────────────

export function getSandboxSettings(): SandboxSettingsView {
  const mode = envMode();
  const socket = envSocket();
  const allowNetwork = envAllowNetwork();
  const idleStopMs = envPositiveInt("SANDBOX_IDLE_STOP_MS");
  const reapEnabled = envReapEnabled();
  const reapAfterMs = envPositiveInt("SANDBOX_REAP_AFTER_MS");

  // Fail *closed* when the settings row couldn't be read: falling through to
  // DEFAULTS.mode ("container") would silently restart agent execution that
  // an admin had deliberately turned off. An explicit env pin still wins —
  // it's authoritative and readable without the database.
  const storedMode = loadFailed ? "off" : (persisted.mode ?? DEFAULTS.mode);

  // CONTAINER_SOCKET pins *which socket*, which is what `engine` +
  // `customSocket` express together — so an env socket surfaces as the
  // "custom" engine and both fields count as overridden by the one variable.
  return {
    mode: mode ?? storedMode,
    engine: socket !== null ? "custom" : (persisted.engine ?? DEFAULTS.engine),
    customSocket: socket ?? persisted.customSocket ?? DEFAULTS.customSocket,
    allowNetwork: allowNetwork ?? persisted.allowNetwork ?? DEFAULTS.allowNetwork,
    idleStopMs: idleStopMs ?? persisted.idleStopMs ?? DEFAULTS.idleStopMs,
    reapEnabled: reapEnabled ?? persisted.reapEnabled ?? DEFAULTS.reapEnabled,
    reapAfterMs: reapAfterMs ?? persisted.reapAfterMs ?? DEFAULTS.reapAfterMs,
    envOverrides: {
      mode: mode !== null,
      socket: socket !== null,
      allowNetwork: allowNetwork !== null,
      idleStop: idleStopMs !== null,
      reapEnabled: reapEnabled !== null,
      reapAfter: reapAfterMs !== null,
    },
  };
}

// ── Inference settings ────────────────────────────────────

/**
 * Resolved run-concurrency setting: env pin > persisted > null ("ask the
 * backend"). Sync like the sandbox reads, and for the same reason — the
 * scheduler consults it on every acquire.
 */
export function getInferenceSettings(): InferenceSettingsView {
  const pinned = envPositiveInt("INFERENCE_MAX_CONCURRENT_RUNS");
  return {
    maxConcurrentRuns: pinned ?? persistedInference.maxConcurrentRuns ?? null,
    envOverrides: { maxConcurrentRuns: pinned !== null },
  };
}

function coerceInference(raw: unknown): Partial<InferenceSettings> {
  if (typeof raw !== "object" || raw === null) return {};
  const value = (raw as Record<string, unknown>).maxConcurrentRuns;
  if (value === null) return { maxConcurrentRuns: null };
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { maxConcurrentRuns: value };
  }
  return {};
}

/** Accepted range. The ceiling is not a resource limit — it is a sanity bound
 * on a field whose whole point is to match a backend's slot count, and no
 * local backend has dozens. */
const MAX_CONCURRENT_RANGE = { min: 1, max: 64 };

export async function updateInferenceSettings(input: unknown): Promise<InferenceSettingsView> {
  if (typeof input !== "object" || input === null) {
    throw new SettingsError("body must be an object", "invalid");
  }
  const raw = (input as Record<string, unknown>).maxConcurrentRuns;
  if (raw === undefined) throw new SettingsError("nothing to update", "invalid");
  if (getInferenceSettings().envOverrides.maxConcurrentRuns) {
    throw new SettingsError(
      "maxConcurrentRuns is pinned by the INFERENCE_MAX_CONCURRENT_RUNS environment variable",
      "envOverride",
    );
  }
  // null is a real value here, not an absent one: it is how an admin says
  // "go back to following the backend".
  if (raw !== null) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw new SettingsError("maxConcurrentRuns must be an integer or null", "invalid");
    }
    if (raw < MAX_CONCURRENT_RANGE.min || raw > MAX_CONCURRENT_RANGE.max) {
      throw new SettingsError(
        `maxConcurrentRuns must be between ${String(MAX_CONCURRENT_RANGE.min)} and ${String(MAX_CONCURRENT_RANGE.max)}`,
        "invalid",
      );
    }
  }

  const next: InferenceSettings = { maxConcurrentRuns: raw };
  await db
    .insert(serverSettings)
    .values({ key: INFERENCE_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: next, updatedAt: new Date() } });
  persistedInference = next;
  return getInferenceSettings();
}

/**
 * The retention terms, as a conversation's owner needs to read them.
 *
 * A single accessor rather than three call sites reaching into settings,
 * because these three numbers only mean anything together: "paused after 4h,
 * deleted after 30 days unused" is the sentence a user has to be shown before
 * they start putting work somewhere.
 */
export interface SandboxRetention {
  idleStopMs: number;
  reapEnabled: boolean;
  reapAfterMs: number;
}

export function getSandboxRetention(): SandboxRetention {
  const { idleStopMs, reapEnabled, reapAfterMs } = getSandboxSettings();
  return { idleStopMs, reapEnabled, reapAfterMs };
}

/**
 * When a sandbox last used at `lastUsedAt` would be destroyed, or null when
 * reaping is off.
 *
 * Derived on read, never stored. A stored date would be a promise the settings
 * screen can silently break: an admin moving the policy from 30 days to 7
 * would leave every existing row still advertising the old date, and the row
 * the user was shown would not be the one the reaper acts on.
 */
export function sandboxReapAt(lastUsedAt: Date): Date | null {
  const { reapEnabled, reapAfterMs } = getSandboxRetention();
  if (!reapEnabled) return null;
  return new Date(lastUsedAt.getTime() + reapAfterMs);
}

// ── Load / persist ────────────────────────────────────────

function coerce(raw: unknown): Partial<SandboxSettings> {
  if (typeof raw !== "object" || raw === null) return {};
  const value = raw as Record<string, unknown>;
  const out: Partial<SandboxSettings> = {};
  if (value.mode === "container" || value.mode === "host" || value.mode === "off") out.mode = value.mode;
  if (value.engine === "auto" || value.engine === "docker" || value.engine === "podman" || value.engine === "custom") {
    out.engine = value.engine;
  }
  if (typeof value.customSocket === "string") out.customSocket = value.customSocket;
  if (typeof value.allowNetwork === "boolean") out.allowNetwork = value.allowNetwork;
  if (typeof value.idleStopMs === "number" && Number.isFinite(value.idleStopMs) && value.idleStopMs > 0) {
    out.idleStopMs = value.idleStopMs;
  }
  if (typeof value.reapEnabled === "boolean") out.reapEnabled = value.reapEnabled;
  if (typeof value.reapAfterMs === "number" && Number.isFinite(value.reapAfterMs) && value.reapAfterMs > 0) {
    out.reapAfterMs = value.reapAfterMs;
  }
  return out;
}

/**
 * Loads persisted settings into the in-memory cache. Called once at boot,
 * after migrations.
 *
 * A read failure is non-fatal to boot but is NOT treated as "no settings":
 * that distinction matters because migrations only warn in non-strict mode,
 * so a missing `server_settings` table reaches exactly this path — and
 * quietly resolving to the permissive default would re-enable sandboxes an
 * admin had disabled. `getSandboxSettings()` resolves mode to "off" while
 * this flag is set.
 */
export async function loadServerSettings(): Promise<void> {
  try {
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, SANDBOX_KEY) });
    persisted = coerce(row?.value);
    loadFailed = false;
    warnOnRetentionPair();
  } catch (err) {
    persisted = {};
    loadFailed = true;
    console.error(
      "[settings] could not read server_settings — agent sandboxes are disabled until this is fixed: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  // Read in the same pass, but not the same `try`. A failure here is
  // deliberately *not* fail-closed the way the sandbox read is: unreadable
  // settings leave run concurrency null, which means "ask the backend", which
  // is what a fresh install gets anyway. There is nothing here to disable —
  // and in particular it must not disable sandboxes, whose row has already
  // been read by this point. Sharing the sandbox read's `catch` did exactly
  // that: a blip on this second query forced sandbox mode to "off" until the
  // next restart.
  try {
    const inferenceRow = await db.query.serverSettings.findFirst({
      where: eq(serverSettings.key, INFERENCE_KEY),
    });
    persistedInference = coerceInference(inferenceRow?.value);
  } catch (err) {
    persistedInference = {};
    console.error(
      "[settings] could not read inference settings — run concurrency falls back to the backend probe: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** The one place an env-pinned `SANDBOX_REAP_AFTER_MS <= SANDBOX_IDLE_STOP_MS`
 * is reported: the API refuses to write either field while pinned, so a
 * warning at load is the only message an operator can act on. The reaper
 * still runs — deleting sooner than pausing is wrong, not fatal. */
function warnOnRetentionPair(): void {
  const s = getSandboxSettings();
  if (s.reapAfterMs <= s.idleStopMs) {
    console.warn(
      `[settings] SANDBOX_REAP_AFTER_MS (${String(s.reapAfterMs)}) is not longer than SANDBOX_IDLE_STOP_MS ` +
        `(${String(s.idleStopMs)}) — sandboxes may be deleted before they are paused`,
    );
  }
}

/** Why sandboxes report unavailable when mode is "off". Names the actual
 * source: telling an admin who disabled them through the API to go check an
 * environment variable that isn't set would send them the wrong way. */
export function sandboxDisabledReason(): string {
  if (envMode() !== null) return "sandboxes are disabled by the SANDBOX_MODE environment variable";
  if (loadFailed) return "server settings could not be read — sandboxes are disabled until the database is reachable";
  return "sandboxes are disabled in server settings";
}

/** Shared narrowing for the two duration fields: same shape of error, same
 * env-pin refusal, and a range check so the GUI cannot store a value the
 * reapers would treat as pathological. Rejects rather than clamping — a
 * client that asked for a two-second idle stop should be told it did not get
 * one. */
function duration(
  raw: unknown,
  field: string,
  range: { min: number; max: number },
  pinned: boolean,
  envName: string,
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new SettingsError(`${field} must be an integer number of milliseconds`, "invalid");
  }
  if (raw < range.min || raw > range.max) {
    throw new SettingsError(
      `${field} must be between ${String(range.min)} and ${String(range.max)} ms`,
      "invalid",
    );
  }
  if (pinned) throw new SettingsError(`${field} is pinned by the ${envName} environment variable`, "envOverride");
  return raw;
}

/** Narrows untrusted JSON (straight off the wire) into a patch we're willing
 * to persist, rejecting both malformed values and any field this deployment
 * pins through the environment. */
function validate(input: unknown): SandboxSettingsPatch {
  if (typeof input !== "object" || input === null) {
    throw new SettingsError("body must be an object", "invalid");
  }
  const raw = input as Record<string, unknown>;
  const env = getSandboxSettings().envOverrides;
  const patch: SandboxSettingsPatch = {};

  if (raw.mode !== undefined) {
    if (raw.mode !== "container" && raw.mode !== "host" && raw.mode !== "off") {
      throw new SettingsError("mode must be one of container, host, off", "invalid");
    }
    if (env.mode) throw new SettingsError("mode is pinned by the SANDBOX_MODE environment variable", "envOverride");
    // The hosting invariant has two paths that can change the mode — boot and
    // this write — and hostingBlockedReason() guards only the first. Without
    // this, an admin on a live Host could switch to "host" and run every other
    // user's commands unisolated on the machine immediately, or to "off" and
    // brick the next boot. Same shape as the envOverride refusal: the field is
    // pinned, here by what this instance is rather than by its environment.
    if (isHosting() && raw.mode !== "container") {
      throw new SettingsError(
        `this instance hosts for other users, so only the container sandbox is permitted (got "${raw.mode}")`,
        "invalid",
      );
    }
    patch.mode = raw.mode;
  }

  if (raw.engine !== undefined) {
    if (raw.engine !== "auto" && raw.engine !== "docker" && raw.engine !== "podman" && raw.engine !== "custom") {
      throw new SettingsError("engine must be one of auto, docker, podman, custom", "invalid");
    }
    if (env.socket) {
      throw new SettingsError("engine is pinned by the CONTAINER_SOCKET environment variable", "envOverride");
    }
    patch.engine = raw.engine;
  }

  if (raw.customSocket !== undefined) {
    if (raw.customSocket !== null && typeof raw.customSocket !== "string") {
      throw new SettingsError("customSocket must be a string or null", "invalid");
    }
    if (env.socket) {
      throw new SettingsError("customSocket is pinned by the CONTAINER_SOCKET environment variable", "envOverride");
    }
    patch.customSocket = raw.customSocket;
  }

  if (raw.allowNetwork !== undefined) {
    if (typeof raw.allowNetwork !== "boolean") {
      throw new SettingsError("allowNetwork must be a boolean", "invalid");
    }
    if (env.allowNetwork) {
      throw new SettingsError("allowNetwork is pinned by the SANDBOX_ALLOW_NETWORK environment variable", "envOverride");
    }
    patch.allowNetwork = raw.allowNetwork;
  }

  if (raw.idleStopMs !== undefined) {
    patch.idleStopMs = duration(raw.idleStopMs, "idleStopMs", IDLE_STOP_RANGE, env.idleStop, "SANDBOX_IDLE_STOP_MS");
  }

  if (raw.reapEnabled !== undefined) {
    if (typeof raw.reapEnabled !== "boolean") {
      throw new SettingsError("reapEnabled must be a boolean", "invalid");
    }
    if (env.reapEnabled) {
      throw new SettingsError("reapEnabled is pinned by the SANDBOX_REAP_ENABLED environment variable", "envOverride");
    }
    patch.reapEnabled = raw.reapEnabled;
  }

  if (raw.reapAfterMs !== undefined) {
    patch.reapAfterMs = duration(raw.reapAfterMs, "reapAfterMs", REAP_AFTER_RANGE, env.reapAfter, "SANDBOX_REAP_AFTER_MS");
  }

  // Destroying a sandbox sooner than it is paused would mean deleting one that
  // is still in active use — the two timers would be racing over the same
  // sandbox. Checked against the *resolved* pair, not just the patch, so
  // lowering one to below the other's existing value is caught too.
  //
  // Only when the patch touches one of the two, though. An inconsistent pair
  // pinned by the environment cannot be fixed through this API (both fields
  // 409), and checking it on every write would then reject unrelated ones —
  // including `{ mode: "off" }`, the one call an admin makes to stop
  // execution while sorting the misconfiguration out. That pair is reported
  // at load time instead (loadServerSettings).
  const resolved = getSandboxSettings();
  if (patch.idleStopMs !== undefined || patch.reapAfterMs !== undefined) {
    const idleStop = patch.idleStopMs ?? resolved.idleStopMs;
    const reapAfter = patch.reapAfterMs ?? resolved.reapAfterMs;
    if (reapAfter <= idleStop) {
      throw new SettingsError(
        "reapAfterMs must be longer than idleStopMs — sandboxes are paused before they are ever deleted",
        "invalid",
      );
    }
  }

  // "custom" without a socket would silently fall back to auto-discovery,
  // which is not what picking Custom in the GUI means.
  const engine = patch.engine ?? resolved.engine;
  const socket = patch.customSocket !== undefined ? patch.customSocket : resolved.customSocket;
  if (engine === "custom" && !socket) {
    throw new SettingsError("customSocket is required when engine is custom", "invalid");
  }

  return patch;
}

/**
 * Validates, persists, and applies a sandbox settings change.
 *
 * "Applies" matters: the container provider caches the engine connection it
 * discovered and only rediscovers when a ping *fails*, so switching Docker →
 * Podman while Docker is still running would otherwise keep using Docker
 * forever. Live sandboxes are stopped too, since neither the engine nor a
 * container's network mode can be changed under a running container.
 */
export async function updateSandboxSettings(input: unknown): Promise<SandboxSettingsView> {
  // Serialized: `next` is built from the in-memory `persisted` before the
  // first await, so two concurrent PATCHes would both read the same base and
  // the second would silently drop the first's field.
  const run = writeChain.catch(() => undefined).then(() => performUpdate(input));
  writeChain = run.catch(() => undefined);
  return run;
}

let writeChain: Promise<unknown> = Promise.resolve();

async function performUpdate(input: unknown): Promise<SandboxSettingsView> {
  const patch = validate(input);

  const before = getSandboxSettings();
  const next: SandboxSettings = {
    ...DEFAULTS,
    ...persisted,
    ...patch,
  };

  await db
    .insert(serverSettings)
    .values({ key: SANDBOX_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: next, updatedAt: new Date() } });
  persisted = next;

  const after = getSandboxSettings();
  const changed =
    before.mode !== after.mode ||
    before.engine !== after.engine ||
    before.customSocket !== after.customSocket ||
    before.allowNetwork !== after.allowNetwork;
  if (changed && applyEnabled) await applySandboxSettings(before, after);
  return after;
}

/**
 * Which sandbox kinds a change actually invalidates.
 *
 * Deliberately narrow. Stopping a sandbox no longer destroys it, so the stakes
 * are lower than they were — but sweeping a kind the change cannot affect
 * still interrupts other users mid-task and costs them a container start, and
 * the engine, socket, and network toggle are all container-only concerns.
 */
function invalidatedKinds(before: SandboxSettingsView, after: SandboxSettingsView): SandboxKind[] {
  const kinds = new Set<SandboxKind>();
  // The engine a container lives in, and the NetworkMode fixed at its
  // creation — neither can change under a running container.
  if (
    before.engine !== after.engine ||
    before.customSocket !== after.customSocket ||
    before.allowNetwork !== after.allowNetwork
  ) {
    kinds.add("container");
  }
  // Switching away from a mode retires that mode's sandboxes — turning host
  // mode off has to actually stop host sandboxes, that being the whole point.
  if (before.mode !== after.mode && before.mode !== "off") kinds.add(before.mode);
  return [...kinds];
}

/** Imported dynamically to keep this module free of a static cycle with the
 * sandbox layer (provider.ts imports this file for getSandboxMode()), the
 * same approach provider.ts already uses to reach its providers. */
async function applySandboxSettings(
  before: SandboxSettingsView,
  after: SandboxSettingsView,
): Promise<void> {
  // Order matters, and it is the opposite of the intuitive one. Stopping a
  // container sandbox means attaching to it *through the engine that created
  // it*; resetting the cache first sends those attach calls to the NEW
  // engine, which has never heard of those containers. The stop 404s (and is
  // swallowed), the row is still marked stopped, and the old container keeps
  // running with nothing left that can find it — the boot-time orphan sweep
  // only lists containers on the currently-configured engine. So: stop while
  // the old engine is still cached, then reset.
  const { stopAllSandboxes } = await import("./agent/sandbox-manager.ts");
  // The extraction pool (files/extract.ts) is a *second*, independent set of
  // live sandboxes that stopAllSandboxes knows nothing about — it only walks
  // the conversation ones. Left out, an engine change strands pooled
  // containers on the old engine where the boot sweep can never find them
  // (it lists only the configured engine's), a host→container switch leaks
  // per-user directories holding uploaded documents, and a switch to "off"
  // leaves extraction quietly working against a still-live sandbox. It has no
  // per-kind bookkeeping, so any invalidation stops all of it.
  const { stopAllExtractionSandboxes } = await import("./files/extract.ts");
  const kinds = invalidatedKinds(before, after);
  if (kinds.length > 0) await stopAllExtractionSandboxes().catch(() => 0);
  for (const kind of kinds) {
    await stopAllSandboxes(kind).catch(() => 0);
  }
  const { resetEngineCache } = await import("./sandbox/container-provider.ts");
  resetEngineCache();
}

/** Test seam: drops the in-memory cache so a suite can assert the
 * env-and-defaults path without a database. */
export function resetServerSettingsCache(): void {
  persisted = {};
  persistedInference = {};
  loadFailed = false;
}

/** Test seam: simulates a failed settings read, for asserting the
 * fail-closed behaviour without breaking the database. */
export function __setLoadFailedForTest(value: boolean): void {
  loadFailed = value;
}

let applyEnabled = true;

/**
 * Test seam: suppresses the live-sandbox teardown a settings change performs.
 *
 * That teardown is global by nature — it stops every running sandbox of the
 * affected kind — and these suites share one Postgres and one container
 * engine with suites running in parallel, so a persistence test that changes
 * a value would otherwise stop the MCP e2e suite's live container mid-run.
 * Only persistence-focused tests should use this; anything asserting the
 * apply behaviour itself must leave it on.
 */
export function __setSandboxApplyForTest(value: boolean): void {
  applyEnabled = value;
}
