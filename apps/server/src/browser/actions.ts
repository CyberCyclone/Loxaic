/**
 * The `browse` actions (#281), as a function of a page driver.
 *
 * Split from the tool wiring and from Playwright on purpose: this is where the
 * model's intent meets the browser, and every decision in it (what a failed
 * navigation returns, how big a screenshot may be, what text is handed over) is
 * testable against a stub driver in `__tests__/browse-actions.test.ts` rather
 * than only against a real Chromium.
 *
 * Output is always a `BrowseResult`: a string the model reads, plus at most one
 * image the chat can show. Nothing here throws for a page's behaviour — a 404,
 * a timeout, a selector that matches nothing all come back as `ok: false` with a
 * sentence, because the tool loop treats a thrown error as a broken tool and a
 * refusal as an answer the model can act on.
 */
import { BROWSE_ACTIONS, MUTATING_BROWSE_ACTIONS, type BrowseAction } from "@loxaic/agent";
import type { PageDriver } from "./driver.ts";

export type { BrowseAction };
export { BROWSE_ACTIONS, READ_ONLY_BROWSE_ACTIONS } from "@loxaic/agent";

/** Mutating means the page itself changes: what a click does, what a form
 * holds. Planning mode refuses these (see READ_ONLY_BROWSE_ACTIONS there), and
 * the list lives in @loxaic/agent so the schema and the refusal cannot drift. */

/** Ceiling on extracted text. Matches `web_fetch`'s `WEB_FETCH_MAX_BYTES`: the
 * same argument applies — past this the model is reading noise, and the tokens
 * come out of the conversation's window. */
export const BROWSE_TEXT_MAX_BYTES = 100 * 1024;

/** Largest screenshot kept. A full-page PNG of a long marketing page runs to
 * several megabytes; this is per screenshot and it is also what the vision
 * backend has to fit in its own budget. */
export const BROWSE_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

export interface BrowseResult {
  output: string;
  ok: boolean;
  /** A screenshot, stored as an attachment by the caller. One per call: a model
   * that wants three views takes three screenshots, and each is a decision it
   * can see the result of. */
  image?: { bytes: Buffer; mime: "image/png" | "image/jpeg" };
}

export interface BrowseArgs {
  action: BrowseAction;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  pixels?: number;
  loadState?: "load" | "domcontentloaded" | "networkidle";
}

export interface BrowseCallOptions {
  /** Planning mode: mutating actions are refused. */
  planning?: boolean;
  /** Abort from the run: a stopped run must not leave a page action running. */
  signal?: AbortSignal;
}

const MUTATING = new Set<string>(MUTATING_BROWSE_ACTIONS);

function refusal(message: string): BrowseResult {
  return { ok: false, output: message };
}

function truncateText(text: string): string {
  if (text.length <= BROWSE_TEXT_MAX_BYTES) return text;
  return `${text.slice(0, BROWSE_TEXT_MAX_BYTES)}\n… [truncated at ${String(BROWSE_TEXT_MAX_BYTES)} characters of rendered text]`;
}

function requireArg(args: BrowseArgs, field: keyof BrowseArgs, action: string): string | BrowseResult {
  const value = args[field];
  if (typeof value === "string" && value.length > 0) return value;
  return refusal(`The ${action} action needs "${String(field)}".`);
}

/**
 * Runs one action. `driver` is the session's page; `describe` names the target
 * for the sentence the model reads back, so a result says what it did to what.
 */
