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
import { db, eq } from "@shannon/db";
import { serverSettings } from "@shannon/db/schema";
import type { SandboxMode } from "./sandbox/provider.ts";

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

  // CONTAINER_SOCKET pins *which socket*, which is what `engine` +
  // `customSocket` express together — so an env socket surfaces as the
  // "custom" engine and both fields count as overridden by the one variable.
  return {
    mode: mode ?? persisted.mode ?? DEFAULTS.mode,
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

/** Loads persisted settings into the in-memory cache. Called once at boot,
 * after migrations. A missing table or unreachable DB is not fatal — the
 * server still runs on env + defaults, the same as before this table
 * existed. */
export async function loadServerSettings(): Promise<void> {
  try {
    const row = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, SANDBOX_KEY) });
    persisted = coerce(row?.value);
  } catch {
    persisted = {};
  }
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
  const patch = validate(input);

  const before = getSandboxSettings();
  const next: SandboxSettings = {
    mode: patch.mode ?? persisted.mode ?? DEFAULTS.mode,
    engine: patch.engine ?? persisted.engine ?? DEFAULTS.engine,
    customSocket: patch.customSocket !== undefined ? patch.customSocket : (persisted.customSocket ?? DEFAULTS.customSocket),
    allowNetwork: patch.allowNetwork ?? persisted.allowNetwork ?? DEFAULTS.allowNetwork,
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
  if (changed) await applySandboxSettings();
  return after;
}

/** Imported dynamically to keep this module free of a static cycle with the
 * sandbox layer (provider.ts imports this file for getSandboxMode()), the
 * same approach provider.ts already uses to reach its providers. */
async function applySandboxSettings(): Promise<void> {
  const { resetEngineCache } = await import("./sandbox/container-provider.ts");
  resetEngineCache();
  const { stopAllSandboxes } = await import("./agent/sandbox-manager.ts");
  await stopAllSandboxes().catch(() => 0);
}

/** Test seam: drops the in-memory cache so a suite can assert the
 * env-and-defaults path without a database. */
export function resetServerSettingsCache(): void {
  persisted = {};
}
