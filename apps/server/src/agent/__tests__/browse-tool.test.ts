import { describe, expect, it } from "vitest";
import { READ_ONLY_BROWSE_ACTIONS, TOOLS, resolveBuiltinTools, toolRequiresApproval } from "@loxaic/agent";
import { executeTool, type BrowserPageProvider } from "../executor.ts";
import type { PageDriver } from "../../browser/driver.ts";

/**
 * The `browse` tool surface (#281): when it is offered, what planning mode does
 * to it, and what the executor says when there is no browser.
 */

const browseDef = TOOLS.find((t) => t.name === "browse");
const names = (mode?: "planning" | "manual" | "auto", browsing?: boolean) =>
  resolveBuiltinTools(mode, { browsing }).map((t) => t.name);

describe("offering browse", () => {
  it("is absent unless browsing is on", () => {
    expect(names("auto")).not.toContain("browse");
    expect(names("auto", false)).not.toContain("browse");
    expect(names("auto", true)).toContain("browse");
  });

  it("does not wobble with the engine's health: only the setting decides", () => {
    // The tool list is part of the prompt prefix, so a tool that came and went
    // with a container engine's availability would break the backend's cache on
    // every blip. resolveBuiltinTools takes the setting and nothing else — no
    // engine, no probe — which is what keeps that invariant structural.
    expect(resolveBuiltinTools.length).toBeLessThanOrEqual(2);
    expect(names("manual")).not.toContain("browse");
    expect(names("manual", true)).toContain("browse");
  });

  it("is offered in every permission mode when browsing is on", () => {
    for (const mode of ["planning", "manual", "auto"] as const) {
      expect(names(mode, true)).toContain("browse");
    }
  });

  it("is not a write tool, and manual mode asks for it", () => {
    expect(browseDef?.requiresApproval).toBe(false);
    // Manual asks for anything not marked approval-free... it is marked, so
    // manual does not ask: browsing is the same trust class as web_fetch, and
    // the proxy is the boundary rather than the dialog.
    expect(toolRequiresApproval("browse", "manual")).toBe(false);
    expect(toolRequiresApproval("browse", "auto")).toBe(false);
  });

  it("does not need a sandbox", async () => {
    const { toolNeedsSandbox } = await import("../executor.ts");
    // A browser is a separate container with a separate network; putting it in
    // the workspace sandbox would be the isolation the issue rules out.
    expect(toolNeedsSandbox("browse")).toBe(false);
  });
});

describe("planning mode", () => {
  it("offers only the read-only actions in the schema", () => {
    const planning = resolveBuiltinTools("planning", { browsing: true }).find((t) => t.name === "browse");
    const auto = resolveBuiltinTools("auto", { browsing: true }).find((t) => t.name === "browse");
    const offered = (planning?.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    const all = (auto?.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(offered).toEqual([...READ_ONLY_BROWSE_ACTIONS]);
    expect(offered).not.toContain("click");
    expect(all).toContain("click");
  });

  it("describes the read-only contract instead of the full one", () => {
    const planning = resolveBuiltinTools("planning", { browsing: true }).find((t) => t.name === "browse");
    const auto = resolveBuiltinTools("auto", { browsing: true }).find((t) => t.name === "browse");
    expect(planning?.description).not.toBe(auto?.description);
    expect(planning?.description).toMatch(/refused/i);
  });
});

function stubPage(over: Partial<PageDriver> = {}): PageDriver {
  const base: PageDriver = {
    async goto() {
      return { status: 200 };
    },
    async goBack() {},
    async goForward() {},
    async reload() {},
    url: () => "https://example.com",
    title: async () => "Example",
    content: async () => "<html></html>",
    async screenshot() {
      return Buffer.from("png");
    },
    async click() {},
    async fill() {},
    async press() {},
    async selectOption() {},
    async hover() {},
    async waitForSelector() {},
    async waitForLoadState() {},
    async links() {
      return [];
    },
    async renderedText() {
      return "Rendered.";
    },
    async scrollBy() {},
    ...over,
  };
  return base;
}

describe("executeTool with no browser", () => {
  it("browse says there is no session, in a sentence with a way forward", async () => {
    const result = await executeTool(null, "browse", { action: "text" });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/web_fetch|enabled/i);
  });

  it("web_fetch with render says the same, and the plain path still works without one", async () => {
    const rendered = await executeTool(null, "web_fetch", { url: "https://example.com", render: true });
    expect(rendered.ok).toBe(false);
    expect(rendered.output).toMatch(/browser/i);
  });

  it("reports a session that could not start as that, not as a page failure", async () => {
    const browser: BrowserPageProvider = async () => {
      throw new Error("browsing is switched off on this server");
    };
    const result = await executeTool(null, "browse", { action: "text" }, undefined, undefined, { browser });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Could not start a browser session");
  });
});

describe("executeTool with a browser", () => {
  it("browse returns the rendered text", async () => {
    const result = await executeTool(null, "browse", { action: "text" }, undefined, undefined, {
      browser: async () => stubPage(),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Rendered.");
  });

  it("a screenshot comes back as an image, not as text", async () => {
    const result = await executeTool(null, "browse", { action: "screenshot" }, undefined, undefined, {
      browser: async () => stubPage(),
    });
    expect(result.ok).toBe(true);
    expect(result.image?.mime).toBe("image/png");
  });

  it("refuses a mutating action in planning mode before touching the page", async () => {
    let clicked = false;
    const result = await executeTool(
      null,
      "browse",
      { action: "click", selector: "a" },
      undefined,
      undefined,
      { browser: async () => stubPage({ click: async () => { clicked = true; } }), planning: true },
    );
    expect(result.ok).toBe(false);
    expect(clicked).toBe(false);
  });

  it("render: true answers from the rendered text, capped like the plain path", async () => {
    const result = await executeTool(null, "web_fetch", { url: "https://example.com", render: true }, undefined, undefined, {
      browser: async () => stubPage({ renderedText: async () => "y".repeat(200 * 1024) }),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("truncated at");
    // The same ceiling as the fast path: switching to render must not quietly
    // spend more of the window.
    expect(result.output.length).toBeLessThan(110 * 1024);
  });
});
