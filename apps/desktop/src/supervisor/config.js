import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-install instance configuration: which mode this desktop instance runs
 * in, and the settings that mode needs. Persisted at `<dataDir>/config.json`
 * and read by *both* entries — `main.js` (GUI) and `headless.js` — which
 * already share `defaultDataDir()`, so a machine set up through the GUI can
 * later be started headless without reconfiguring it.
 *
 * Deliberately NOT where credentials live. An external database's password
 * goes in `secrets.json` (0600, never rewritten) alongside the auth secret;
 * this file holds only the connection's shape, so it stays safe to read, log,
 * and hand to the renderer.
 *
 * Absence of the file is the first-run signal. Nothing else marks it: an
 * install that has never chosen a mode has no config, and the GUI opens
 * onboarding instead of starting a stack.
 */

/** Bumped only for a shape change that older configs can't be migrated to. */
const CURRENT_VERSION = 1;

export const MODES = ["solo", "host", "client"];

export const BINDS = ["lan", "localhost"];

/** How a client reaches its host: straight over the network, or through the
 * embedded Tailscale sidecar. Absent means direct. */
export const CLIENT_VIAS = ["direct", "tsnet"];

/** Tailscale's own limit for a node hostname. */
const TAILNET_HOSTNAME_MAX = 63;

/** The self-contained app's own default, distinct from the dev stack's 4000. */
export const DEFAULT_HOST_PORT = 4100;

/** Rejects a port outside the unprivileged, non-ephemeral-only range rather
 * than storing a value that will fail to bind (or silently NaN) at start. */
function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Port must be a whole number between 1024 and 65535");
  }
  return port;
}

function validateBind(value) {
  if (!BINDS.includes(value)) {
    throw new Error(`Bind must be one of: ${BINDS.join(", ")}`);
  }
  return value;
}

/**
 * Validates and normalises an advertised address: must parse as a bare
 * http(s) origin, with no path/query/fragment — those would silently never
 * be reached (BETTER_AUTH_URL and the cluster listing use this as an origin,
 * not a full URL) so a mistake here is caught at save time, not discovered
 * when someone else's sign-in redirect breaks.
 */
function normalizeAdvertiseUrl(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Public address must be a full URL, e.g. https://loxaic.example.com");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Public address must start with http:// or https://");
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("Public address must not include a path, query, or fragment");
  }
  return parsed.origin;
}

/**
 * A control-plane URL for a self-hosted coordination server (Headscale).
 * Same rules as the advertise URL — a bare http(s) origin — because that is
 * what tsnet's ControlURL wants; empty means Tailscale's own.
 */
export function normalizeControlUrl(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Control server URL must be a full URL, e.g. https://headscale.example.com");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Control server URL must start with http:// or https://");
  }
  return parsed.origin;
}

/**
 * The name this machine advertises on the tailnet, derived from the
 * machine's own name so it reads as "that machine" in the admin console:
 * `loxaic-` plus whatever survives Tailscale's hostname rules (lowercase
 * letters, digits, hyphens). "Casey's MacBook Pro" becomes
 * `loxaic-casey-s-macbook-pro`.
 */
export function defaultTailnetHostname(machineName = defaultHostName()) {
  const slug = String(machineName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizeTailnetHostname(slug ? `loxaic-${slug}` : "loxaic-host");
}

/** Bounds and cleans a tailnet hostname the way Tailscale itself will. */
function normalizeTailnetHostname(value) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TAILNET_HOSTNAME_MAX)
    .replace(/-+$/g, "");
  return cleaned;
}

/**
 * A host's tailnet exposure. Stored as a complete object once it has ever
 * been set — including while disabled — so that switching it off and on
 * again brings the same hostname back rather than a fresh default.
 *
 * `authKey` is deliberately not part of this: it is a credential and goes to
 * secrets.json, never here (config.json is read by the renderer and safe to
 * log). It is stripped even if a caller passes it, so no path can persist it
 * by accident.
 */
