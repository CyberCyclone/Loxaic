import "./cwd-guard.js";
import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serve from "electron-serve";
import { startStack } from "./supervisor/index.js";
import { defaultDataDir } from "./supervisor/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// Prod: serves the Expo static web export (apps/mobile's `export:web` output)
// through the custom app:// scheme with SPA fallback baked in. Never
// loadFile()/file://: expo-router's client-side routing uses the History API
// and every asset path is absolute (/_expo/...), both of which break under
// file:// (no server to fall back to index.html, and absolute paths resolve
// against the filesystem root instead of the bundle root).
const loadWebBuild = serve({ directory: getWebDistPath() });

/** Where the built Expo web export lives, dev vs packaged. */
function getWebDistPath() {
  if (isDev) return path.join(__dirname, "../../mobile/dist");
  return path.join(process.resourcesPath, "web");
}

/** Where the per-OS tsnet-proxy sidecar binary lives, dev vs packaged. */
function getTsnetProxyPath() {
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch;
  const ext = platform === "win32" ? ".exe" : "";
  const name = `tsnet-proxy-${platform}-${arch}${ext}`;
  const dir = isDev
    ? path.join(__dirname, "../resources/tsnet-proxy")
    : path.join(process.resourcesPath, "tsnet-proxy");
  return path.join(dir, name);
}

const PROBE_TIMEOUT_MS = 1500;
const TSNET_START_TIMEOUT_MS = 5000;

/** Value of a --name=value CLI flag, or undefined. */
function getFlag(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function probeHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the tsnet sidecar if a tailnet target is configured, and returns the
 * local proxy URL once it reports its bound port — or null if unconfigured,
 * the binary is missing, or it doesn't come up within TSNET_START_TIMEOUT_MS.
 * A stalled/failed sidecar must never block startup: the caller falls back
 * to direct LAN/tailnet probing below.
 */
function startTsnetProxy(target) {
  return new Promise((resolve) => {
    if (!target) return resolve(null);
    const binPath = getTsnetProxyPath();
    if (!existsSync(binPath)) {
      console.warn(`[shannon] tsnet-proxy binary not found at ${binPath}; skipping embedded Tailscale`);
      return resolve(null);
    }

    const stateDir = path.join(app.getPath("userData"), "tsnet");
    const child = spawn(binPath, ["--target", target, "--state-dir", stateDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      console.warn(`[shannon] tsnet-proxy did not report a listener within ${TSNET_START_TIMEOUT_MS}ms; falling back`);
      resolve(null);
    }, TSNET_START_TIMEOUT_MS);

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const listening = line.match(/^LISTENING (.+)$/);
      if (listening) {
        clearTimeout(timer);
        resolve(`http://${listening[1]}`);
        return;
      }
      const auth = line.match(/^AUTH_URL (\S+)$/);
      if (auth) {
        console.log(`[shannon] Tailscale needs approval for this device: ${auth[1]}`);
        shell.openExternal(auth[1]);
      }
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => console.log(`[tsnet-proxy] ${line}`));

    child.on("error", (err) => {
      console.warn(`[shannon] tsnet-proxy failed to start: ${err.message}`);
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      if (code !== 0) console.warn(`[shannon] tsnet-proxy exited with code ${code}`);
    });

    app.on("before-quit", () => child.kill());
  });
}

/**
 * Resolves the API base URL the renderer should use. There is no server at
 * the app:// (or, in dev, http://localhost:8081) origin the window loads
 * from, so — unlike the mobile/web builds, which can assume same-origin —
 * Electron must always supply this explicitly.
 *
 * Client-only modes come first (they mean "connect to a Shannon somewhere
 * else"): --remote=<url> / SHANNON_REMOTE_URL → embedded-Tailscale local
 * proxy (TSNET_TARGET) → first LAN/tailnet candidate that answers /health →
 * in dev, a running dev server on :4000 (so `pnpm dev` workflows are
 * untouched). Otherwise the app is self-contained: the supervisor brings up
 * embedded Postgres + the bundled server (default port 4100). A Settings
 * override in the renderer still wins over all of this once the app loads.
 */
async function resolveApi() {
  const remote = getFlag("remote") ?? process.env.SHANNON_REMOTE_URL;
  if (remote) return { apiBaseUrl: remote, stack: null };

  const viaTsnet = await startTsnetProxy(process.env.TSNET_TARGET);
  if (viaTsnet) return { apiBaseUrl: viaTsnet, stack: null };

  const candidates = [process.env.EXPO_PUBLIC_LAN_API_URL, process.env.EXPO_PUBLIC_API_URL].filter(Boolean);
  const results = await Promise.all(candidates.map(probeHealth));
  const winner = candidates.find((_, i) => results[i]);
  if (winner) return { apiBaseUrl: winner, stack: null };

  if (isDev && await probeHealth("http://localhost:4000")) {
    return { apiBaseUrl: "http://localhost:4000", stack: null };
  }

  const stack = await startStack({
    dataDir: getFlag("shannon-data-dir") ?? process.env.SHANNON_DATA_DIR ?? defaultDataDir(),
    port: Number(getFlag("shannon-port") ?? process.env.SHANNON_PORT ?? 4100),
    log: (line) => { console.log(`[shannon] ${line}`); },
  });
  return { apiBaseUrl: stack.apiBaseUrl, stack };
}

let mainWindow = null;
let stack = null;
let apiBaseUrl = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#18181b",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [`--shannon-api-base-url=${encodeURIComponent(apiBaseUrl)}`],
    },
  });

  if (isDev) {
    await mainWindow.loadURL("http://localhost:8081");
  } else {
    await loadWebBuild(mainWindow);
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    ({ apiBaseUrl, stack } = await resolveApi());
  } catch (err) {
    dialog.showErrorBox(
      "Open Shannon failed to start",
      err instanceof Error ? err.message : String(err),
    );
    app.exit(1);
    return;
  }
  console.log(`[shannon] API base URL: ${apiBaseUrl}`);
  await createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!mainWindow && apiBaseUrl) createWindow(); });

// Quit must wait for the embedded stack: the server needs to drain against a
// live database, and Postgres needs a clean shutdown — a fire-and-forget
// kill here would leave the cluster to crash-recover on next launch.
let quitting = false;
app.on("before-quit", (event) => {
  if (!stack || quitting) return;
  event.preventDefault();
  quitting = true;
  stack.stop().finally(() => { app.exit(0); });
});
