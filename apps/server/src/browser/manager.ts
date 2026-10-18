/**
 * One Chromium per conversation, for web_fetch's fallback (#281).
 *
 * Each conversation that needs a browser gets its own Chromium **process**,
 * launched with a fresh temporary profile that Playwright deletes on close, and
 * one context inside it. Cookies, storage, cache and history therefore never
 * meet another conversation's, the same user's included, and a renderer
 * compromised by one page is in a different process from every other chat's.
 *
 * Keyed by conversation id and nothing else: the only caller is the run engine,
 * which passes the id of the conversation it is running. There is no API that
 * takes a session, a port or a path, so nothing a model or a person types can
 * name another conversation's browser.
 *
 * This file is the only importer of playwright-core (see types.ts).
 */
import { getBrowserSettings } from "../settings.ts";
import { installInterception } from "./intercept.ts";
import { configuredExecutable, installState, managedExecutable, systemBrowsers, type InstallState } from "./install.ts";
import { sinkholePort } from "./sinkhole.ts";
import type { BrowserContextLike, BrowserLike, ChromiumLike } from "./types.ts";

/** The browser could not be had; the message is for the model and the person. */
export class BrowserUnavailableError extends Error {}

interface Entry {
  conversationId: string;
  browser: BrowserLike;
  context: BrowserContextLike;
  /** Calls holding this browser right now. Idle closing and eviction skip an
   * entry in use, so a page is never pulled out from under a running fetch. */
  inUse: number;
  lastUsedAt: number;
  closed: boolean;
}

const active = new Map<string, Entry>();
const launching = new Map<string, Promise<Entry>>();
/** Bumped by `closeAllBrowsers`. A launch that finishes under an older value
 * closes itself instead of joining `active`, so switching browsing off while
 * one starts leaves nothing running. */
let generation = 0;
let lastLaunchError: string | null = null;

/** A browser a launch can use, and where it came from. */
export interface LaunchChoice {
  executable: string;
  source: "configured" | "managed" | "system";
  name?: string;
}

/** The choice that last launched, tried first next time, so a host where only
 * the system browser can sandbox does not re-try the managed one every time. */
let lastGood: LaunchChoice | null = null;

/**
 * What to try, in order. A browser the deployment named is used alone. Else
 * Loxaic's own build, which is the tested version, then any browser the system
 * already lets sandbox (install.ts's systemBrowsers). Never a launch without
 * Chromium's sandbox: that is only BROWSER_NO_SANDBOX, for a container.
 */
export function launchChoices(): LaunchChoice[] {
  const configured = configuredExecutable();
  if (configured) return [{ executable: configured, source: "configured" }];
  const choices: LaunchChoice[] = [];
  const managed = managedExecutable();
  if (managed) choices.push({ executable: managed, source: "managed" });
  for (const b of systemBrowsers()) choices.push({ executable: b.executable, source: "system", name: b.name });
  const previous = lastGood;
  const first = previous ? choices.findIndex((c) => c.executable === previous.executable) : -1;
  if (first > 0) choices.unshift(...choices.splice(first, 1));
  return choices;
}

function isSandboxFailure(err: unknown): boolean {
  return /No usable sandbox|sandboxing failed/i.test(err instanceof Error ? err.message : String(err));
}

/** What an admin reads when no browser this host has can run sandboxed. */
export const SANDBOX_BLOCKED_REASON =
  "This system does not let a downloaded browser use Chromium's sandbox (Ubuntu 23.10 and later restrict it). " +
  "Install Google Chrome, Microsoft Edge or Brave from its .deb and browsing will use it, sandboxed. No setting needs changing.";
const waiters = new Set<() => void>();
let sweeper: NodeJS.Timeout | null = null;

let SLOT_WAIT_MS = 20_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

/** The specifier is a variable so tsc never loads playwright-core's own
 * declarations (see types.ts); the module is the same at run time. */
const PLAYWRIGHT = "playwright-core";
let loadChromium = async (): Promise<ChromiumLike> => {
  const mod = (await import(PLAYWRIGHT)) as { chromium: ChromiumLike };
  return mod.chromium;
};

function notify(): void {
  for (const wake of [...waiters]) wake();
}

