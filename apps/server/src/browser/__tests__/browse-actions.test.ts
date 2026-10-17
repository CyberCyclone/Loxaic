import { describe, expect, it } from "vitest";
import {
  BROWSE_SCREENSHOT_MAX_BYTES,
  BROWSE_TEXT_MAX_BYTES,
  READ_ONLY_BROWSE_ACTIONS,
  browseActionMutates,
  runBrowseAction,
  type BrowseArgs,
} from "../actions.ts";
import type { PageDriver } from "../driver.ts";

/**
 * The browse actions against a stub page (#281). What is under test is what the
 * model receives: the sentence it reads back, whether a call is a failure it can
 * correct, and when a screenshot is refused rather than quietly shrunk.
 */

interface Calls {
  goto: string[];
  clicks: string[];
  fills: [string, string][];
  screenshots: { fullPage: boolean; type: string }[];
  scrolls: number[];
  waits: string[];
}

function stub(over: Partial<PageDriver> = {}): { page: PageDriver; calls: Calls } {
  const calls: Calls = { goto: [], clicks: [], fills: [], screenshots: [], scrolls: [], waits: [] };
  const page: PageDriver = {
    async goto(url) {
      calls.goto.push(url);
      return { status: 200 };
    },
    async goBack() {},
    async goForward() {},
    async reload() {},
    url: () => "https://example.com/page",
    title: async () => "Example",
    content: async () => "<html></html>",
    async screenshot(fullPage, type) {
      calls.screenshots.push({ fullPage, type });
      return Buffer.from("png-bytes");
    },
    async click(selector) {
      calls.clicks.push(selector);
    },
    async fill(selector, value) {
      calls.fills.push([selector, value]);
    },
    async press() {},
    async selectOption() {},
    async hover() {},
    async waitForSelector(selector) {
      calls.waits.push(selector);
    },
    async waitForLoadState(state) {
      calls.waits.push(state);
    },
    async links() {
      return [{ text: "Docs", href: "https://example.com/docs" }];
    },
    async renderedText() {
      return "Rendered body copy.";
    },
    async scrollBy(pixels) {
      calls.scrolls.push(pixels);
    },
    ...over,
  };
  return { page, calls };
}

const run = (page: PageDriver, args: BrowseArgs) => runBrowseAction(page, args);

