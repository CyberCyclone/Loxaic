import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import serve from "electron-serve";

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
 * Order: embedded-Tailscale local proxy (if TSNET_TARGET is configured and
 * the sidecar comes up) → first LAN/tailnet candidate that answers /health →
 * localhost:4000 (dev-friendly default; a Settings override in the renderer
 * still wins over all of this once the app has loaded).
 */
async function resolveApiBaseUrl() {
  const tsnetTarget = process.env.TSNET_TARGET;
  const viaTsnet = await startTsnetProxy(tsnetTarget);
  if (viaTsnet) return viaTsnet;

  const candidates = [process.env.EXPO_PUBLIC_LAN_API_URL, process.env.EXPO_PUBLIC_API_URL].filter(Boolean);
  const results = await Promise.all(candidates.map(probeHealth));
  const winner = candidates.find((_, i) => results[i]);
  if (winner) return winner;

  return "http://localhost:4000";
}

let mainWindow = null;

async function createWindow() {
  const apiBaseUrl = await resolveApiBaseUrl();
  console.log(`[shannon] API base URL: ${apiBaseUrl}`);

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

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!mainWindow) createWindow(); });