function normalizeTailnet(input, previous) {
  if (input === undefined) return previous ? { ...previous } : undefined;
  if (input === null) return undefined;
  if (typeof input !== "object") throw new Error("tailnet settings must be an object");
  const enabled = Boolean(input.enabled);
  const hostname = normalizeTailnetHostname(input.hostname ?? previous?.hostname ?? "") || defaultTailnetHostname();
  const tailnet = {
    enabled,
    hostname,
    funnel: Boolean(input.funnel ?? previous?.funnel ?? false),
  };
  const controlUrl = normalizeControlUrl(input.controlUrl ?? previous?.controlUrl);
  if (controlUrl) tailnet.controlUrl = controlUrl;
  return tailnet;
}

/**
 * What the sidecar dials for a tsnet client, derived from the host URL the
 * person typed. `https://box.tail1234.ts.net` is the normal case — a host
 * serving through its own sidecar (or Tailscale Serve) on :443 with a real
 * certificate — but a plain `http://box.tail1234.ts.net:4100` (a host reached
 * by Tailscale IP with no TLS in front) is legitimate too, so the scheme
 * decides both the port default and whether the sidecar speaks TLS.
 */
export function tsnetTargetFor(hostUrl) {
  const parsed = new URL(hostUrl);
  const tls = parsed.protocol === "https:";
  const port = parsed.port || (tls ? "443" : "80");
  return { target: `${parsed.hostname}:${port}`, tls };
}

export function configPath(dataDir) {
  return path.join(dataDir, "config.json");
}

/**
 * A host's display name — how users tell one machine from another when they
 * pick a model or look at the cluster. Defaults to the machine's hostname
 * because that is the name the user already knows it by; onboarding offers it
 * pre-filled and editable rather than deciding silently.
 */
export function defaultHostName() {
  const raw = os.hostname().replace(/\.local$/i, "").trim();
  return raw || "Loxaic Host";
}

/**
 * Reads the stored config, or returns null when this install has never been
 * configured. A malformed or future-versioned file also reads as null: the
 * onboarding flow can always rebuild it, which is a far better outcome than a
 * boot failure the user cannot clear from inside the app.
 */
export function loadConfig(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(configPath(dataDir), "utf8"));
    if (parsed.version !== CURRENT_VERSION) return null;
    if (!MODES.includes(parsed.mode)) return null;
    if (typeof parsed.instanceId !== "string" || !parsed.instanceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConfig(dataDir, config) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath(dataDir), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return config;
}

/**
 * Builds a complete config from what onboarding collected, filling in
 * everything the caller left out.
 *
 * `instanceId` is minted once and carried across every later mode change: it
 * is this machine's identity in the `hosts` table, so regenerating it on a
 * Solo→Host switch would register a second host for the same machine.
 */
