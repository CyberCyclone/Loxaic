import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __activeBrowserCount, __resetBrowsersForTest, __setChromiumLoaderForTest } from "../manager.ts";
import { renderPage } from "../render.ts";
import { closeSinkhole } from "../sinkhole.ts";
import type { BrowserContextLike, BrowserLike, ChromiumLike, PageLike } from "../types.ts";

/** A browser that never opens a page: the step render.ts must still bound. */
describe("renderPage", () => {
  let closed = 0;

  beforeEach(() => {
    process.env.BROWSER_ENABLED = "true";
    process.env.BROWSER_EXECUTABLE = "/fake/chrome";
    process.env.BROWSER_ACTION_TIMEOUT_MS = "5000";
    closed = 0;
    const chromium: ChromiumLike = {
      launch: () => {
        let onDisconnect: (() => void) | undefined;
        const context: BrowserContextLike = {
          newPage: () => new Promise<PageLike>(() => undefined),
          newCDPSession: () => Promise.reject(new Error("unused")),
            addInitScript: () => Promise.resolve(),
          on: () => undefined,
          route: () => Promise.resolve(),
          routeWebSocket: () => Promise.resolve(),
          close: () => Promise.resolve(),
        };
        const browser: BrowserLike = {
          newContext: () => Promise.resolve(context),
          version: () => "156.0.0.0",
          close: () => { closed++; onDisconnect?.(); return Promise.resolve(); },
          on: (_e, l) => { onDisconnect = l; },
        };
        return Promise.resolve(browser);
      },
    };
    __setChromiumLoaderForTest(() => Promise.resolve(chromium));
  });

  afterEach(async () => {
    await __resetBrowsersForTest();
    await closeSinkhole();
    for (const k of ["BROWSER_ENABLED", "BROWSER_EXECUTABLE", "BROWSER_ACTION_TIMEOUT_MS"]) Reflect.deleteProperty(process.env, k);
  });

  it("gives up on a page that never opens, and closes that browser", async () => {
    await expect(renderPage("c", new URL("https://example.com/"), { screenshot: false, maxTextChars: 100 })).rejects.toThrow(
      "The browser did not open a page in time.",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(1);
    expect(__activeBrowserCount()).toBe(0);
  }, 15_000);

  it("stops when the run is stopped while a page is opening", async () => {
    const controller = new AbortController();
    const pending = renderPage("c", new URL("https://example.com/"), { screenshot: false, maxTextChars: 100, signal: controller.signal });
    setTimeout(() => { controller.abort(); }, 200);
    await expect(pending).rejects.toThrow("Stopped.");
  }, 15_000);
});
