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
}

export interface SandboxSettingsView extends SandboxSettings {
  /** Fields pinned by an environment variable. The GUI shows these as
   * "set by environment" and disables their controls; PATCH rejects them. */
  envOverrides: { mode: boolean; socket: boolean; allowNetwork: boolean };
}

export type SandboxSettingsPatch = Partial<{
  mode: SandboxMode;
  engine: SandboxEngine;
  customSocket: string | null;
  allowNetwork: boolean;
}>;

/** Row key for the sandbox settings group. */
const SANDBOX_KEY = "sandbox";

const DEFAULTS: SandboxSettings = {
  mode: "container",
  engine: "auto",
  customSocket: null,
  allowNetwork: false,
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

// ── Resolution ────────────────────────────────────────────

export function getSandboxSettings(): SandboxSettingsView {
  const mode = envMode();
  const socket = envSocket();
  const allowNetwork = envAllowNetwork();

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
    envOverrides: {
      mode: mode !== null,
      socket: socket !== null,
      allowNetwork: allowNetwork !== null,
    },
  };
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
  } catch (err) {
    persisted = {};
    loadFailed = true;
    console.error(
      "[settings] could not read server_settings — agent sandboxes are disabled until this is fixed: " +
        (err instanceof Error ? err.message : String(err)),
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

  // "custom" without a socket would silently fall back to auto-discovery,
  // which is not what picking Custom in the GUI means.
  const current = getSandboxSettings();
  const engine = patch.engine ?? current.engine;
  const socket = patch.customSocket !== undefined ? patch.customSocket : current.customSocket;
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
 * Deliberately narrow. A host sandbox's `stop()` deletes its working
 * directory, so sweeping a kind the change cannot affect would destroy other
 * users' in-progress work for no reason — the engine, socket, and network
 * toggle are all container-only concerns.
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
