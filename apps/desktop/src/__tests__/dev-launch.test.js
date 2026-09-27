import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEV_SERVER_URL,
  DEFAULT_RENDERER_URL,
  devUrls,
  isMetroStatus,
  loadDevRenderer,
  serverWaitingPageUrl,
  waitingPageUrl,
  waitUntil,
} from "../dev-launch.js";

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, elapsed: () => t };
}

/** A BrowserWindow stand-in that records what it was asked to load. */
function fakeWindow() {
  const webContents = new EventEmitter();
  const loads = [];
  return {
    loads,
    destroyed: false,
    webContents,
    isDestroyed() { return this.destroyed; },
    async loadURL(url) { loads.push(url); },
    fail(url) { webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", url, true); },
  };
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe("devUrls", () => {
  it("defaults to Metro on :8081 and the dev server on :4000, raced only once", () => {
    expect(devUrls({})).toEqual({
      rendererUrl: DEFAULT_RENDERER_URL,
      devServerUrl: DEFAULT_DEV_SERVER_URL,
      expectDevServer: false,
    });
  });

  it("waits for the dev server only when pnpm dev said one is coming", () => {
    expect(devUrls({ LOXAIC_DEV_STACK: "1" }).expectDevServer).toBe(true);
    expect(devUrls({ LOXAIC_DEV_STACK: "0" }).expectDevServer).toBe(false);
  });

  it("lets a test point either address somewhere of its own", () => {
    const urls = devUrls({ LOXAIC_DEV_RENDERER_URL: "http://127.0.0.1:9", LOXAIC_DEV_SERVER_URL: "http://127.0.0.1:8" });
    expect(urls.rendererUrl).toBe("http://127.0.0.1:9");
    expect(urls.devServerUrl).toBe("http://127.0.0.1:8");
  });
});

describe("isMetroStatus", () => {
  it("accepts Metro's status line and nothing else", () => {
    expect(isMetroStatus("packager-status:running")).toBe(true);
    expect(isMetroStatus("<html>")).toBe(false);
    expect(isMetroStatus(undefined)).toBe(false);
  });
});

describe("waitUntil", () => {
  it("answers at once when the probe already says yes", async () => {
    const clock = fakeClock();
    expect(await waitUntil(async () => true, { timeoutMs: 45_000, ...clock })).toBe(true);
    expect(clock.elapsed()).toBe(0);
  });

  it("keeps asking until the probe says yes", async () => {
    const clock = fakeClock();
    let calls = 0;
    const up = await waitUntil(async () => ++calls === 5, { timeoutMs: 45_000, intervalMs: 1_000, ...clock });
    expect(up).toBe(true);
    expect(calls).toBe(5);
    expect(clock.elapsed()).toBe(4_000);
  });

  it("gives up at the deadline, not after it", async () => {
    const clock = fakeClock();
    const up = await waitUntil(async () => false, { timeoutMs: 45_000, intervalMs: 1_000, ...clock });
    expect(up).toBe(false);
    expect(clock.elapsed()).toBeLessThanOrEqual(45_000);
  });

  it("asks exactly once with no time to wait — the launch outside pnpm dev", async () => {
    const clock = fakeClock();
    let calls = 0;
    expect(await waitUntil(async () => { calls++; return false; }, { timeoutMs: 0, ...clock })).toBe(false);
    expect(calls).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it("stops when told to", async () => {
    const clock = fakeClock();
    let stop = false;
    let calls = 0;
    const up = await waitUntil(async () => { if (++calls === 3) stop = true; return false; }, {
      shouldStop: () => stop,
      ...clock,
    });
    expect(up).toBe(false);
    expect(calls).toBe(3);
  });
});

describe("waitingPageUrl", () => {
  it("names the address, the command that starts Metro, and that it carries on by itself", () => {
    const html = decodeURIComponent(waitingPageUrl("http://localhost:8081").split(",")[1]);
    expect(html).toContain("http://localhost:8081");
    expect(html).toContain("pnpm --filter @loxaic/mobile web");
    expect(html).toContain("opens here by itself");
    expect(html).toContain('data-testid="devLaunch.waiting"');
  });

  it("escapes the address it shows", () => {
    const html = decodeURIComponent(waitingPageUrl('http://x/"><script>').split(",")[1]);
    expect(html).not.toContain("<script>");
  });
});

describe("serverWaitingPageUrl", () => {
  it("says which server it waits for, for how long, and what happens after", () => {
    const html = decodeURIComponent(serverWaitingPageUrl("http://localhost:4000", 45).split(",")[1]);
    expect(html).toContain('data-testid="devLaunch.serverWaiting"');
    expect(html).toContain("http://localhost:4000");
    expect(html).toContain("45 seconds");
    expect(html).toContain("own configuration");
  });
});

describe("loadDevRenderer", () => {
  const RENDERER = "http://localhost:8081";

  it("loads Metro straight away when it is already up — no waiting page", async () => {
    const win = fakeWindow();
    await loadDevRenderer(win, { rendererUrl: RENDERER, probe: async () => true, sleep: async () => undefined });
    expect(win.loads).toEqual([RENDERER]);
  });

  it("shows the waiting page while Metro is down, then loads it once it answers", async () => {
    const win = fakeWindow();
    let up = false;
    let probes = 0;
    await loadDevRenderer(win, {
      rendererUrl: RENDERER,
      probe: async () => { if (++probes === 4) up = true; return up; },
      sleep: async () => undefined,
    });
    expect(win.loads).toHaveLength(2);
    expect(win.loads[0]).toMatch(/^data:text\/html/);
    expect(win.loads[1]).toBe(RENDERER);
  });

  it("goes back to waiting when a load fails — Metro stopped or restarted — and recovers", async () => {
    const win = fakeWindow();
    let up = true;
    await loadDevRenderer(win, { rendererUrl: RENDERER, probe: async () => up, sleep: async () => { up = true; } });
    up = false;
    win.fail(RENDERER);
    await flush();
    await flush();
    expect(win.loads.slice(1, 3)).toEqual([expect.stringMatching(/^data:text\/html/), RENDERER]);
  });

  it("starts one wait for a burst of failures, not several", async () => {
    const win = fakeWindow();
    let up = true;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await loadDevRenderer(win, {
      rendererUrl: RENDERER,
      probe: async () => up,
      sleep: async () => { await gate; up = true; },
    });
    up = false;
    win.fail(RENDERER);
    win.fail(RENDERER);
    win.fail(RENDERER);
    await flush();
    const waitingPages = win.loads.filter((u) => u.startsWith("data:"));
    expect(waitingPages).toHaveLength(1);
    release();
    await flush();
    await flush();
    expect(win.loads.at(-1)).toBe(RENDERER);
  });

  it("recovers again from a load that fails right after a recovery", async () => {
    const win = fakeWindow();
    let up = true;
    await loadDevRenderer(win, { rendererUrl: RENDERER, probe: async () => up, sleep: async () => { up = true; } });
    for (let i = 0; i < 2; i++) {
      up = false;
      win.fail(RENDERER);
      await flush();
      await flush();
    }
    expect(win.loads.filter((u) => u === RENDERER)).toHaveLength(3);
  });

  it("ignores a navigation that was merely superseded, and a subframe's failure", async () => {
    const win = fakeWindow();
    await loadDevRenderer(win, { rendererUrl: RENDERER, probe: async () => true, sleep: async () => undefined });
    win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", RENDERER, true);
    win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", RENDERER, false);
    await flush();
    expect(win.loads).toEqual([RENDERER]);
  });

  it("stops waiting for a window that has closed", async () => {
    const win = fakeWindow();
    let probes = 0;
    await loadDevRenderer(win, {
      rendererUrl: RENDERER,
      probe: async () => { if (++probes === 3) win.destroyed = true; return false; },
      sleep: async () => undefined,
    });
    expect(win.loads.every((u) => u.startsWith("data:"))).toBe(true);
  });
});