export async function runBrowseAction(
  driver: PageDriver,
  args: BrowseArgs,
  options: BrowseCallOptions = {},
): Promise<BrowseResult> {
  const action = args.action;
  if (!BROWSE_ACTIONS.includes(action)) return refusal(`Unknown browse action: ${String(action)}`);
  if (options.planning && MUTATING.has(action)) {
    return refusal(`Planning mode reads pages only; "${action}" would change one.`);
  }
  if (options.signal?.aborted) return refusal("Stopped before this browse action ran.");

  try {
    switch (action) {
      case "goto": {
        const url = requireArg(args, "url", "goto");
        if (typeof url !== "string") return url;
        const response = await driver.goto(url);
        const status = response.status;
        const note = status === null ? "" : status >= 400 ? ` (HTTP ${String(status)})` : "";
        return {
          ok: status === null || status < 400,
          output: `Loaded ${driver.url()}${note}. Title: ${await safeTitle(driver)}`,
        };
      }
      case "back":
        await driver.goBack();
        return { ok: true, output: `Back to ${driver.url()}.` };
      case "forward":
        await driver.goForward();
        return { ok: true, output: `Forward to ${driver.url()}.` };
      case "reload":
        await driver.reload();
        return { ok: true, output: `Reloaded ${driver.url()}.` };
      case "text": {
        const text = await driver.renderedText();
        return { ok: true, output: truncateText(text.length > 0 ? text : "(no rendered text on this page)") };
      }
      case "links": {
        const links = await driver.links();
        if (links.length === 0) return { ok: true, output: "(no links on this page)" };
        return { ok: true, output: truncateText(links.map((l) => `- ${l.text || "(no text)"} → ${l.href}`).join("\n")) };
      }
      case "screenshot": {
        const type = args.format === "jpeg" ? "jpeg" : "png";
        const bytes = await driver.screenshot(args.fullPage === true, type);
        if (bytes.length > BROWSE_SCREENSHOT_MAX_BYTES) {
          // Refuse rather than resize: resizing needs an image library in the
          // server, and silently returning a smaller image would be a claim
          // about the page the model cannot trust.
          return refusal(
            `The screenshot is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the ${(BROWSE_SCREENSHOT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB limit. Take the viewport instead of the full page, or use "text".`,
          );
        }
        const mime = type === "jpeg" ? "image/jpeg" : "image/png";
        return {
          ok: true,
          output: `Screenshot of ${driver.url()} (${args.fullPage ? "full page" : "viewport"}, ${type}).`,
          image: { bytes, mime },
        };
      }
      case "click": {
        const selector = requireArg(args, "selector", "click");
        if (typeof selector !== "string") return selector;
        await driver.click(selector);
        return { ok: true, output: `Clicked ${selector}. Now at ${driver.url()}.` };
      }
      case "type": {
        const selector = requireArg(args, "selector", "type");
        if (typeof selector !== "string") return selector;
        const text = requireArg(args, "text", "type");
        if (typeof text !== "string") return text;
        await driver.fill(selector, text);
        return { ok: true, output: `Typed into ${selector}.` };
      }
      case "press": {
        const key = requireArg(args, "key", "press");
        if (typeof key !== "string") return key;
        // The selector is optional: pressing a key with none is a key press on
        // the page, which is what a shortcut like Escape means.
        const selector = typeof args.selector === "string" && args.selector.length > 0 ? args.selector : "body";
        await driver.press(selector, key);
        return { ok: true, output: `Pressed ${key}${args.selector ? ` on ${args.selector}` : ""}.` };
      }
      case "select": {
        const selector = requireArg(args, "selector", "select");
        if (typeof selector !== "string") return selector;
        const value = requireArg(args, "text", "select");
        if (typeof value !== "string") return value;
        await driver.selectOption(selector, value);
        return { ok: true, output: `Selected ${value} in ${selector}.` };
      }
      case "hover": {
        const selector = requireArg(args, "selector", "hover");
        if (typeof selector !== "string") return selector;
        await driver.hover(selector);
        return { ok: true, output: `Hovered ${selector}.` };
      }
      case "scroll": {
        const pixels = typeof args.pixels === "number" && Number.isFinite(args.pixels) ? args.pixels : 720;
        await driver.scrollBy(pixels);
        return { ok: true, output: `Scrolled ${String(pixels)}px.` };
      }
      case "wait": {
        // A selector is the useful wait ("until the thing I am about to click
        // exists"). Without one, load state — and `networkidle` is what an SPA
        // needs, which is the whole reason the browser exists.
        if (typeof args.selector === "string" && args.selector.length > 0) {
          await driver.waitForSelector(args.selector);
          return { ok: true, output: `${args.selector} is present.` };
        }
        const state = args.loadState === "load" || args.loadState === "domcontentloaded" ? args.loadState : "networkidle";
        await driver.waitForLoadState(state);
        return { ok: true, output: `Page reached ${state}.` };
      }
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Playwright's own messages name the timeout and the selector, which is
    // what makes a wrong selector fixable by the model on the next call.
    return refusal(`browse ${action} failed: ${message}`);
  }
}

/** A title is decoration on a result line; a page that will not answer must not
 * turn a successful navigation into a failure. */
async function safeTitle(driver: PageDriver): Promise<string> {
  try {
    return await driver.title();
  } catch {
    return "(untitled)";
  }
}

/** Whether an action changes the page, for the surfaces that decide by
 * capability rather than by mode. */
export function browseActionMutates(action: BrowseAction): boolean {
  return MUTATING.has(action);
}
