import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __activeBrowserCount, __resetBrowsersForTest, __setChromiumLoaderForTest } from "../manager.ts";
import { renderPage } from "../render.ts";
import { closeSinkhole } from "../sinkhole.ts";
import type { BrowserContextLike, BrowserLike, ChromiumLike, PageLike } from "../types.ts";

/** A browser that never opens a page (the step render.ts must still bound),
 * or opens `openPage` when a test sets it. */
describe("renderPage", () => {
  let closed = 0;
  let openPage: (() => PageLike) | null = null;

  beforeEach(() => {
    process.env.BROWSER_ENABLED = "true";
    process.env.BROWSER_EXECUTABLE = "/fake/chrome";
    process.env.BROWSER_ACTION_TIMEOUT_MS = "5000";
    closed = 0;
    openPage = null;
    const chromium: ChromiumLike = {
      launch: () => {
        let onDisconnect: (() => void) | undefined;
        const context: BrowserContextLike = {
          newPage: () => (openPage ? Promise.resolve(openPage()) : new Promise<PageLike>(() => undefined)),
          newCDPSession: () => Promise.resolve({
            send: <T,>(method: string): Promise<T> => Promise.resolve((method === "Page.getFrameTree"
              ? { frameTree: { frame: { id: "f" } } }
              : method === "Page.createIsolatedWorld"
                ? { executionContextId: 1 }
                : { result: { value: { text: "page text", title: "A page" } } }) as T),
            detach: () => Promise.resolve(),
          }),
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
    await expect(renderPage("c", new URL("https://example.com/"), { screenshot: "none", maxTextChars: 100 })).rejects.toThrow(
      "The browser did not open a page in time.",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(1);
    expect(__activeBrowserCount()).toBe(0);
  }, 15_000);

  /** A page that loads and reads, but whose screenshot fails. */
  function pageWithBrokenScreenshot(): PageLike {
    const frame = { page: (): PageLike => page };
    const page: PageLike = {
      goto: () => Promise.resolve({ status: () => 200 }),
      waitForLoadState: () => Promise.resolve(),
      evaluate: () => Promise.reject(new Error("unused")),
      screenshot: () => Promise.reject(new Error("Protocol error: unable to capture")),
      title: () => Promise.resolve("A page"),
      url: () => "https://example.com/",
      mainFrame: () => frame,
      close: () => Promise.resolve(),
      waitForURL: () => Promise.resolve(),
      on: () => undefined,
    };
    return page;
  }

  it("keeps the page when a screenshot only the person would see fails, and fails when the model asked for it", async () => {
    openPage = pageWithBrokenScreenshot;
    const page = await renderPage("c", new URL("https://example.com/"), { screenshot: "best-effort", maxTextChars: 100 });
    expect(page.text).toBe("page text");
    expect(page.image).toBeUndefined();
    await expect(renderPage("c", new URL("https://example.com/"), { screenshot: "required", maxTextChars: 100 })).rejects.toThrow("unable to capture");
  }, 15_000);

  it("stops when the run is stopped while a page is opening", async () => {
    const controller = new AbortController();
    const pending = renderPage("c", new URL("https://example.com/"), { screenshot: "none", maxTextChars: 100, signal: controller.signal });
    setTimeout(() => { controller.abort(); }, 200);
    await expect(pending).rejects.toThrow("Stopped.");
  }, 15_000);
});