export function buildConfig(input, previous = null) {
  const mode = input.mode;
  if (!MODES.includes(mode)) throw new Error(`Unknown instance mode: ${String(mode)}`);

  const config = {
    version: CURRENT_VERSION,
    mode,
    instanceId: previous?.instanceId ?? randomUUID(),
  };

  if (mode === "host" || mode === "solo") {
    const host = input.host ?? {};
    const previousHost = previous?.host ?? {};
    config.host = {
      name: (host.name ?? previousHost.name ?? defaultHostName()).slice(0, 64),
      port: validatePort(host.port ?? previousHost.port ?? DEFAULT_HOST_PORT),
      // Solo never leaves the machine, so it binds loopback whatever the
      // caller says; only a Host has a reason to accept remote connections.
      bind: mode === "solo" ? "localhost" : validateBind(host.bind ?? previousHost.bind ?? "lan"),
      db: host.db ?? previousHost.db ?? { kind: "embedded" },
    };
    // Solo never inherits a previous Host's advertiseUrl. The loopback bind
    // above would otherwise be outranked by it: BETTER_AUTH_URL derives from
    // the advertised URL, so sign-in on a machine that only talks to itself
    // would point at an external address nothing is listening on — and
    // registerHost would keep publishing that dead address into the cluster.
    const advertiseUrl = normalizeAdvertiseUrl(
      mode === "solo" ? host.advertiseUrl : (host.advertiseUrl ?? previousHost.advertiseUrl),
    );
    if (advertiseUrl) config.host.advertiseUrl = advertiseUrl;

    // Solo never gets a tailnet section, for the same reason it never gets
    // an advertiseUrl: it is "this machine only", and a node on the tailnet
    // is exactly a machine other devices can reach.
    if (mode === "host") {
      const tailnet = normalizeTailnet(host.tailnet, previousHost.tailnet);
      if (tailnet) config.host.tailnet = tailnet;
    }
  }

  if (mode === "client") {
    const client = input.client ?? {};
    const hostUrl = client.hostUrl;
    if (typeof hostUrl !== "string" || !hostUrl.trim()) {
      throw new Error("Client mode needs the host's URL");
    }
    config.client = { hostUrl: hostUrl.trim().replace(/\/+$/, "") };
    const via = client.via ?? "direct";
    if (!CLIENT_VIAS.includes(via)) {
      throw new Error(`Client connection must be one of: ${CLIENT_VIAS.join(", ")}`);
    }
    if (via === "tsnet") {
      // The sidecar derives what to dial from this URL, so it has to be one
      // it can parse now rather than one that fails at spawn time.
      try {
        tsnetTargetFor(config.client.hostUrl);
      } catch {
        throw new Error("A Tailscale host address must be a full URL, e.g. https://box.tail1234.ts.net");
      }
      config.client.via = "tsnet";
      const controlUrl = normalizeControlUrl(client.controlUrl);
      if (controlUrl) config.client.controlUrl = controlUrl;
    }
  }

  return config;
}

/**
 * What the renderer is allowed to see of a stored host config — never the
 * database URL or password (those live in secrets.json and in `db.url`
 * respectively, decrypted only in the supervisor). Returns null for a config
 * with no host section (client mode, or no config at all), so a caller can
 * pass `config?.host` through unconditionally.
 */
export function hostSettingsView(hostConfig) {
  if (!hostConfig) return null;
  return {
    name: hostConfig.name,
    port: hostConfig.port,
    bind: hostConfig.bind,
    advertiseUrl: hostConfig.advertiseUrl ?? null,
    db: { kind: hostConfig.db?.kind ?? "embedded" },
    // Safe to show whole: the auth key was never stored in here.
    tailnet: hostConfig.tailnet ? { ...hostConfig.tailnet } : null,
  };
}

/** The client-mode counterpart of hostSettingsView. */
export function clientSettingsView(clientConfig) {
  if (!clientConfig) return null;
  return {
    hostUrl: clientConfig.hostUrl,
    via: clientConfig.via ?? "direct",
    controlUrl: clientConfig.controlUrl ?? null,
  };
}

/**
 * The URL other machines should use to reach this host. An explicit
 * `advertiseUrl` wins (a reverse proxy or tailnet name the user knows better
 * than we do); otherwise it is derived from the bind choice.
 *
 * This is what `BETTER_AUTH_URL` is set from, so getting it wrong is not
 * cosmetic: better-auth builds its callback URLs and cookie domain from it,
 * and a host pinned to `localhost` while serving LAN clients rejects them.
 */
export function advertiseUrlFor(hostConfig) {
  if (hostConfig.advertiseUrl) return hostConfig.advertiseUrl.replace(/\/+$/, "");
  const port = hostConfig.port ?? DEFAULT_HOST_PORT;
  if (hostConfig.bind === "localhost") return `http://localhost:${String(port)}`;
  const address = firstLanAddress();
  return `http://${address ?? "localhost"}:${String(port)}`;
}

/** The bind address passed to the server, derived from the mode's needs. */
export function bindHostFor(hostConfig) {
  return hostConfig.bind === "localhost" ? "127.0.0.1" : "0.0.0.0";
}

/** First non-internal IPv4 address — the one a LAN client would dial. */
export function firstLanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}
