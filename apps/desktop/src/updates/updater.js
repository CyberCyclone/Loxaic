import { initialState, reduce } from "./state.js";

/** How long after launch the first check runs. Long enough that it never
 * competes with starting Postgres and the server. */
const LAUNCH_DELAY_MS = 10_000;

/** And every six hours after that. A desktop app is left open for days; a
 * shorter interval would spend somebody's bandwidth to learn nothing. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Keeping the installed desktop app up to date.
 *
 * The mechanism has nothing in common with the mobile app's: there it is a JS
 * bundle over the air, here it is a whole new binary, installed by the
 * platform's own installer. What the two share is the *choice* — Stable or
 * Beta, made once in Settings — so both report through the same state shape
 * and the same settings row.
 *
 * `electron-updater` is imported lazily and only when the updater is actually
 * enabled: it pulls in fs-extra, js-yaml and lodash, and a development launch
 * has no use for any of them.
 *
 * Nothing here is loud. Every failure — no network, a rate limit, a release
 * whose assets are still uploading — lands in the state as one sentence and
 * one log line. An update check is not something the person asked for, so it
 * has no business interrupting them when it fails.
 */
export function createUpdater({
  app,
  /**
   * Which app this is, from src/variant.js. Decided at package time — and it
   * decides whether the build follows prereleases too, so it is one parameter
   * rather than two. Accepting them separately made `{variant: "beta",
   * allowPrerelease: false}` expressible: a beta app that silently never sees
   * a beta tag, because `/releases/latest` excludes prereleases while the
   * channel getter still asks that stable release for beta.yml. A check that
   * finds nothing is indistinguishable from being up to date, so it would
   * have failed in the quiet direction.
   */
  variant = "production",
  log = console.log,
  onState = () => {},
  /** Run before the app is replaced: stop the embedded stack, the executor
   * and the sidecar. Installing while Postgres is mid-write is how a data
   * directory needs crash recovery on next launch. */
  beforeInstall = async () => {},
  argv = process.argv,
  env = process.env,
  platform = process.platform,
  loadModule = () => import("electron-updater"),
  launchDelayMs = LAUNCH_DELAY_MS,
  checkIntervalMs = CHECK_INTERVAL_MS,
} = {}) {
  const allowPrerelease = variant === "beta";
  const disabledReason = whyDisabled({ app, argv, env, platform });
  let state = initialState({
    version: app?.getVersion?.() ?? null,
    variant,
    enabled: disabledReason === null,
    disabledReason,
  });

  let updater = null;
  let loading = null;
  let timer = null;
  let stopped = false;

  function apply(event) {
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    onState(state);
  }

  /**
   * The one place electron-updater is configured, and the feed rules are
   * subtle enough to be worth stating.
   *
   * **Stable** sets nothing: `allowPrerelease` stays false, so the provider
   * asks `/releases/latest`, which GitHub defines as excluding prereleases.
   * A stable install therefore never sees a beta.
   *
   * **Beta** cannot simply set `allowPrerelease`. With that alone the
   * provider walks the releases feed and takes the newest entry *whether it
   * is a prerelease or not* (GitHubProvider's `shouldFetchVersion` admits a
   * stable tag), then asks that release for `latest*.yml` — so the beta app
   * would install the stable app over itself the first time a release tag
   * landed. Pinning `channel = "beta"` makes it ask each release for
   * `beta*.yml` instead, which the beta variant publishes on *every* tag
   * (see electron-builder.config.cjs). A beta tester consequently receives
   * every release, always as the beta app.
   *
   * Assigning `channel` flips `allowDowngrade` to true as a side effect —
   * electron-updater's own setter does it — so it is put back immediately
   * afterwards. Order matters here, and the test asserts it.
   */
  async function ensureUpdater() {
    if (updater) return updater;
    loading ??= (async () => {
      const autoUpdater = resolveAutoUpdater(await loadModule());
      autoUpdater.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
      autoUpdater.autoDownload = true;
      // The install is a person pressing Restart, not something that happens
      // to them because they closed the window.
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = allowPrerelease;
      if (allowPrerelease) autoUpdater.channel = "beta";
      // After the channel assignment, never before: the setter sets
      // allowDowngrade = true, and a beta must not walk backwards any more
      // than a stable one.
      autoUpdater.allowDowngrade = false;

      const token = env.LOXAIC_GH_TOKEN;
      if (token) {
        // Only for testing against a repository that is not public yet. A
        // token in an environment variable is not a shipping mechanism, so
        // say so where somebody will see it, and never write it anywhere.
        log("updates: using LOXAIC_GH_TOKEN to read a private release feed (testing only)");
        autoUpdater.setFeedURL({ provider: "github", owner: "CyberCyclone", repo: "Open-Shannon", private: true, token });
      }

      autoUpdater.on("checking-for-update", () => { apply({ type: "checking" }); });
      autoUpdater.on("update-available", (info) => { apply({ type: "available", version: info?.version }); });
      autoUpdater.on("update-not-available", () => { apply({ type: "not-available" }); });
      autoUpdater.on("download-progress", (p) => { apply({ type: "progress", percent: p?.percent }); });
      autoUpdater.on("update-downloaded", (info) => {
        log(`updates: ${info?.version ?? "an update"} downloaded; it installs on restart`);
        apply({ type: "downloaded", version: info?.version });
      });
      autoUpdater.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`updates: check failed — ${message}`);
        apply({ type: "error", message });
      });

      updater = autoUpdater;
      return autoUpdater;
    })();
    // A failed load must not be cached as a permanent verdict: drop the
    // promise so the next check can try again rather than replaying the same
    // rejection for the life of the process.
    loading.catch(() => { loading = null; });
    return loading;
  }

  async function check() {
    if (!state.enabled || stopped) return state;
    try {
      const autoUpdater = await ensureUpdater();
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // checkForUpdates rejects *and* emits "error" for most failures, so by
      // the time this runs the event handler has usually already recorded
      // this exact message — saying it a second time is noise in the log for
      // one thing that went wrong. What this catch is really for is the case
      // no event covers: loading the module itself failing.
      const message = err instanceof Error ? err.message : String(err);
      if (state.error !== message) {
        log(`updates: check failed — ${message}`);
        apply({ type: "error", message });
      }
    }
    return state;
  }

  return {
    state: () => state,

    check,

    /**
     * Restarts into the downloaded update.
     *
     * The order matters. The embedded stack is stopped *first* and awaited,
     * because the installer is about to replace the very binary those
     * children were spawned from. Then `quitting` is handed over to the
     * caller's own quit handling: `quitAndInstall` closes the windows and
     * emits `before-quit`, and the app must be allowed to quit normally
     * there — an `app.exit()` in that handler would kill the process out
     * from under Squirrel's and NSIS's handover.
     */
    async install() {
      if (state.status !== "ready" || !updater) return state;
      apply({ type: "installing" });
      // Bounded and caught. beforeInstall stops Postgres, the server, the
      // executor and the sidecar; if one of them refuses to stop, or hangs,
      // the person is in an app whose backend is already down — that has to
      // become a sentence on screen, not a rejection into a `void` while the
      // row goes on saying an update is ready. The children have their own
      // shutdown deadlines, so this ceiling only stops a silent wait forever.
      try {
        await withDeadline(beforeInstall(), BEFORE_INSTALL_DEADLINE_MS, "stopping the running services");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`updates: install aborted — ${message}`);
        apply({ type: "error", message: `Could not stop the running services before installing: ${message}` });
        return state;
      }
      updater.quitAndInstall(false, true);
      return state;
    },

    /** Starts the launch check and the interval. Safe to call once. */
    start() {
      if (!state.enabled || timer) return;
      timer = setTimeout(function tick() {
        void check();
        timer = setTimeout(tick, checkIntervalMs);
        timer.unref?.();
      }, launchDelayMs);
      timer.unref?.();
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Longer than any child's own stop deadline, so it only ever fires when
 * one of them has genuinely wedged. */
const BEFORE_INSTALL_DEADLINE_MS = 45_000;

function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`timed out after ${String(ms / 1000)}s ${what}`)); }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => { clearTimeout(timer); });
}

