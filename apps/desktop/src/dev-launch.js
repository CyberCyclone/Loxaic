// How the desktop app starts in development (`pnpm dev`, or `electron .`).
//
// A development build loads its renderer from Metro rather than from a web
// export, and under `pnpm dev` it is started at the same moment as the API
// server and Metro themselves. It used to ask each of them once: the window
// loaded http://localhost:8081 a single time, with nothing listening for a
// failure, so a Metro that was still starting left a blank window that no
// amount of waiting fixed; and :4000 was probed once before any window
// existed, so the dev server — seconds from answering — lost the race and the
// app quietly started its own embedded stack on :4100, with its own database
// and its own copy of everyone's password.
//
// Everything here is written against injected probes and a sleep, so the
// waiting rules are unit-tested without a real window or a real server.

/** How often to ask again while waiting. */
export const POLL_INTERVAL_MS = 1_000;

/**
 * How long to wait for the dev server `pnpm dev` is starting alongside the
 * app. A cold `tsx` start with migrations takes several seconds; past this,
 * something is wrong with it, and the app carries on as it would without one.
 */
export const DEV_SERVER_WAIT_MS = 45_000;

export const DEFAULT_RENDERER_URL = "http://localhost:8081";
export const DEFAULT_DEV_SERVER_URL = "http://localhost:4000";

/** Chromium's net error for a navigation superseded by another — not a failure. */
const ERR_ABORTED = -3;

/**
 * Where development points: Metro and the dev server. Overridable so a test
 * can stand in for either on a port of its own, since neither address may be
 * taken from the developer running the suite.
 */
export function devUrls(env = process.env) {
  return {
    rendererUrl: env.LOXAIC_DEV_RENDERER_URL || DEFAULT_RENDERER_URL,
    devServerUrl: env.LOXAIC_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL,
    // Set by the root `pnpm dev`, which starts the server and Metro beside
    // this app: the dev server is on its way, so it is waited for rather than
    // raced. `electron .` on its own does not set it and keeps the old single
    // probe — nothing is coming, and waiting would only delay the fallback.
    expectDevServer: env.LOXAIC_DEV_STACK === "1",
  };
}

/** Metro answers GET /status with this line once it is serving. */
export function isMetroStatus(body) {
  return typeof body === "string" && body.includes("packager-status:running");
}

/**
 * Asks `probe` until it says yes or `timeoutMs` passes. Resolves true on a
 * yes, false on timing out. `timeoutMs` of Infinity waits for as long as it
 * takes; `shouldStop` ends it early (a window closed meanwhile).
 */
export async function waitUntil(
  probe,
  { timeoutMs = Infinity, intervalMs = POLL_INTERVAL_MS, sleep, now = Date.now, shouldStop = () => false } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (shouldStop()) return false;
    if (await probe()) return true;
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(testId, title, paragraphs) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Loxaic — ${title}</title>
<style>
  html,body{margin:0;height:100%;background:#18181b;color:#e4e4e7;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:0 24px;text-align:center}
  h1{font-size:18px;font-weight:600;margin:0}
  p{margin:0;color:#a1a1aa;max-width:520px;line-height:1.5}
  code{background:#27272a;color:#e4e4e7;padding:2px 6px;border-radius:4px}
</style></head>
<body><main data-testid="${testId}">
  <h1>${title}</h1>
  ${paragraphs.map((p) => `<p>${p}</p>`).join("\n  ")}
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * The page the window shows while Metro is not answering, as a data: URL, so
 * it needs nothing to be running. It names the address it is waiting on and
 * the command that starts it, and says it will carry on by itself — the thing
 * a blank window never said.
 */
export function waitingPageUrl(rendererUrl) {
  return page("devLaunch.waiting", "Waiting for Metro", [
    `This development build loads its screens from Metro at <code data-testid="devLaunch.url">${escapeHtml(rendererUrl)}</code>, which is not answering yet.`,
    "<code>pnpm dev</code> starts it. On its own, run <code>pnpm --filter @loxaic/mobile web</code>. The app opens here by itself once Metro is up.",
  ]);
}

/**
 * Shown while `pnpm dev`'s dev server is still starting. The app cannot open
 * its real window until it knows which server it talks to — the renderer is
 * handed that address when its window is created — so without this there was
 * no window at all for as long as the server took.
 */
export function serverWaitingPageUrl(devServerUrl, waitSeconds) {
  return page("devLaunch.serverWaiting", "Waiting for the dev server", [
    `<code>pnpm dev</code> is starting the API server at <code data-testid="devLaunch.serverUrl">${escapeHtml(devServerUrl)}</code>.`,
    `The app opens as soon as it answers. If it has not within ${String(waitSeconds)} seconds, the app starts on its own configuration instead — check the server's output in the <code>pnpm dev</code> terminal.`,
  ]);
}

/**
 * Loads the development renderer into `win`, waiting for Metro first and
 * coming back to wait again whenever a load fails — Metro restarted, or
 * stopped for a moment. Returns once the first successful load has been asked
 * for; recovery after that runs off the window's own `did-fail-load`.
 *
 * `win` needs `loadURL`, `isDestroyed` and `webContents.on/off`; `probe`
 * answers whether Metro is serving now.
 */
export async function loadDevRenderer(win, { rendererUrl, probe, sleep, log = () => {} }) {
  const waitingUrl = waitingPageUrl(rendererUrl);
  // True while a wait for Metro is in progress, so a burst of failures starts
  // one wait, not several. Cleared *before* the real load is asked for: a
  // load that fails must be free to start the next wait, or the window would
  // sit on whatever the failure left behind.
  let waiting = false;

  const waitThenLoad = async () => {
    waiting = true;
    try {
      if (!(await probe())) {
        log(`waiting for Metro at ${rendererUrl}`);
        await win.loadURL(waitingUrl).catch(() => undefined);
        const up = await waitUntil(probe, { sleep, shouldStop: () => win.isDestroyed() });
        if (!up) return;
        log(`Metro is up at ${rendererUrl}`);
      }
    } finally {
      waiting = false;
    }
    // A failed load rejects here and also fires did-fail-load, which is what
    // brings the window back to waiting, so the rejection itself is spent.
    await win.loadURL(rendererUrl).catch(() => undefined);
  };

  const onFail = (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    // The waiting page is a data: URL and cannot be what failed.
    if (typeof validatedUrl === "string" && validatedUrl.startsWith("data:")) return;
    if (waiting || win.isDestroyed()) return;
    void waitThenLoad();
  };
  win.webContents.on("did-fail-load", onFail);

  await waitThenLoad();
  return () => { win.webContents.off("did-fail-load", onFail); };
}
