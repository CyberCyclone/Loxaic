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
  const { existsSync, rmSync } = await import("node:fs");
  const { default: serve } = await import("electron-serve");
  const { startStack } = await import("./supervisor/index.js");
  const { defaultDataDir, resolveRuntimePaths, tsnetProxyPath } = await import("./supervisor/paths.js");
  const { startExecutor } = await import("./supervisor/executor.js");
  const { startTsnet } = await import("./supervisor/tsnet.js");
  const { addRoot, loadOrCreateExecutorId, loadRoots, removeRoot, rootsPath } = await import("./supervisor/executor-store.js");
  const { readSecrets, updateSecrets } = await import("./supervisor/secrets.js");
  const { createUpdater } = await import("./updates/updater.js");
  const { appVariant } = await import("./variant.js");
  const {
    DEFAULT_HOST_PORT,
    buildConfig,
    clientSettingsView,
    defaultHostName,
    defaultTailnetHostname,
    firstLanAddress,
    hostSettingsView,
    configPath,
    loadConfig,
    normalizeControlUrl,
    saveConfig,
    tsnetTargetFor,
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

  /** Where the per-OS tsnet-proxy sidecar binary lives — shared with headless.js. */
  function getTsnetProxyPath() {
    return tsnetProxyPath();
  }

  const PROBE_TIMEOUT_MS = 1500;

  /**
   * How long a launch waits for a tailnet before opening the window anyway.
   * A node that has been approved before joins in about a second; one that
   * has not blocks until a person approves it in a browser, and there is no
   * window to show them the prompt until this returns. So: wait long enough
   * for the ordinary case, then open the window and let the join finish in
   * the background — the login screen shows the approval card.
   */
  const LAUNCH_TSNET_GRACE_MS = 8000;

  let tsnetBinWarned = false;
  /**
   * The sidecar binary to spawn. LOXAIC_TSNET_BIN stands in for it under
   * test automation, which cannot join a tailnet: it points at a script that
   * speaks the same stdout protocol. Loud on first use, and read from the
   * app's own environment, so it cannot be reached from a page — the same
   * arrangement as LOXAIC_E2E_PICK_DIR.
   */
  function tsnetBin() {
    const override = process.env.LOXAIC_TSNET_BIN;
    if (override) {
      if (!tsnetBinWarned) {
        tsnetBinWarned = true;
        console.warn(`[loxaic] LOXAIC_TSNET_BIN is set: the embedded Tailscale sidecar is ${override}. Test harness only.`);
      }
      return override;
    }
    return getTsnetProxyPath();
  }

  // ── Tailnet sidecar ─────────────────────────────────────
  // At most one sidecar runs at a time, and `key` says what it is for, so a
  // config change that does not touch the tailnet (or a Connect that follows
  // the probe which already joined) reuses it rather than making the person
  // approve the same machine twice.
  let tsnet = null; // { key, handle } from startTsnet, or null
  // A probe's own sidecar, for when the main one is what the app is talking
  // through. "Check" has to be a read-only action: tearing down the proxy
  // behind `apiBaseUrl` to test a different address, then finding the person
  // pressed Cancel, left the app disconnected until restart.
  let tsnetProbe = null;

  /** The tailnet as the renderer sees it — a probe in progress first, since
   * that is the join the person is waiting on. */
  function tailnetView() {
    const current = tsnetProbe ?? tsnet;
    if (!current) return { state: "off", mode: null, authUrl: null, url: null, funnel: false, error: null, status: null };
    const s = current.handle.state;
    return {
      state: s.state,
      mode: s.mode,
      authUrl: s.authUrl ?? null,
      url: s.url ?? null,
      funnel: Boolean(s.funnel),
      error: s.error ?? null,
      status: s.status ?? null,
    };
  }

  async function stopTsnet() {
    await stopProbeTsnet();
    // The slot is cleared only once the stop has finished. Nulling it first
    // opened a window where a second caller saw "no sidecar", launched its
    // own, and had that overwritten when this one resumed — two nodes on one
    // state directory, the first referenced by nothing shutdownChildren()
    // could reach.
    const current = tsnet;
    if (!current) return;
    await current.handle.stop().catch(() => undefined);
    if (tsnet === current) tsnet = null;
  }

  async function stopProbeTsnet() {
    const current = tsnetProbe;
    if (!current) return;
    await current.handle.stop().catch(() => undefined);
    if (tsnetProbe === current) tsnetProbe = null;
    pushStackState();
  }

  /**
   * Starts a sidecar and makes it *the* sidecar. `onTransition`, if given,
   * sees every state alongside the renderer push — the env launch uses it to
   * open the browser.
   */
  function launchTsnet(key, { onTransition, ...opts }) {
    let handle = null;
    handle = startTsnet({
      bin: tsnetBin(),
      log: (line) => { console.log(`[loxaic] ${line}`); },
      onState: (s) => {
        // A sidecar that was replaced must not narrate over its successor.
        // (During startTsnet's own synchronous first call `handle` is still
        // null and `tsnet` still the previous one; the push below covers it.)
        if (handle !== null && tsnet?.handle === handle) pushStackState();
        onTransition?.(s);
      },
      ...opts,
    });
    tsnet = { key, handle };
    pushStackState();
    return handle;
  }

  /** Both directions persist their node identity under the data dir — which
   * is Electron's own userData in the default install, so a client approved
   * before this existed keeps its identity — in *separate* directories: the
   * two are different nodes, and one state file cannot hold two keys. */
  function tsnetStateDir(mode) {
    return path.join(dataDir(), mode === "serve" ? "tsnet-serve" : mode === "probe" ? "tsnet-probe" : "tsnet");
  }

  /**
   * A client sidecar for `client.hostUrl`, reusing the running one when it
   * is already pointed there. Returns the handle; `ready` resolves with the
   * local proxy URL the renderer should use.
   */
  async function ensureClientTsnet(client) {
    const { target, tls } = tsnetTargetFor(client.hostUrl);
    const key = `client:${target}:${client.controlUrl ?? ""}`;
    const live = tsnet?.key === key && !["error", "off"].includes(tsnet.handle.state.state);
    if (live) return tsnet.handle;
    await stopTsnet();
    return launchTsnet(key, {
      mode: "client",
      target,
      tls,
      hostname: "loxaic-desktop",
      controlUrl: client.controlUrl,
      authKey: readSecrets(dataDir()).tsnetAuthKey,
      stateDir: tsnetStateDir("client"),
    });
  }

  /**
   * A sidecar for a probe that must not disturb the one the app is using:
   * its own slot, its own node identity (a separate state directory), and
   * no auth key — a probe is a reachability check, and a stored key was
   * issued for a control server the renderer does not get to swap. Reused
   * across probes of the same address, so approving it once is enough.
   */
  async function ensureProbeTsnet(client) {
    const { target, tls } = tsnetTargetFor(client.hostUrl);
    const key = `client:${target}:${client.controlUrl ?? ""}`;
    const live = tsnetProbe?.key === key && !["error", "off"].includes(tsnetProbe.handle.state.state);
    if (live) return tsnetProbe.handle;
    await stopProbeTsnet();
    let handle = null;
    handle = startTsnet({
      bin: tsnetBin(),
      log: (line) => { console.log(`[loxaic] ${line}`); },
      onState: () => { if (handle !== null && tsnetProbe?.handle === handle) pushStackState(); },
      mode: "client",
      target,
      tls,
      hostname: "loxaic-desktop",
      controlUrl: client.controlUrl,
      stateDir: tsnetStateDir("probe"),
    });
    tsnetProbe = { key, handle };
    pushStackState();
    return handle;
  }

  /** How long a probe waits for its sidecar before handing back instead of
   * holding the form: long enough for an ordinary join, not for a coffee.
   * The sidecar keeps running, so a Check after the approval lands is quick. */
  const PROBE_TSNET_WAIT_MS = 120_000;

  /**
   * Publishes a running host stack on the tailnet. Not awaited by the
   * caller: a first run blocks until a person approves the node, and the
   * local stack is usable meanwhile. Once the node is up, a host that set no
   * public address of its own is told to advertise the tailnet one — which
   * means restarting the server child, because better-auth reads the origin
   * it signs cookies for at boot. Postgres stays up; the API base URL does
   * not change.
   */
  function startServeTsnet(config, started) {
    const tailnet = config.host.tailnet;
    const handle = launchTsnet(`serve:${tailnet.hostname}`, {
      mode: "serve",
      upstream: `http://127.0.0.1:${String(started.port)}`,
      hostname: tailnet.hostname,
      funnel: Boolean(tailnet.funnel),
      controlUrl: tailnet.controlUrl,
      authKey: readSecrets(dataDir()).tsnetAuthKey,
      stateDir: tsnetStateDir("serve"),
    });
    handle.ready
      .then(async (url) => {
        if (tsnet?.handle !== handle) return;
        if (config.host.advertiseUrl) return; // an explicit address wins, as everywhere else
        try {
          await started.setAdvertiseUrl(url);
          startupError = null;
        } catch (err) {
          // The supervisor has brought the server back on its previous
          // address; what is lost is the tailnet one. Say so where the
          // renderer can show it rather than only in the log.
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[loxaic] could not re-advertise as ${url}: ${message}`);
          startupError = `The server could not be restarted for its tailnet address and is still on its previous one: ${message}`;
        }
        pushStackState();
      })
      .catch(() => undefined); // the state carries the reason; nothing to do here
    return handle;
  }

  /** Resolves with `p`'s value, or null once `ms` have passed first. */
  function withGrace(p, ms) {
    return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  }

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
   * The `TSNET_TARGET` launch: a scripted client of one tailnet host, from
   * before any of this had a GUI. Kept exactly as documented — env outranks
   * the stored config, and the auth URL is opened in the browser because
   * there is no card to show it on — with one improvement: a first login is
   * waited for. The old five-second limit fell back to probing precisely
   * while the person was still approving the machine it had just asked them
   * to approve.
   */
  async function startEnvTsnet(target) {
    let opened = null;
    const handle = launchTsnet(`client:${target}:`, {
      mode: "client",
      target,
      tls: true,
      hostname: "loxaic-desktop",
      authKey: readSecrets(dataDir()).tsnetAuthKey,
      stateDir: tsnetStateDir("client"),
      onTransition: (s) => {
        if (s.state === "needs-auth" && s.authUrl && s.authUrl !== opened) {
          opened = s.authUrl;
          console.log(`[loxaic] Tailscale needs approval for this device: ${s.authUrl}`);
          void shell.openExternal(s.authUrl);
        }
      },
    });
    try {
      let url = await withGrace(handle.ready, 5000);
      // Keep waiting as long as the sidecar is alive — not only once it has
      // reached needs-auth. A first run whose AUTH_URL took six seconds to
      // arrive was still "starting" at the five-second mark, got stopped, and
      // fell back to LAN probing with the person never asked to approve
      // anything: the exact failure the docstring above says was removed.
      if (url === null && handle.state.state !== "error") url = await handle.ready;
      if (url === null) {
        console.warn("[loxaic] tsnet-proxy did not come up in time; falling back");
        await stopTsnet();
      }
      return url;
    } catch (err) {
      console.warn(`[loxaic] embedded Tailscale failed: ${err instanceof Error ? err.message : String(err)}; falling back`);
      await stopTsnet();
      return null;
    }
  }

  /**
   * Splits a setMode payload into the config to build and the auth key, if
   * the form sent one. `undefined` means the form did not touch it; `""`
   * means clear it. Both host and client forms may carry one.
   */
  function extractAuthKey(input) {
    let authKey;
    const config = { ...input };
    if (config.host && typeof config.host === "object") {
      config.host = { ...config.host };
      if (config.host.tailnet && typeof config.host.tailnet === "object") {
        const { authKey: key, ...tailnet } = config.host.tailnet;
        if (typeof key === "string") authKey = key.trim();
        config.host.tailnet = tailnet;
      }
    }
    if (config.client && typeof config.client === "object") {
      const { authKey: key, ...client } = config.client;
      if (typeof key === "string") authKey = key.trim();
      config.client = client;
    }
    return { config, authKey };
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

    if (process.env.TSNET_TARGET) {
      const viaTsnet = await startEnvTsnet(process.env.TSNET_TARGET);
      if (viaTsnet) return { apiBaseUrl: viaTsnet, stack: null, mode: "client" };
    }

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

  /**
   * Brings up whatever the stored config asks for.
   *
   * `wait` is whether to block on a tailnet join. A person who just pressed
   * Save or Connect is looking at the approval card, so their call waits;
   * the launch path is not, and there is no window yet to show one on, so it
   * waits only LAUNCH_TSNET_GRACE_MS and otherwise lets the join finish in
   * the background — the state pushes catch the renderer up.
   */
  async function startForConfig(config, { wait = false } = {}) {
    if (config.mode === "client") {
      if (config.client.via !== "tsnet") {
        return { apiBaseUrl: config.client.hostUrl, stack: null, mode: "client" };
      }
      const handle = await ensureClientTsnet(config.client);
      const url = await (wait ? handle.ready : withGrace(handle.ready, LAUNCH_TSNET_GRACE_MS));
      if (url === null) {
        handle.ready
          .then((late) => {
            if (tsnet?.handle !== handle) return;
            apiBaseUrl = late;
            pushStackState();
          })
          .catch(() => undefined);
      }
      return { apiBaseUrl: url, stack: null, mode: "client" };
    }
    const started = await startStack({
      dataDir: dataDir(),
      port: Number(getFlag("loxaic-port") ?? process.env.LOXAIC_PORT ?? config.host?.port ?? DEFAULT_HOST_PORT),
      log: (line) => { console.log(`[loxaic] ${line}`); },
      instance: config,
    });
    if (config.mode === "host" && config.host?.tailnet?.enabled) {
      // Deliberately not awaited, whatever `wait` says: the local stack is
      // already usable, and a first-run join lasts until someone approves it.
      startServeTsnet(config, started);
    }
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
    // Read fresh rather than kept in a variable: this is what lets Settings'
    // Edit flow show the config that's actually on disk (post-setMode) rather
    // than whatever the launch-time resolve happened to see.
    const config = loadConfig(dataDir());
    return {
      mode: instanceMode,
      // What config.json says, whether or not a stack is up. `mode` goes null
      // when a save fails to start; Settings needs to keep showing the row —
      // and the error — rather than vanishing along with it.
      storedMode: config?.mode ?? null,
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
      // Only solo/host have a host section; a client (or an unconfigured
      // install) reports null so Settings knows there's nothing here to edit.
      host: hostSettingsView(config?.host ?? null),
      client: clientSettingsView(config?.client ?? null),
      // The port the server actually bound, which can differ from what was
      // requested (a stale leftover adopted at a different port, say).
      listenPort: stack?.port ?? null,
      // What the server was actually told to advertise — after a tailnet
      // join this is the ts.net address, whatever config.json says.
      effectiveAdvertiseUrl: stack?.advertiseUrl ?? null,
      defaultTailnetHostname: defaultTailnetHostname(),
      // Whether, not what: the key itself never leaves secrets.json.
      hasTailnetAuthKey: Boolean(readSecrets(dataDir()).tsnetAuthKey),
      tailnet: tailnetView(),
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
  // What the live executor was started for. It follows exactly two inputs,
  // and pushStackState fires for plenty that move neither — every sidecar
  // transition, a probe, a tailnet retry. Restarting it for those kills
  // whatever the agent is running on this machine, for no change.
  let executorSpawnedFor = null;

  function syncExecutor() {
    executorSync = executorSync.then(async () => {
      if (
        executor &&
        executorSpawnedFor &&
        executorSpawnedFor.token === sessionToken &&
        executorSpawnedFor.apiBaseUrl === apiBaseUrl
      ) {
        return;
      }
      if (executor) {
        const previous = executor;
        executor = null;
        executorSpawnedFor = null;
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
      executorSpawnedFor = { token: sessionToken, apiBaseUrl };
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
    }).catch((err) => {
      // Terminated here, or one throw — a roots-file write failing, say —
      // leaves `executorSync` a rejected promise that every later sync
      // chains onto and never runs: the executor silently stops following
      // sign-in, sign-out and mode switches for the rest of the session.
      // Reported into the state too, since what is pushed is the renderer's
      // only signal.
      console.log(`[loxaic] [executor] sync failed: ${err?.message ?? String(err)}`);
      executorState = { state: "offline", reason: "could not start the executor" };
      pushExecutorState();
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
    // A host's sidecar is bound to the stack that just stopped (its upstream
    // port), so it always goes with it. A client's is kept when the new
    // config still points at the same host — the probe that preceded a
    // Connect already joined, and asking for approval twice is the one thing
    // this must never do — and ensureClientTsnet decides that by key.
    if (config.mode !== "client" || config.client.via !== "tsnet") await stopTsnet();

    saveConfig(dataDir(), config);
    try {
      const started = await startForConfig(config, { wait: true });
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
      // The auth key is peeled off before the config is built: buildConfig
      // strips it too, but it must reach secrets.json and never config.json,
      // and this is the one place both are written from. Absent means leave
      // the stored one alone; empty means forget it.
      const { config: cleaned, authKey } = extractAuthKey(input ?? {});
      const config = buildConfig(cleaned, loadConfig(dataDir()));
      if (authKey !== undefined) updateSecrets(dataDir(), { tsnetAuthKey: authKey });
      return applyConfig(config);
    });

    // ── Tailnet ──
    ipcMain.handle("loxaic:tailnet.getState", () => tailnetView());

    // Opens the approval link the sidecar printed, and only ever that one:
    // the renderer cannot name a URL for the main process to open.
    ipcMain.handle("loxaic:tailnet.openAuthUrl", async () => {
      const view = tailnetView();
      if (view.state === "needs-auth" && view.authUrl) await shell.openExternal(view.authUrl);
      return view;
    });

    // Try again with the same settings — after enabling certificates in the
    // tailnet admin, say. A host's sidecar is re-attached to the running
    // stack; a client's is restarted and the API URL follows it.
    ipcMain.handle("loxaic:tailnet.restart", async () => {
      const config = loadConfig(dataDir());
      await stopTsnet();
      if (config?.mode === "host" && config.host?.tailnet?.enabled && stack) {
        startServeTsnet(config, stack);
      } else if (config?.mode === "client" && config.client?.via === "tsnet") {
        const handle = await ensureClientTsnet(config.client);
        handle.ready
          .then((url) => {
            if (tsnet?.handle !== handle) return;
            apiBaseUrl = url;
            pushStackState();
          })
          .catch(() => undefined);
      }
      pushStackState();
      return tailnetView();
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
    //
    // With `{ via: "tsnet" }` the host is reached through the embedded
    // sidecar: it is started (or reused) for that address, the probe waits
    // for it to join — a first run, until the person approves this machine,
    // which the state pushes show them meanwhile — and the request goes
    // through its local proxy. The sidecar is left running for the Connect
    // that follows, which reuses it.
    ipcMain.handle("loxaic:probeHost", async (_event, url, opts) => {
      if (typeof url !== "string" || !url.trim()) return { ok: false, reason: "No URL given" };
      const base = url.trim().replace(/\/+$/, "");
      let probeBase = base;
      if (opts && typeof opts === "object" && opts.via === "tsnet") {
        try {
          // The same validation setMode applies to the same field: this was
          // the one path a renderer-named control server reached the sidecar
          // unparsed — and, before the probe slot below, with the stored auth
          // key presented to it.
          const controlUrl = normalizeControlUrl(opts.controlUrl);
          const client = { hostUrl: base, controlUrl };
          // The main sidecar is what the app is talking through whenever a
          // tsnet client is the running mode. A probe of a *different*
          // address must not touch it — Check is the one button in the dialog
          // a person expects to be able to press speculatively.
          const { target } = tsnetTargetFor(base);
          const backingTheApp =
            tsnet !== null && instanceMode === "client" && tsnet.key !== `client:${target}:${controlUrl ?? ""}`;
          const handle = backingTheApp ? await ensureProbeTsnet(client) : await ensureClientTsnet(client);
          pushStackState();
          // Bounded, unlike the join itself: a sidecar that never reached
          // `error` held the form for the full ten-minute join timeout with
          // no cancel reachable. The sidecar stays up past this, so a Check
          // after the approval lands reuses it.
          const url = await withGrace(handle.ready, PROBE_TSNET_WAIT_MS);
          if (url === null) {
            return {
              ok: false,
              reason:
                handle.state.state === "needs-auth"
                  ? "Still waiting for this machine to be approved on the tailnet. Approve it, then press Check again."
                  : "The tailnet did not come up in time. Try again in a moment.",
            };
          }
          probeBase = url;
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      }
      try {
        const health = await fetch(`${probeBase}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!health.ok) return { ok: false, reason: `Server answered ${String(health.status)}` };
        const res = await fetch(`${probeBase}/v1/cluster`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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
      await stopTsnet();
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

    // ── Updates ──
    // Three fixed IPC channels, none of which takes a URL, a path, a version
    // or a channel from the renderer: the release feed is compiled in and the
    // channel is decided when the app is packaged, so a page can ask what the
    // state is, ask for a check, and ask to restart — nothing else.
    ipcMain.handle("loxaic:updates.getState", () => updates.state());
    ipcMain.handle("loxaic:updates.check", () => updates.check());
    ipcMain.handle("loxaic:updates.install", () => updates.install());
  }

  // ── Desktop updates ─────────────────────────────────────
  // A whole new binary, installed by the platform's own installer — nothing
  // like the mobile app's JS bundle over the air, but reported through the
  // same shape and the same settings row. Which releases this install follows
  // comes from the variant it was packaged as: "Loxaic Beta" is a separate
  // application, not a switch inside this one.
  const variant = appVariant();
  const updates = createUpdater({
    app,
    variant: variant.name,
    allowPrerelease: variant.prerelease,
    log: (line) => { console.log(`[loxaic] ${line}`); },
    onState: (state) => { mainWindow?.webContents.send("loxaic:updateState", state); },
    beforeInstall: async () => {
      // Stop the children *first*, then claim the quit. `quitAndInstall`
      // closes the windows and then emits `before-quit`; with `quitting`
      // set, that handler steps aside and lets the app quit the ordinary
      // way, which is what Squirrel and NSIS need to take over from. But the
      // flag has to become true only once it is: set before the await, a
      // Cmd-Q or SIGTERM landing mid-shutdown found `quitting` already true,
      // stepped aside, and exited with Postgres mid-drain — the exact
      // outcome this ordering exists to prevent. Stopping the children here
      // rather than in the handler is the point: the installer is about to
      // replace the binary they were spawned from.
      await shutdownChildren();
      quitting = true;
    },
  });

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
    updates.start();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (!mainWindow) createWindow(); });

  // Quit must wait for the embedded stack: the server needs to drain against a
  // live database, and Postgres needs a clean shutdown — a fire-and-forget
  // kill here would leave the cluster to crash-recover on next launch.
  let quitting = false;

  /** Everything this process spawned, stopped and awaited. Shared by the
   * quit handler and the updater, which has to bring the same children down
   * before the installer replaces the binary they came from. */
  function shutdownChildren() {
    const stops = [];
    if (executor) stops.push(executor.stop().catch(() => undefined));
    if (stack) stops.push(stack.stop());
    stops.push(stopTsnet());
    return Promise.all(stops);
  }

  app.on("before-quit", (event) => {
    // Already draining — either a second Cmd-Q, or the quit that
    // `quitAndInstall` triggers after the updater has stopped the children
    // itself. Both must be allowed to proceed: preventing this one is how an
    // update gets installed into a process that then refuses to exit.
    if (quitting) return;
    if (!stack && !executor && !tsnet) return;
    event.preventDefault();
    quitting = true;
    shutdownChildren().finally(() => { app.exit(0); });
  });
}
