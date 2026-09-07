import "./cwd-guard.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `Loxaic --headless` re-execs itself as plain Node running
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
  const { app, BrowserWindow, dialog, ipcMain, shell } = await import("electron");
  const { createInterface } = await import("node:readline");
  const { existsSync, rmSync } = await import("node:fs");
  const { default: serve } = await import("electron-serve");
  const { startStack } = await import("./supervisor/index.js");
  const { defaultDataDir, resolveRuntimePaths } = await import("./supervisor/paths.js");
  const { startExecutor } = await import("./supervisor/executor.js");
  const { addRoot, loadOrCreateExecutorId, loadRoots, removeRoot, rootsPath } = await import("./supervisor/executor-store.js");
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
        console.warn(`[loxaic] tsnet-proxy binary not found at ${binPath}; skipping embedded Tailscale`);
        return resolve(null);
      }

      const stateDir = path.join(app.getPath("userData"), "tsnet");
      const child = spawn(binPath, ["--target", target, "--state-dir", stateDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        console.warn(`[loxaic] tsnet-proxy did not report a listener within ${TSNET_START_TIMEOUT_MS}ms; falling back`);
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
          console.log(`[loxaic] Tailscale needs approval for this device: ${auth[1]}`);
          shell.openExternal(auth[1]);
        }
      });

      const stderr = createInterface({ input: child.stderr });
      stderr.on("line", (line) => console.log(`[tsnet-proxy] ${line}`));

      child.on("error", (err) => {
        console.warn(`[loxaic] tsnet-proxy failed to start: ${err.message}`);
        clearTimeout(timer);
        resolve(null);
      });
      child.on("exit", (code) => {
        if (code !== 0) console.warn(`[loxaic] tsnet-proxy exited with code ${code}`);
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
   * `LOXAIC_REMOTE_URL` / `TSNET_TARGET` / the LAN+tailnet probes / a dev
   * server on :4000 are all "someone told this launch exactly where to point",
   * and they keep working untouched — the e2e harness and every scripted
   * workflow depend on them. Only when none of them applies does config.json
   * decide, and only when *that* is absent does the app open onboarding.
   */
  async function resolveApi() {
    const remote = getFlag("remote") ?? process.env.LOXAIC_REMOTE_URL;
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
      port: Number(getFlag("loxaic-port") ?? process.env.LOXAIC_PORT ?? config.host?.port ?? DEFAULT_HOST_PORT),
      log: (line) => { console.log(`[loxaic] ${line}`); },
      instance: config,
    });
    return { apiBaseUrl: started.apiBaseUrl, stack: started, mode: config.mode };
  }

  function dataDir() {
    return getFlag("loxaic-data-dir") ?? process.env.LOXAIC_DATA_DIR ?? defaultDataDir();
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
      // This machine's identity, so the renderer can tell "this machine"
      // from the user's other executors in the workspace chooser.
      instanceId: executorIdentity().executorId,
      ...(startupError ? { error: startupError } : {}),
    };
  }

  function pushStackState() {
    mainWindow?.webContents.send("loxaic:stackState", stackState());
    // The executor follows the API URL, so any stack change is its cue.
    void syncExecutor();
  }

  // ── Local executor ──────────────────────────────────────
  // Runs in every instance mode: a Client is exactly the machine whose owner
  // wants an agent on a remote host working in a folder here. The session
  // token lives in this variable and the executor's stdin, nowhere else.
  let executor = null;
  let sessionToken = null;
  let executorState = { state: "offline", reason: "not signed in" };
  let pickDirWarned = false;

  /** `instanceId` when the install has a config; a stable per-install
   * fallback otherwise (a launch pointed somewhere by env/flags never writes
   * config.json). The name is what the user called this host, else the
   * machine's own. */
  function executorIdentity() {
    const config = loadConfig(dataDir());
    return {
      executorId: config?.instanceId ?? loadOrCreateExecutorId(dataDir()),
      name: config?.host?.name ?? defaultHostName(),
    };
  }

  function executorEntry() {
    return path.join(resolveRuntimePaths().serverDir, "dist/executor.js");
  }

  function executorStateView() {
    const identity = executorIdentity();
    return { ...executorState, executorId: identity.executorId, name: identity.name, roots: loadRoots(dataDir()) };
  }

  function pushExecutorState() {
    mainWindow?.webContents.send("loxaic:executorState", executorStateView());
  }

  /**
   * Bring the executor in line with the current session and API URL: stop
   * whatever is running, and start one only when there is a token to
   * connect with and a server to connect to. Serialised so a sign-in racing
   * a mode switch cannot leave two children behind.
   */
  let executorSync = Promise.resolve();
  function syncExecutor() {
    executorSync = executorSync.then(async () => {
      if (executor) {
        const previous = executor;
        executor = null;
        await previous.stop().catch(() => undefined);
      }
      if (!sessionToken) {
        executorState = { state: "offline", reason: "not signed in" };
        pushExecutorState();
        return;
      }
      if (!apiBaseUrl) {
        executorState = { state: "offline", reason: "no server to connect to" };
        pushExecutorState();
        return;
      }
      const entry = executorEntry();
      if (!existsSync(entry)) {
        executorState = {
          state: "unavailable",
          reason: `no executor payload at ${entry} — run \`pnpm --filter @loxaic/desktop build:server\``,
        };
        pushExecutorState();
        return;
      }
      const identity = executorIdentity();
      executor = startExecutor({
        entry,
        cwd: path.dirname(entry),
        apiBaseUrl,
        executorId: identity.executorId,
        name: identity.name,
        rootsFile: rootsPath(dataDir()),
        buildContext: path.join(resolveRuntimePaths().serverDir, "sandbox"),
        token: sessionToken,
        log: (line) => { console.log(`[loxaic] ${line}`); },
        onState: (state) => {
          executorState = state;
          pushExecutorState();
        },
      });
    });
    return executorSync;
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
    try {
      const started = await startForConfig(config);
      startupError = null;
      stack = started.stack;
      apiBaseUrl = started.apiBaseUrl;
      instanceMode = started.mode;
    } catch (err) {
      // The most likely failure here is the one that most needs explaining:
      // hostingBlockedReason() refusing to start a Host with no container
      // engine. Before this the throw skipped every line above, so the error
      // was never recorded and the renderer never heard — it just landed back
      // on onboarding with no reason attached and the "install Docker"
      // message lost.
      startupError = err instanceof Error ? err.message : String(err);
      pushStackState();
      throw err;
    }
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
    ipcMain.handle("loxaic:getState", () => stackState());

    ipcMain.handle("loxaic:setMode", async (_event, input) => {
      const config = buildConfig(input ?? {}, loadConfig(dataDir()));
      return applyConfig(config);
    });

    // Is a container engine reachable? Host mode requires one — the server
    // refuses to boot otherwise — so onboarding checks before committing the
    // user to a mode that would fail at startup.
    ipcMain.handle("loxaic:probeEngine", async () => {
      const { probeContainerEngine } = await import("./supervisor/engine-probe.js");
      return probeContainerEngine();
    });

    // Does this URL serve a Loxaic? Returns the cluster so the join screen can
    // name what the user is about to connect to instead of echoing their URL.
    ipcMain.handle("loxaic:probeHost", async (_event, url) => {
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
    ipcMain.handle("loxaic:testDb", async (_event, input) => {
      const { testDatabase } = await import("./supervisor/db-test.js");
      return testDatabase(input ?? {}, dataDir());
    });

    // Leave the current host: forget the stored config and return to
    // onboarding. Deliberately does NOT delete the data directory — a Host
    // that detaches keeps its own database.
    ipcMain.handle("loxaic:detach", async () => {
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

    // ── Executor ──
    // The renderer tells the main process about the session it holds; the
    // main process never reads the renderer's storage. Null on sign-out.
    ipcMain.handle("loxaic:executor.setSession", async (_event, token) => {
      sessionToken = typeof token === "string" && token.trim() ? token.trim() : null;
      await syncExecutor();
      return executorStateView();
    });

    ipcMain.handle("loxaic:executor.getState", () => executorStateView());

    // The only way a folder becomes available to an agent: the user picks it
    // in the OS's own dialog. Takes no argument — the renderer cannot name
    // a path, and neither can any server the renderer is talking to.
    //
    // LOXAIC_E2E_PICK_DIR stands in for the dialog under test automation,
    // which cannot drive a native window. Loud on first use, and read from
    // the app's own environment, so it cannot be reached from a page.
    ipcMain.handle("loxaic:pickDirectory", async () => {
      let chosen = null;
      const preset = process.env.LOXAIC_E2E_PICK_DIR;
      if (preset) {
        if (!pickDirWarned) {
          pickDirWarned = true;
          console.warn(`[loxaic] LOXAIC_E2E_PICK_DIR is set: the folder dialog is bypassed and ${preset} is used. Test harness only.`);
        }
        chosen = preset;
      } else {
        const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
          title: "Choose a folder for Loxaic to work in",
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return { canceled: true };
        chosen = result.filePaths[0];
      }
      addRoot(dataDir(), chosen);
      executor?.reloadRoots();
      pushExecutorState();
      return { path: chosen, roots: loadRoots(dataDir()) };
    });

    // Narrowing only: a path that is not already a root is a no-op.
    ipcMain.handle("loxaic:executor.removeRoot", (_event, dir) => {
      if (typeof dir === "string" && loadRoots(dataDir()).includes(dir)) {
        removeRoot(dataDir(), dir);
        executor?.reloadRoots();
        pushExecutorState();
      }
      return executorStateView();
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
        // over loxaic:stackState once a mode is chosen.
        additionalArguments: [`--loxaic-api-base-url=${encodeURIComponent(apiBaseUrl ?? "")}`],
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
      console.error(`[loxaic] ${err instanceof Error ? err.message : String(err)}`);
      startupError = err instanceof Error ? err.message : String(err);
      apiBaseUrl = null;
      stack = null;
      instanceMode = null;
    }
    console.log(`[loxaic] API base URL: ${apiBaseUrl ?? "(none — onboarding)"}`);
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
    if (quitting) return;
    if (!stack && !executor) return;
    event.preventDefault();
    quitting = true;
    const stops = [];
    if (executor) stops.push(executor.stop().catch(() => undefined));
    if (stack) stops.push(stack.stop());
    Promise.all(stops).finally(() => { app.exit(0); });
  });
}