describe("runBrowseAction", () => {
  it("reports a navigation with its status and title", async () => {
    const { page, calls } = stub();
    const result = await run(page, { action: "goto", url: "https://example.com" });
    expect(result.ok).toBe(true);
    expect(calls.goto).toEqual(["https://example.com"]);
    expect(result.output).toContain("Example");
  });

  it("reports an HTTP error as a failure the model can act on", async () => {
    const { page } = stub({ goto: async () => ({ status: 404 }) });
    const result = await run(page, { action: "goto", url: "https://example.com/gone" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("404");
  });

  it("treats a navigation that returned no response as success without claiming a status", async () => {
    const { page } = stub({ goto: async () => ({ status: null }) });
    const result = await run(page, { action: "goto", url: "https://example.com/file.zip" });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("HTTP");
  });

  it("returns rendered text, not markup", async () => {
    const { page } = stub({ renderedText: async () => "Only what is displayed." });
    const result = await run(page, { action: "text" });
    expect(result.output).toBe("Only what is displayed.");
  });

  it("truncates extracted text at the cap and says so", async () => {
    const { page } = stub({ renderedText: async () => "x".repeat(BROWSE_TEXT_MAX_BYTES + 1000) });
    const result = await run(page, { action: "text" });
    expect(result.output).toContain("truncated at");
    expect(result.output.length).toBeLessThan(BROWSE_TEXT_MAX_BYTES + 200);
  });

  it("lists links with their resolved hrefs", async () => {
    const { page } = stub();
    const result = await run(page, { action: "links" });
    expect(result.output).toContain("https://example.com/docs");
  });

  it("attaches a screenshot and names it in the output", async () => {
    const { page, calls } = stub();
    const result = await run(page, { action: "screenshot" });
    expect(result.ok).toBe(true);
    expect(result.image?.mime).toBe("image/png");
    expect(calls.screenshots).toEqual([{ fullPage: false, type: "png" }]);
  });

  it("honours full page and jpeg", async () => {
    const { page, calls } = stub();
    const result = await run(page, { action: "screenshot", fullPage: true, format: "jpeg" });
    expect(result.image?.mime).toBe("image/jpeg");
    expect(calls.screenshots[0]).toEqual({ fullPage: true, type: "jpeg" });
  });

  it("refuses a screenshot over the cap rather than shrinking it", async () => {
    const { page } = stub({
      screenshot: async () => Buffer.alloc(BROWSE_SCREENSHOT_MAX_BYTES + 1),
    });
    const result = await run(page, { action: "screenshot", fullPage: true });
    expect(result.ok).toBe(false);
    expect(result.image).toBeUndefined();
    // The refusal has to name the way out, or the model retries the same call.
    expect(result.output).toMatch(/viewport|text/);
  });

  it.each([
    ["click", { action: "click" } as BrowseArgs],
    ["type", { action: "type", selector: "#q" } as BrowseArgs],
    ["press", { action: "press" } as BrowseArgs],
    ["select", { action: "select", selector: "#s" } as BrowseArgs],
  ])("refuses %s with no target instead of throwing", async (_name, args) => {
    const { page, calls } = stub();
    const result = await run(page, args);
    expect(result.ok).toBe(false);
    expect(calls.clicks).toEqual([]);
    expect(calls.fills).toEqual([]);
  });

  it("types the value into the selector", async () => {
    const { page, calls } = stub();
    const result = await run(page, { action: "type", selector: "#q", text: "hello" });
    expect(result.ok).toBe(true);
    expect(calls.fills).toEqual([["#q", "hello"]]);
  });

  it("waits for a selector when given one, and for a load state otherwise", async () => {
    const { page, calls } = stub();
    await run(page, { action: "wait", selector: "#ready" });
    await run(page, { action: "wait", loadState: "domcontentloaded" });
    await run(page, { action: "wait" });
    expect(calls.waits).toEqual(["#ready", "domcontentloaded", "networkidle"]);
  });

  it("turns a page error into a refusal that keeps the reason", async () => {
    // Playwright's timeout messages name the selector; that is what makes a
    // wrong selector fixable on the next call rather than a mystery.
    const { page } = stub({ click: async () => { throw new Error('Timeout 30000ms exceeded waiting for selector "#nope"'); } });
    const result = await run(page, { action: "click", selector: "#nope" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("#nope");
  });

  it("refuses an unknown action", async () => {
    const { page } = stub();
    const result = await run(page, { action: "exfiltrate" } as unknown as BrowseArgs);
    expect(result.ok).toBe(false);
  });

  it("does nothing on an already-aborted signal", async () => {
    // The listener-on-an-aborted-signal trap, in the other direction: an action
    // started after Stop must not run at all.
    const controller = new AbortController();
    controller.abort();
    const { page, calls } = stub();
    const result = await runBrowseAction(page, { action: "click", selector: "a" }, { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(calls.clicks).toEqual([]);
  });
});

describe("planning mode", () => {
  it.each(["click", "type", "press", "select", "hover"])("refuses the mutating action %s", async (action) => {
    const { page, calls } = stub();
    const result = await runBrowseAction(page, { action, selector: "a", text: "x", key: "Enter" } as BrowseArgs, { planning: true });
    expect(result.ok).toBe(false);
    expect(calls.clicks).toEqual([]);
  });

  it("offers every read-only action, and the read-only set matches what mutates", () => {
    for (const action of READ_ONLY_BROWSE_ACTIONS) {
      expect(browseActionMutates(action)).toBe(false);
    }
    expect(READ_ONLY_BROWSE_ACTIONS).toContain("screenshot");
    expect(READ_ONLY_BROWSE_ACTIONS).toContain("goto");
    expect(READ_ONLY_BROWSE_ACTIONS.some((a) => browseActionMutates(a))).toBe(false);
  });

  it("still reads in planning mode", async () => {
    const { page } = stub();
    const result = await runBrowseAction(page, { action: "text" }, { planning: true });
    expect(result.ok).toBe(true);
  });
});