/** The flags that matter to containment; everything else is Playwright's own
 * automation defaults (which already switch off background networking,
 * component updates, sync and first-run). */
export function chromiumArgs(sinkhole: number): string[] {
  return [
    // Chromium's own network goes to the sinkhole (sinkhole.ts). Without
    // `<-loopback>` Chromium never proxies localhost, and a page could reach
    // services on this host through any request interception missed.
    `--proxy-server=http://127.0.0.1:${String(sinkhole)}`,
    "--proxy-bypass-list=<-loopback>",
    // WebRTC's UDP never goes through a proxy or the interception.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/**
 * Why a launch failed, in words an admin can act on. Playwright's first line
 * is a generic "Target page, context or browser has been closed"; the cause is
 * in Chromium's own log further down the message. The one that matters most
 * is the sandbox: Ubuntu 23.10+ restricts unprivileged user namespaces, which
 * Chromium's sandbox needs, except for browsers it exempts by path.
 */
export function launchFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (isSandboxFailure(err)) return SANDBOX_BLOCKED_REASON;
  const fatal = /FATAL:[^\]]*\]\s*([^\n]+)/.exec(message);
  if (fatal) return fatal[1].slice(0, 300);
  return (message.split("\n").find((l) => l.trim().length > 0) ?? "unknown error").replace(/^browserType\.launch:\s*/, "");
}

/** A desktop Chrome user agent for the installed version. The headless build
 * announces itself as "HeadlessChrome", which is exactly what the bot walls
 * this fallback exists to get past refuse. */
export function desktopUserAgent(version: string, platform: NodeJS.Platform = process.platform): string {
  const major = version.split(".")[0] || "120";
  const os =
    platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64"
    : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function launchEntry(conversationId: string, gen: number): Promise<Entry> {
  const choices = launchChoices();
  if (choices.length === 0) {
    throw new BrowserUnavailableError("No browser is installed on this server. An admin can install one under Settings → Web browsing.");
  }
  const port = await sinkholePort();
  const chromium = await loadChromium();
  let browser: BrowserLike | null = null;
  for (const choice of choices) {
    try {
      browser = await chromium.launch({
        executablePath: choice.executable,
        headless: true,
        // Chromium's own sandbox stays on. BROWSER_NO_SANDBOX is for a server
        // that already runs in a container, where the namespaces it needs are
        // absent and the container is the boundary; it has no switch in the UI.
        chromiumSandbox: process.env.BROWSER_NO_SANDBOX !== "1",
        args: chromiumArgs(port),
        timeout: LAUNCH_TIMEOUT_MS,
      });
      lastGood = choice;
      break;
    } catch (err) {
      // Only the sandbox is worth another browser: a system browser this host
      // exempts may manage where Loxaic's own build cannot. Anything else is
      // reported as it is rather than hidden behind a second attempt.
      if (isSandboxFailure(err)) {
        lastLaunchError = SANDBOX_BLOCKED_REASON;
        continue;
      }
      lastLaunchError = launchFailureReason(err);
      throw new BrowserUnavailableError(`Chromium could not start: ${lastLaunchError}`);
    }
  }
  if (!browser) throw new BrowserUnavailableError(`Chromium could not start: ${SANDBOX_BLOCKED_REASON}`);
  lastLaunchError = null;
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      userAgent: desktopUserAgent(browser.version()),
      javaScriptEnabled: true,
    });
    await installInterception(context);
    if (gen !== generation || !getBrowserSettings().enabled) {
      throw new BrowserUnavailableError("Web browsing was turned off.");
    }
    const entry: Entry = { conversationId, browser, context, inUse: 0, lastUsedAt: Date.now(), closed: false };
    browser.on("disconnected", () => {
      // A crash or an external kill: forget it, so the next call launches a
      // fresh one rather than handing out a dead browser.
      entry.closed = true;
      if (active.get(conversationId) === entry) active.delete(conversationId);
      notify();
    });
    active.set(conversationId, entry);
    ensureSweeper();
    return entry;
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

async function closeEntry(entry: Entry): Promise<void> {
  entry.closed = true;
  if (active.get(entry.conversationId) === entry) active.delete(entry.conversationId);
  notify();
  await entry.browser.close().catch(() => undefined);
}

