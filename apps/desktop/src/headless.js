#!/usr/bin/env -S node
// Plain-Node entry point for the self-contained stack, no window, no
// Chromium. Never imports "electron" — this is what lets a systemd unit run
// it with ELECTRON_RUN_AS_NODE=1 set on the packaged binary and never
// initialise a display, so headless installs (Proxmox VM/LXC) need no xvfb.
//
// Also reachable as `Open-Shannon --headless` (see main.js), which re-execs
// itself into this same file for a display-having machine's convenience.
import "./cwd-guard.js";
import os from "node:os";
import { startStack } from "./supervisor/index.js";
import { defaultDataDir } from "./supervisor/paths.js";
import { buildConfig, loadConfig, saveConfig } from "./supervisor/config.js";

const HELP = `Usage: open-shannon-headless [options]

Runs the self-contained Shannon stack (embedded Postgres + server) with no
window, for server installs.

Options:
  --port <n>          Server port (default: 4100, or $SHANNON_PORT).
                       --shannon-port also accepted (same flag the GUI uses).
  --host <addr>        Bind address (default: from config.json, else 0.0.0.0)
  --data-dir <path>    Data directory (default: platform user-data dir, or
                       $SHANNON_DATA_DIR). --shannon-data-dir also accepted.
  --as-host            Configure this install as a Host (serves other users)
                       and persist it, then start. Requires a container engine.
  --host-name <name>   Name shown against this host's models (default: hostname)
  --inference-url <u>  Inference backend base URL (sets INFERENCE_BASE_URL)
  --mock-inference     Use the mock inference provider (sets MOCK_INFERENCE=true)
  --help               Show this help and exit

Instance mode is read from <data-dir>/config.json — the same file the desktop
app writes — so a machine set up through the GUI restarts headless unchanged.
Headless *client* mode (joining someone else's host) is not supported yet.
`;

/**
 * Value of a --name <value> or --name=value CLI flag, or undefined.
 * Accepts any of several equivalent names — main.js's GUI mode and this
 * standalone entry document slightly different flag names for the same
 * option (`--shannon-port` vs `--port`), and `Open-Shannon --headless
 * --shannon-port=X` forwards whatever the user typed verbatim, so both must
 * resolve to the same value here or the flag silently falls back to default.
 */
function getFlag(...names) {
  for (const name of names) {
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const idx = process.argv.indexOf(`--${name}`);
    if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function listAddresses(port) {
  const addrs = ["localhost"];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs.map((a) => `http://${a}:${String(port)}`);
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    process.stdout.write(HELP);
    return;
  }

  if (hasFlag("inference-url")) process.env.INFERENCE_BASE_URL = getFlag("inference-url");
  if (hasFlag("mock-inference")) process.env.MOCK_INFERENCE = "true";

  const dataDir = getFlag("data-dir", "shannon-data-dir") ?? process.env.SHANNON_DATA_DIR ?? defaultDataDir();

  // Headless client mode ("like OpenCode") is a later feature — #73 defers it
  // explicitly. Say so rather than silently starting a *host*, which is what
  // ignoring the flag would do: the opposite of what was asked for, on a
  // machine the user meant to keep stateless.
  if (hasFlag("client") || getFlag("client")) {
    console.error(
      "Headless client mode isn't supported yet — a headless instance always hosts.\n" +
        "Use the desktop app to join a host, or run this instance with --host.",
    );
    process.exit(2);
  }

  // The instance config the GUI wrote (shared dataDir, so a machine set up
  // through the app can be restarted headless without reconfiguring it).
  // `--host` forces host mode for a machine that has never seen the GUI.
  let instance = loadConfig(dataDir);
  if (hasFlag("host-mode") || hasFlag("as-host")) {
    instance = buildConfig({ mode: "host", host: { name: getFlag("host-name") } }, instance);
    saveConfig(dataDir, instance);
  }
  if (instance?.mode === "client") {
    console.error(
      `This install is configured as a client of ${String(instance.client.hostUrl)}.\n` +
        "Headless client mode isn't supported yet — run --as-host to convert it, or use the desktop app.",
    );
    process.exit(2);
  }

  const port = Number(
    getFlag("port", "shannon-port") ?? process.env.SHANNON_PORT ?? instance?.host?.port ?? 4100,
  );
  const host = getFlag("host") ?? undefined;

  const stack = await startStack({
    dataDir,
    port,
    host,
    log: (line) => { console.log(line); },
    instance,
  });

  console.log("Open Shannon is running:");
  for (const url of listAddresses(stack.port)) console.log(`  ${url}`);
  console.log(`Data directory: ${dataDir}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received — shutting down`);
    stack.stop().then(
      () => process.exit(0),
      (err) => { console.error(err); process.exit(1); },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