/**
 * Digs `autoUpdater` out of the imported module, whichever shape it arrives in.
 *
 * electron-updater is CommonJS and defines `autoUpdater` with
 * `Object.defineProperty(exports, "autoUpdater", { get })`. Node's
 * cjs-module-lexer cannot see a getter, so the ESM namespace a dynamic
 * `import()` produces has **no** `autoUpdater` named export — only `default`,
 * which is the whole `module.exports`. A plain `const { autoUpdater } =
 * await import(...)` is therefore `undefined`, and the first property set on
 * it throws.
 *
 * No unit test could have found this: a hand-written fake module is an ESM
 * namespace with real named exports. The packaged app said so on its first
 * real launch, which is why one of the tests below now imitates the real
 * shape instead.
 */
function resolveAutoUpdater(mod) {
  const found = mod?.autoUpdater ?? mod?.default?.autoUpdater;
  if (!found) throw new Error("electron-updater exported no autoUpdater");
  return found;
}

function quiet() {}

/**
 * Why this install does not check for updates, in a sentence, or null when it
 * does.
 *
 * The row stays visible in every one of these cases rather than hiding: an
 * app that silently never updates is indistinguishable from one that is up to
 * date, and the difference matters most in exactly the case a person is least
 * likely to guess — a .deb, which really does have to be updated by hand.
 */
export function whyDisabled({ app, argv = [], env = {}, platform = process.platform } = {}) {
  if (env.LOXAIC_DISABLE_UPDATES === "1" || argv.includes("--loxaic-no-updates")) {
    return "Update checks are switched off for this launch.";
  }
  if (!app?.isPackaged) {
    return "This is a development build. Released builds update themselves.";
  }
  if (platform === "linux" && !env.APPIMAGE) {
    return "This build was installed from a package. Update it the way you installed it.";
  }
  return null;
}
