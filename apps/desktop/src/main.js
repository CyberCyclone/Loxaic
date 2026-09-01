import "./cwd-guard.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `Open-Shannon --headless` re-execs itself as plain Node running
// headless.js — the exact same entry a systemd unit invokes directly via
// ELECTRON_RUN_AS_NODE=1. This must happen before any other import: Electron
// and electron-serve both have module-scope side effects (electron-serve
// registers its app:// scheme at import time), and none of that belongs in a
// process that will never touch Chromium.
if (process.argv.includes("--headless")) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "headless.js"), ...process.argv.slice(2).filter((a) => a !== "--headless")],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
  // Forward Ctrl-C / termination to the child instead of letting this
  // wrapper process die first and orphan it.
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
} else {
  await runGui();
}

async function runGui() {
  const { app, BrowserWindow, ipcMain, shell } = await import("electron");
  const { createInterface } = await import("node:readline");
  const { existsSync, rmSync } = await import("node:fs");
  const { default: serve } = await import("electron-serve");
  const { startStack } = await import("./supervisor/index.js");
  const { defaultDataDir } = await import("./supervisor/paths.js");
  const {
    DEFAULT_HOST_PORT,
    buildConfig,
    defaultHostName,
    firstLanAddress,
    configPath,
    loadConfig,
    saveConfig,
  } = await import("./supervisor/config.js");

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
   * **Environment and flags still win over the stored mode.** `--remote` /
   * `SHANNON_REMOTE_URL` / `TSNET_TARGET` / the LAN+tailnet probes / a dev
   * server on :4000 are all "someone told this launch exactly where to point",
   * and they keep working untouched — the e2e harness and every scripted
   * workflow depend on them. Only when none of them applies does config.json
   * decide, and only when *that* is absent does the app open onboarding.
   */
  async function resolveApi() {
    const remote = getFlag("remote") ?? process.env.SHANNON_REMOTE_URL;
    if (remote) return { apiBaseUrl: remote, stack: null, mode: "client" };

    const viaTsnet = await startTsnetProxy(process.env.TSNET_TARGET);
    if (viaTsnet) return { apiBaseUrl: viaTsnet, stack: null, mode: "client" };

    const candidates = [process.env.EXPO_PUBLIC_LAN_API_URL, process.env.EXPO_PUBLIC_API_URL].filter(Boolean);
    const results = await Promise.all(candidates.map(probeHealth));
    const winner = candidates.find((_, i) => results[i]);
    if (winner) return { apiBaseUrl: winner, stack: null, mode: "client" };

    if (isDev && await probeHealth("http://localhost:4000")) {
      return { apiBaseUrl: "http://localhost:4000", stack: null, mode: "client" };
    }

    // Stored instance mode. Absent = this install has never been configured,
    // which is the *only* first-run signal there is: the window opens on
    // onboarding with no stack started, rather than silently self-hosting.
    const config = loadConfig(dataDir());
    if (!config) return { apiBaseUrl: null, stack: null, mode: null };
    return startForConfig(config);
  }

  /** Brings up whatever the stored config asks for. */
  async function startForConfig(config) {
    if (config.mode === "client") {
      return { apiBaseUrl: config.client.hostUrl, stack: null, mode: "client" };
    }
    const started = await startStack({
      dataDir: dataDir(),
      port: Number(getFlag("shannon-port") ?? process.env.SHANNON_PORT ?? config.host?.port ?? DEFAULT_HOST_PORT),
      log: (line) => { console.log(`[shannon] ${line}`); },
      instance: config,
    });
    return { apiBaseUrl: started.apiBaseUrl, stack: started, mode: config.mode };
  }

  function dataDir() {
    return getFlag("shannon-data-dir") ?? process.env.SHANNON_DATA_DIR ?? defaultDataDir();
  }

  let mainWindow = null;
  let stack = null;
  let apiBaseUrl = null;
  let instanceMode = null;
  let startupError = null;

  /** Everything the renderer needs to decide what to show. */
  function stackState() {
    return {
      mode: instanceMode,
      apiBaseUrl,
      // The one thing onboarding keys on: no stored config means show the
      // mode chooser rather than the app.
      needsOnboarding: instanceMode === null,
      defaultHostName: defaultHostName(),
      defaultPort: DEFAULT_HOST_PORT,
      lanAddress: firstLanAddress(),
      ...(startupError ? { error: startupError } : {}),
    };
  }

  function pushStackState() {
    mainWindow?.webContents.send("shannon:stackState", stackState());
  }

  /**
   * Tears the current stack down and brings up whatever `config` asks for,
   * then tells the renderer where to point.
   *
   * Stop-before-start is not optional: both stacks would bind the same port,
   * and the embedded Postgres holds a data directory that only one server may
   * own. The renderer follows via the pushed state rather than an app
   * restart — `endpoint.ts` re-resolves on the event.
   */
  async function applyConfig(config) {
    const previous = stack;
    stack = null;
    apiBaseUrl = null;
    instanceMode = null;
    if (previous) await previous.stop().catch(() => undefined);

    saveConfig(dataDir(), config);
    const started = await startForConfig(config);
    startupError = null;
    stack = started.stack;
    apiBaseUrl = started.apiBaseUrl;
    instanceMode = started.mode;
    pushStackState();
    return stackState();
  }

  /**
   * The app's first IPC surface. Everything here is main-process-only work the
   * renderer cannot do for itself: reading and writing the instance config,
   * probing for a container engine, and starting or stopping the embedded
   * stack. Nothing here takes a path or a command from the renderer.
   */
  function registerIpc() {
    ipcMain.handle("shannon:getState", () => stackState());

    ipcMain.handle("shannon:setMode", async (_event, input) => {
      const config = buildConfig(input ?? {}, loadConfig(dataDir()));
      return applyConfig(config);
    });

    // Is a container engine reachable? Host mode requires one — the server
    // refuses to boot otherwise — so onboarding checks before committing the
    // user to a mode that would fail at startup.
    ipcMain.handle("shannon:probeEngine", async () => {
      const { probeContainerEngine } = await import("./supervisor/engine-probe.js");
      return probeContainerEngine();
    });

    // Does this URL serve a Shannon? Returns the cluster so the join screen can
    // name what the user is about to connect to instead of echoing their URL.
    ipcMain.handle("shannon:probeHost", async (_event, url) => {
      if (typeof url !== "string" || !url.trim()) return { ok: false, reason: "No URL given" };
      const base = url.trim().replace(/\/+$/, "");
      try {
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!health.ok) return { ok: false, reason: `Server answered ${String(health.status)}` };
        const res = await fetch(`${base}/v1/cluster`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return { ok: true, url: base };
        const body = await res.json();
        return { ok: true, url: base, cluster: body.cluster, hosts: body.hosts };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    });

    // Validates external-database credentials before they are committed, so a
    // typo surfaces on the form rather than as a failed boot.
    ipcMain.handle("shannon:testDb", async (_event, input) => {
      const { testDatabase } = await import("./supervisor/db-test.js");
      return testDatabase(input ?? {}, dataDir());
    });

    // Leave the current host: forget the stored config and return to
    // onboarding. Deliberately does NOT delete the data directory — a Host
    // that detaches keeps its own database.
    ipcMain.handle("shannon:detach", async () => {
      const previous = stack;
      stack = null;
      apiBaseUrl = null;
      instanceMode = null;
      if (previous) await previous.stop().catch(() => undefined);
      // Removing the config *is* the detach: absence is the first-run signal,
      // so the next resolve lands on onboarding. The instanceId is lost with
      // it, which is correct — re-joining later is a fresh registration, and
      // keeping a stale id would let this machine claim a host row in a
      // cluster it has left.
      rmSync(configPath(dataDir()), { force: true });
      pushStackState();
      return stackState();
    });
  }

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
        // Empty when the app opens on onboarding: there is no server yet.
        // The renderer treats that as "ask the user", and gets the real URL
        // over shannon:stackState once a mode is chosen.
        additionalArguments: [`--shannon-api-base-url=${encodeURIComponent(apiBaseUrl ?? "")}`],
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
    registerIpc();
    try {
      ({ apiBaseUrl, stack, mode: instanceMode } = await resolveApi());
    } catch (err) {
      // A configured install that cannot start (an unreachable external
      // database, a Host with no container engine) must still open its
      // window: the error is actionable from onboarding, and exiting would
      // leave the user with no way to change the setting that broke it.
      console.error(`[shannon] ${err instanceof Error ? err.message : String(err)}`);
      startupError = err instanceof Error ? err.message : String(err);
      apiBaseUrl = null;
      stack = null;
      instanceMode = null;
    }
    console.log(`[shannon] API base URL: ${apiBaseUrl ?? "(none — onboarding)"}`);
    await createWindow();
    // The renderer subscribes after it loads, so the first state is pushed
    // rather than assumed: a window that opened before the stack resolved
    // would otherwise sit on stale props.
    pushStackState();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (!mainWindow) createWindow(); });

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
}
