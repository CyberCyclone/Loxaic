import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __activeBrowserCount,
  __resetBrowsersForTest,
  __setChromiumLoaderForTest,
  __setSlotWaitMsForTest,
  BrowserUnavailableError,
  closeAllBrowsers,
  closeConversationBrowser,
  desktopUserAgent,
  sweepIdle,
  withConversationBrowser,
} from "../manager.ts";
import { closeSinkhole } from "../sinkhole.ts";
import type { BrowserContextLike, BrowserLike, ChromiumLike, LaunchOptions } from "../types.ts";

/** One conversation's browser per process (#281), with a fake Chromium. */
interface FakeBrowser extends BrowserLike {
  closed: boolean;
  crash: () => void;
  options: LaunchOptions;
}

let launched: FakeBrowser[] = [];
let launchGate: Promise<void> | null = null;
let failLaunch: Error | null = null;

const fakeChromium: ChromiumLike = {
  async launch(options) {
    if (launchGate) await launchGate;
    if (failLaunch) throw failLaunch;
    let onDisconnect: (() => void) | null = null;
    const context: BrowserContextLike = {
      newPage: () => Promise.reject(new Error("not used")),
      route: () => Promise.resolve(),
      routeWebSocket: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const browser: FakeBrowser = {
      closed: false,
      options,
      newContext: () => Promise.resolve(context),
      version: () => "156.0.8078.4",
      close: () => {
        browser.closed = true;
        onDisconnect?.();
        return Promise.resolve();
      },
      on: (_event, listener) => { onDisconnect = listener; },
      crash: () => {
        browser.closed = true;
        onDisconnect?.();
      },
    };
    launched.push(browser);
    return browser;
  },
};

const hold = () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
};

beforeEach(() => {
  launched = [];
  launchGate = null;
  failLaunch = null;
  process.env.BROWSER_ENABLED = "true";
  process.env.BROWSER_MAX = "2";
  process.env.BROWSER_EXECUTABLE = "/fake/chrome";
  delete process.env.BROWSER_NO_SANDBOX;
  __setChromiumLoaderForTest(() => Promise.resolve(fakeChromium));
  __setSlotWaitMsForTest(300);
});

afterEach(async () => {
  await __resetBrowsersForTest();
  await closeSinkhole();
  for (const k of ["BROWSER_ENABLED", "BROWSER_MAX", "BROWSER_EXECUTABLE", "BROWSER_IDLE_MS"]) Reflect.deleteProperty(process.env, k);
});

const use = (conv: string) => withConversationBrowser(conv, () => Promise.resolve(conv));

describe("the per-conversation browser", () => {
  it("launches one browser per conversation and reuses it", async () => {
    await use("a");
    await use("a");
    await use("b");
    expect(launched).toHaveLength(2);
  });

  it("launches once when two calls for one conversation race", async () => {
    let open!: () => void;
    launchGate = new Promise<void>((resolve) => { open = resolve; });
    const both = Promise.all([use("a"), use("a")]);
    await new Promise((r) => setTimeout(r, 20));
    open();
    await both;
    expect(launched).toHaveLength(1);
  });

  it("keeps Chromium's own sandbox on unless BROWSER_NO_SANDBOX says otherwise, and points its network at the sinkhole", async () => {
    await use("a");
    expect(launched[0].options.chromiumSandbox).toBe(true);
    expect(launched[0].options.args).toContain("--proxy-bypass-list=<-loopback>");
    expect(launched[0].options.args.some((a) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(a))).toBe(true);
    process.env.BROWSER_NO_SANDBOX = "1";
    await use("b");
    expect(launched[1].options.chromiumSandbox).toBe(false);
  });

  it("evicts the least recently used idle browser when the cap is reached", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await use("a");
    await tick();
    await use("b");
    await tick();
    await use("a");
    await tick();
    await use("c");
    expect(launched[1].closed).toBe(true); // b was the least recently used
    expect(launched[0].closed).toBe(false);
    expect(__activeBrowserCount()).toBe(2);
  });

  it("never evicts a browser in use: it waits for a slot, then says every browser is busy", async () => {
    const a = hold();
    const b = hold();
    const holdingA = withConversationBrowser("a", () => a.held);
    const holdingB = withConversationBrowser("b", () => b.held);
    await new Promise((r) => setTimeout(r, 20));
    await expect(use("c")).rejects.toThrow(/Every browser on this server is busy/);
    expect(launched.every((x) => !x.closed)).toBe(true);
    // Once one is free again, the next call gets a slot by evicting it.
    a.release();
    await holdingA;
    await use("c");
    expect(launched[0].closed).toBe(true);
    b.release();
    await holdingB;
  });

  it("closes browsers left idle, never one in use", async () => {
    process.env.BROWSER_IDLE_MS = "60000";
    const busy = hold();
    await use("idle");
    const holding = withConversationBrowser("busy", () => busy.held);
    await new Promise((r) => setTimeout(r, 20));
    expect(await sweepIdle(Date.now() + 120_000)).toBe(1);
    expect(launched[0].closed).toBe(true);
    expect(launched[1].closed).toBe(false);
    busy.release();
    await holding;
  });

  it("forgets a crashed browser and launches a fresh one", async () => {
    await use("a");
    launched[0].crash();
    await use("a");
    expect(launched).toHaveLength(2);
  });

  it("closes a conversation's browser when asked, and only that one", async () => {
    await use("a");
    await use("b");
    await closeConversationBrowser("a");
    expect(launched[0].closed).toBe(true);
    expect(launched[1].closed).toBe(false);
  });

  it("leaves nothing running when browsing is switched off while a launch is under way", async () => {
    let open!: () => void;
    launchGate = new Promise<void>((resolve) => { open = resolve; });
    const pending = use("a");
    await new Promise((r) => setTimeout(r, 20));
    await closeAllBrowsers();
    open();
    await expect(pending).rejects.toThrow(BrowserUnavailableError);
    expect(launched[0].closed).toBe(true);
    expect(__activeBrowserCount()).toBe(0);
  });

  it("refuses when browsing is off or no browser is installed, and reports a failed launch", async () => {
    process.env.BROWSER_ENABLED = "false";
    await expect(use("a")).rejects.toThrow(/Web browsing is off/);
    process.env.BROWSER_ENABLED = "true";
    delete process.env.BROWSER_EXECUTABLE;
    process.env.BROWSER_DIR = "/nonexistent-browser-dir";
    await expect(use("a")).rejects.toThrow(/No browser is installed/);
    delete process.env.BROWSER_DIR;
    process.env.BROWSER_EXECUTABLE = "/fake/chrome";
    failLaunch = new Error("No usable sandbox!\nmore detail");
    await expect(use("a")).rejects.toThrow("Chromium could not start: No usable sandbox!");
  });
});

describe("desktopUserAgent", () => {
  it("is a desktop Chrome agent for the installed version, without HeadlessChrome", () => {
    expect(desktopUserAgent("156.0.8078.4", "linux")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
    expect(desktopUserAgent("156.0.8078.4", "darwin")).toContain("Macintosh");
    expect(desktopUserAgent("156.0.8078.4", "win32")).toContain("Windows NT 10.0");
  });
});
