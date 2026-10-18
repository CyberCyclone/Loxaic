/**
 * Loading one page in a conversation's browser and reading it (#281): the
 * rendered text a person would see, and on request a screenshot.
 *
 * Every step is bounded by the admin's action timeout and the run's abort
 * signal. A page that stops answering (a busy-looping script holds the
 * renderer, so `evaluate` never returns) gets the whole conversation browser
 * closed, because nothing short of that is sure to free it.
 */
import { getBrowserSettings } from "../settings.ts";
import { pageBudget } from "./intercept.ts";
import { BrowserUnavailableError, closeConversationBrowser, withConversationBrowser } from "./manager.ts";
import type { PageLike } from "./types.ts";

export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
const TITLE_MAX_CHARS = 300;
const NETWORK_IDLE_MAX_MS = 5_000;

export interface RenderResult {
  /** The document's HTTP status, or null when the browser reported none. */
  status: number | null;
  finalUrl: string;
  title: string;
  /** `innerText`, sliced inside the page to `maxTextChars + 1` so a page
   * cannot push more than that across CDP into this process. */
  text: string;
  image?: { bytes: Buffer; mime: "image/png" };
}

/** A page that could not be loaded or read; the message says why. */
export class RenderError extends Error {}

class Deadline extends Error {}

/** Rejects when `ms` passes or `signal` aborts, whichever is first. */
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RenderError("Stopped."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RenderError("Stopped."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Deadline());
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** The first line of a Playwright error, without its call log. */
function playwrightReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n").find((l) => l.trim().length > 0) ?? message).replace(/^page\.\w+:\s*/, "");
}

/** Runs in the page: the visible text and title, cut to size before they leave
 * the renderer. Source text rather than a function, so no bundler's helpers
 * (esbuild's `__name` under keepNames) end up in code that runs where they do
 * not exist. */
const READ_PAGE = `(max) => {
  const body = document.body;
  return { text: (body ? body.innerText : "").slice(0, max), title: String(document.title).slice(0, ${String(TITLE_MAX_CHARS)}) };
}`;

async function load(page: PageLike, url: URL, opts: { screenshot: boolean; maxTextChars: number; timeoutMs: number }): Promise<RenderResult> {
  const started = Date.now();
  const left = (): number => Math.max(1, opts.timeoutMs - (Date.now() - started));
  const response = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: left() });
  // A page that keeps polling never goes idle; what it has drawn by then is
  // what it has.
  await page.waitForLoadState("networkidle", { timeout: Math.min(NETWORK_IDLE_MAX_MS, left()) }).catch(() => undefined);
  const read = await page.evaluate<{ text: string; title: string }>(`(${READ_PAGE})(${String(opts.maxTextChars + 1)})`);
  const result: RenderResult = {
    status: response ? response.status() : null,
    finalUrl: (pageBudget(page).documentUrl ?? page.url()).slice(0, 2048),
    title: read.title.slice(0, TITLE_MAX_CHARS),
    text: read.text,
  };
  if (opts.screenshot) {
    const bytes = await page.screenshot({ type: "png", fullPage: false, timeout: left() });
    if (bytes.length > SCREENSHOT_MAX_BYTES) {
      throw new RenderError(`The screenshot was ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the 4 MB limit.`);
    }
    result.image = { bytes, mime: "image/png" };
  }
  return result;
}

/**
 * Loads `url` in `conversationId`'s own browser and reads it. The URL must be
 * http(s); the caller has already parsed it. Throws `RenderError` or
 * `BrowserUnavailableError` with a message meant for the model.
 */
export async function renderPage(
  conversationId: string,
  url: URL,
  opts: { screenshot: boolean; maxTextChars: number; signal?: AbortSignal },
): Promise<RenderResult> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RenderError(`Only http and https pages can be opened (got ${url.protocol}).`);
  }
  const { actionTimeoutMs } = getBrowserSettings();
  return await withConversationBrowser(conversationId, async (context) => {
    const page = await context.newPage();
    let wedged = false;
    try {
      return await bounded(load(page, url, { ...opts, timeoutMs: actionTimeoutMs }), actionTimeoutMs + 2_000, opts.signal);
    } catch (err) {
      // Playwright's own deadlines (goto, screenshot) end the same way as ours:
      // a page that ran out its time may be holding the renderer.
      if (err instanceof Deadline || (err instanceof Error && err.name === "TimeoutError")) {
        wedged = true;
        throw new RenderError(`The page did not finish loading within ${String(Math.round(actionTimeoutMs / 1000))} s.`);
      }
      if (err instanceof RenderError || err instanceof BrowserUnavailableError) {
        if (err.message === "Stopped.") wedged = true;
        throw err;
      }
      // The interception's own reason (a private address, a page over budget)
      // says more than Chromium's net::ERR_BLOCKED_BY_CLIENT.
      throw new RenderError(pageBudget(page).refusal ?? playwrightReason(err));
    } finally {
      if (wedged) {
        // A page that ignores its deadline may ignore close() too.
        void closeConversationBrowser(conversationId);
      } else {
        await bounded(page.close({ runBeforeUnload: false }), 5_000).catch(() => {
          void closeConversationBrowser(conversationId);
        });
      }
    }
  }, opts.signal);
}
