import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  launchFailureReason,
  launchChoices,
  browserStatus,
  SANDBOX_BLOCKED_REASON,
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
import { __resetInstallStateForTest, __setSystemBrowsersForTest, rootOwned } from "../install.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
/** A failure per executable, for the fallback between browsers. */
let failFor = new Map<string, Error | (() => Error)>();
/** Every launch, in order: which browser, and whether sandboxed. */
let launches: { executable: string; sandbox: boolean }[] = [];

const fakeChromium: ChromiumLike = {
  async launch(options) {
    if (launchGate) await launchGate;
    launches.push({ executable: options.executablePath, sandbox: options.chromiumSandbox });
    const listed = failFor.get(options.executablePath);
    const failure = (typeof listed === "function" ? listed() : listed) ?? failLaunch;
    if (failure) throw failure;
    let onDisconnect: (() => void) | null = null;
    const context: BrowserContextLike = {
      newPage: () => Promise.reject(new Error("not used")),
      route: () => Promise.resolve(),
      routeWebSocket: () => Promise.resolve(),
      newCDPSession: () => Promise.reject(new Error("unused")),
            addInitScript: () => Promise.resolve(),
      on: () => undefined,
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
  failFor = new Map();
  launches = [];
  process.env.BROWSER_ENABLED = "true";
  process.env.BROWSER_MAX = "2";
  process.env.BROWSER_EXECUTABLE = "/fake/chrome";
  delete process.env.BROWSER_NO_SANDBOX;
  __setChromiumLoaderForTest(() => Promise.resolve(fakeChromium));
  __setSlotWaitMsForTest(300);
});

afterEach(async () => {
  await __resetBrowsersForTest();
  __resetInstallStateForTest();
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
    failLaunch = new Error("browserType.launch: Executable is not executable\nmore detail");
    await expect(use("a")).rejects.toThrow("Chromium could not start: Executable is not executable");
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

describe("launchFailureReason", () => {
  // Playwright's message as Ubuntu 26.04 produced it on a real host, cut down.
  const ubuntu = [
    "browserType.launch: Target page, context or browser has been closed",
    "Browser logs:",
    "Chromium sandboxing failed!",
    "Call log:",
    "  - [pid=168121][err] [1018/205220.402037:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+ ...",
  ].join("\n");

  it("names the sandbox restriction and what to install, not Playwright's generic first line", () => {
    const reason = launchFailureReason(new Error(ubuntu));
    expect(reason).toBe(SANDBOX_BLOCKED_REASON);
    expect(reason).toContain("Install Chromium (sudo apt install chromium-browser) or Google Chrome");
    expect(reason).not.toContain("Target page, context or browser has been closed");
  });

  it("surfaces Chromium's own fatal line for anything else", () => {
    const err = new Error("browserType.launch: Target page, context or browser has been closed\nCall log:\n  - [pid=1][err] [1:FATAL:gpu_init.cc:9] Missing libgbm.so.1");
    expect(launchFailureReason(err)).toBe("Missing libgbm.so.1");
  });

  it("falls back to the first line, without Playwright's prefix", () => {
    expect(launchFailureReason(new Error("browserType.launch: Executable doesn't exist at /x\nmore"))).toBe("Executable doesn't exist at /x");
  });
});

describe("which browser launches (#281)", () => {
  const SANDBOX = new Error("browserType.launch: Target page, context or browser has been closed\n[err] FATAL:zygote_host_impl_linux.cc:130] No usable sandbox!");
  const system = { name: "Google Chrome", executable: "/opt/google/chrome/chrome" };
  let dir: string;
  let managed: string;

  beforeEach(() => {
    delete process.env.BROWSER_EXECUTABLE;
    // A managed install as install.ts looks for one, for this platform.
    dir = mkdtempSync(path.join(tmpdir(), "loxaic-browsers-"));
    const platformDir: Record<string, string> = {
      "darwin-arm64": "chrome-headless-shell-mac-arm64",
      "darwin-x64": "chrome-headless-shell-mac-x64",
      "linux-x64": "chrome-headless-shell-linux64",
      "linux-arm64": "chrome-headless-shell-linux-arm64",
      "win32-x64": "chrome-headless-shell-win64",
    };
    const build = path.join(dir, "chromium_headless_shell-1", platformDir[`${process.platform}-${process.arch}`]);
    mkdirSync(build, { recursive: true });
    managed = path.join(build, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
    writeFileSync(managed, "");
    writeFileSync(path.join(dir, "chromium_headless_shell-1", "INSTALLATION_COMPLETE"), "");
    process.env.BROWSER_DIR = dir;
  });

  afterEach(() => {
    delete process.env.BROWSER_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses Loxaic's own Chromium when its sandbox starts", async () => {
    __setSystemBrowsersForTest([system]);
    await use("a");
    expect(launches).toEqual([{ executable: managed, sandbox: true }]);
    expect(browserStatus().using?.source).toBe("managed");
  });

  it("falls back to a browser the system exempts when only the sandbox stopped Loxaic's own, sandboxed", async () => {
    __setSystemBrowsersForTest([system]);
    failFor.set(managed, SANDBOX);
    await use("a");
    expect(launches).toEqual([{ executable: managed, sandbox: true }, { executable: system.executable, sandbox: true }]);
    expect(browserStatus()).toMatchObject({ using: { source: "system", name: "Google Chrome" }, lastLaunchError: null });
    // And starts with it next time instead of failing on the managed one again.
    await use("b");
    expect(launches.at(-1)?.executable).toBe(system.executable);
    expect(launches).toHaveLength(3);
  });

  it("never launches without the sandbox: with no exempted browser it says what to install", async () => {
    __setSystemBrowsersForTest([]);
    failFor.set(managed, SANDBOX);
    await expect(use("a")).rejects.toThrow(SANDBOX_BLOCKED_REASON);
    expect(launches.every((l) => l.sandbox)).toBe(true);
    expect(browserStatus().lastLaunchError).toBe(`${SANDBOX_BLOCKED_REASON} Tried: Loxaic's Chromium: its sandbox could not start.`);
  });

  it("names every browser it tried when none could sandbox", async () => {
    __setSystemBrowsersForTest([system]);
    failFor.set(managed, SANDBOX);
    failFor.set(system.executable, SANDBOX);
    await expect(use("a")).rejects.toThrow(
      `Tried: Loxaic's Chromium: its sandbox could not start; Google Chrome (${system.executable}): its sandbox could not start.`,
    );
  });

  it("does not hide any other failure behind a second browser", async () => {
    __setSystemBrowsersForTest([system]);
    failFor.set(managed, new Error("browserType.launch: Executable is not executable"));
    await expect(use("a")).rejects.toThrow("Executable is not executable");
    expect(launches).toHaveLength(1);
  });

  it("uses an exempted system browser when nothing was downloaded", async () => {
    rmSync(dir, { recursive: true, force: true });
    __setSystemBrowsersForTest([system]);
    await use("a");
    expect(launches).toEqual([{ executable: system.executable, sandbox: true }]);
  });

  it("uses only the browser the deployment named", async () => {
    process.env.BROWSER_EXECUTABLE = "/named/chrome";
    __setSystemBrowsersForTest([system]);
    failFor.set("/named/chrome", SANDBOX);
    await expect(use("a")).rejects.toThrow(SANDBOX_BLOCKED_REASON);
    expect(launches).toEqual([{ executable: "/named/chrome", sandbox: true }]);
  });

  it("only trusts a system browser root owns and nobody else can write, all the way up", () => {
    expect(rootOwned("/bin/sh")).toBe(true);
    expect(rootOwned(managed)).toBe(false);
    expect(rootOwned("/nonexistent/chrome")).toBe(false);
    // A link the user could repoint, even at a root-owned binary.
    const link = path.join(dir, "chrome-link");
    symlinkSync("/bin/sh", link);
    expect(rootOwned(link)).toBe(false);
  });

  it("checks a system browser again at the moment of launch", async () => {
    let trustedNow = true;
    __setSystemBrowsersForTest([system], () => trustedNow);
    expect(launchChoices().map((c) => c.source)).toEqual(["managed", "system"]);
    // Listed as trusted; swapped out while Loxaic's own build was trying.
    failFor.set(managed, () => {
      trustedNow = false;
      return SANDBOX;
    });
    await expect(use("a")).rejects.toThrow(SANDBOX_BLOCKED_REASON);
    expect(launches.map((l) => l.executable)).toEqual([managed]);
  });
});