function waitForSlot(deadline: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BrowserUnavailableError("Stopped."));
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      waiters.delete(done);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      waiters.delete(done);
      reject(new BrowserUnavailableError("Stopped."));
    };
    const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    waiters.add(done);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Hands back this conversation's browser with its use count taken. */
async function acquire(conversationId: string, signal?: AbortSignal): Promise<Entry> {
  const deadline = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    if (signal?.aborted) throw new BrowserUnavailableError("Stopped.");
    const settings = getBrowserSettings();
    if (!settings.enabled) throw new BrowserUnavailableError("Web browsing is off on this server.");

    const existing = active.get(conversationId);
    if (existing && !existing.closed) {
      existing.inUse++;
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const pending = launching.get(conversationId);
    if (pending) {
      // A launch already under way for this conversation: share its outcome.
      // Success put it in `active` for the next pass; failure is this call's
      // failure too, rather than a second launch straight into the same error.
      await pending;
      continue;
    }

    if (active.size + launching.size >= settings.maxBrowsers) {
      const idle = [...active.values()].filter((e) => e.inUse === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const victim = idle.at(0);
      if (victim) {
        await closeEntry(victim);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new BrowserUnavailableError(
          `Every browser on this server is busy (${String(settings.maxBrowsers)} at once). Try again shortly, or ask an admin to allow more.`,
        );
      }
      await waitForSlot(deadline, signal);
      continue;
    }

    // No await between the capacity check above and this set, so two calls
    // cannot both take the last slot.
    const promise = launchEntry(conversationId, generation);
    launching.set(conversationId, promise);
    try {
      await promise;
    } finally {
      if (launching.get(conversationId) === promise) launching.delete(conversationId);
      notify();
    }
  }
}

/**
 * Runs `fn` with this conversation's browser context, launching it if needed.
 * The context belongs to the conversation; `fn` opens and closes its own page.
 */
export async function withConversationBrowser<T>(
  conversationId: string,
  fn: (context: BrowserContextLike) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const entry = await acquire(conversationId, signal);
  try {
    return await fn(entry.context);
  } finally {
    entry.inUse = Math.max(0, entry.inUse - 1);
    entry.lastUsedAt = Date.now();
    notify();
  }
}

/** Closes this conversation's browser even if a call holds it: used when a
 * page stopped answering, where the process may be wedged, and when the
 * conversation is deleted. */
export async function closeConversationBrowser(conversationId: string): Promise<void> {
  const pending = launching.get(conversationId);
  if (pending) await pending.catch(() => undefined);
  const entry = active.get(conversationId);
  if (entry) await closeEntry(entry);
}

/** Closes every browser, and any launch still starting closes itself. */
export async function closeAllBrowsers(): Promise<void> {
  generation++;
  await Promise.all([...active.values()].map((e) => closeEntry(e)));
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepIdle(); }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

/** Closes browsers unused for longer than `idleMs`. Exported for tests. */
export async function sweepIdle(now = Date.now()): Promise<number> {
  const { idleMs, enabled } = getBrowserSettings();
  const stale = [...active.values()].filter((e) => !enabled || (e.inUse === 0 && now - e.lastUsedAt > idleMs));
  await Promise.all(stale.map((e) => closeEntry(e)));
  if (active.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  return stale.length;
}

export interface BrowserStatus {
  install: InstallState;
  /** The browser the last launch used, once one has. */
  using: LaunchChoice | null;
  running: number;
  /** Why the last launch failed, e.g. Chromium's sandbox needing user
   * namespaces this host does not allow. Cleared by the next good launch. */
  lastLaunchError: string | null;
}

export function browserStatus(): BrowserStatus {
  return { install: installState(), using: lastGood, running: active.size, lastLaunchError };
}

export function __setChromiumLoaderForTest(loader: () => Promise<ChromiumLike>): void {
  loadChromium = loader;
}

export function __setSlotWaitMsForTest(ms: number): void {
  SLOT_WAIT_MS = ms;
}

export async function __resetBrowsersForTest(): Promise<void> {
  await closeAllBrowsers();
  launching.clear();
  lastLaunchError = null;
  lastGood = null;
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

export function __activeBrowserCount(): number {
  return active.size;
}
