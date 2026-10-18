import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveBuiltinTools } from "@loxaic/agent";
import { executeTool, shouldRender, type PageRenderer } from "../executor.ts";
import type { RenderResult } from "../../browser/render.ts";

/** When web_fetch falls back to the browser (#281), and what it says when it does. */
describe("shouldRender", () => {
  it.each([401, 403, 406, 429, 451, 503])("renders after a %i", (status) => {
    expect(shouldRender({ status })).toEqual({ render: true, reason: `the plain fetch returned ${String(status)}` });
  });

  it.each([400, 404, 410, 500, 502])("does not render after a %i: a browser gets the same answer", (status) => {
    expect(shouldRender({ status }).render).toBe(false);
  });

  it("renders after a connection a site dropped, not after one that never resolved", () => {
    expect(shouldRender({ networkError: "UND_ERR_SOCKET other side closed" }).render).toBe(true);
    expect(shouldRender({ networkError: "ECONNRESET" }).render).toBe(true);
    expect(shouldRender({ networkError: "could not resolve host: nope.example" }).render).toBe(false);
    expect(shouldRender({ networkError: "Request timed out after 15000ms" }).render).toBe(false);
  });

  it("renders a page that ships script and almost no text", () => {
    const html = "<div id=app></div><script src=app.js></script>";
    expect(shouldRender({ status: 200, contentType: "text/html", html, extractedText: "" })).toEqual({
      render: true,
      reason: "the page builds itself with JavaScript",
    });
  });

  it("does not render a page with real text, a script-free page, or a non-HTML body", () => {
    const text = "word ".repeat(60);
    expect(shouldRender({ status: 200, contentType: "text/html", html: "<script></script>", extractedText: text }).render).toBe(false);
    expect(shouldRender({ status: 200, contentType: "text/html", html: "<p>hi</p>", extractedText: "hi" }).render).toBe(false);
    expect(shouldRender({ status: 200, contentType: "application/json", html: "<script>", extractedText: "" }).render).toBe(false);
  });

  it("never renders an address the guard refused", () => {
    expect(shouldRender({ blocked: true, status: 403 }).render).toBe(false);
  });
});

describe("web_fetch with a renderer", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/walled") { res.writeHead(403); res.end("<p>denied</p>"); return; }
      if (req.url === "/script") { res.end("<div id=app></div><script>render()</script>"); return; }
      if (req.url === "/missing") { res.writeHead(404); res.end("<p>gone</p>"); return; }
      res.end(`<p>${"plain text ".repeat(40)}</p>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${String(port)}`;
    process.env.MOCK_INFERENCE = "true";
    process.env.LOXAIC_E2E_FETCH_ALLOW = `127.0.0.1:${String(port)}`;
  });
  afterAll(() => {
    server.close();
    delete process.env.LOXAIC_E2E_FETCH_ALLOW;
  });

  const page = (over: Partial<RenderResult> = {}): RenderResult => ({
    status: 200, finalUrl: `${base}/walled`, title: "Walled", text: "past the wall", ...over,
  });
  const fetchWith = (url: string, renderer: PageRenderer | null, extra: Record<string, unknown> = {}) =>
    executeTool(null, "web_fetch", { url, ...extra }, undefined, undefined, { renderer });

  it("loads a walled page in the browser and says why", async () => {
    const renderer = vi.fn<PageRenderer>().mockResolvedValue(page());
    const result = await fetchWith(`${base}/walled`, renderer);
    expect(renderer).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[Rendered in a browser: the plain fetch returned 403.]");
    expect(result.output).toContain("past the wall");
  });

  it("loads a script-built page in the browser", async () => {
    const renderer = vi.fn<PageRenderer>().mockResolvedValue(page({ finalUrl: `${base}/script`, text: "drawn" }));
    const result = await fetchWith(`${base}/script`, renderer);
    expect(result.output).toContain("the page builds itself with JavaScript");
  });

  it("answers from the plain fetch alone when it worked, or failed in a way a browser shares", async () => {
    const renderer = vi.fn<PageRenderer>();
    expect((await fetchWith(`${base}/plain`, renderer)).output).toContain("plain text");
    expect((await fetchWith(`${base}/missing`, renderer)).output).toContain("HTTP 404");
    expect(renderer).not.toHaveBeenCalled();
  });

  it("is the plain fetch it always was when browsing is off", async () => {
    const result = await fetchWith(`${base}/walled`, null);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("HTTP 403");
  });

  it("reports both failures when the browser fails too", async () => {
    const renderer = vi.fn<PageRenderer>().mockRejectedValue(new Error("Chromium could not start: no sandbox"));
    const result = await fetchWith(`${base}/walled`, renderer);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("HTTP 403");
    expect(result.output).toContain("The browser fallback failed too: Chromium could not start: no sandbox");
  });

  it("treats an error status in the browser as a failure", async () => {
    const renderer = vi.fn<PageRenderer>().mockResolvedValue(page({ status: 403 }));
    const result = await fetchWith(`${base}/walled`, renderer);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("in the browser too");
  });

  it("takes a screenshot only through the browser, and refuses one when browsing is off", async () => {
    const bytes = Buffer.from("\x89PNG....");
    const renderer = vi.fn<PageRenderer>().mockResolvedValue(page({ image: { bytes, mime: "image/png" } }));
    const shot = await fetchWith(`${base}/plain`, renderer, { screenshot: true });
    expect(renderer).toHaveBeenCalledWith(new URL(`${base}/plain`), { screenshot: true, maxTextChars: 100 * 1024 });
    expect(shot.image?.bytes).toBe(bytes);
    expect(shot.output).toContain("A screenshot of the page is attached.");
    const refused = await fetchWith(`${base}/plain`, null, { screenshot: true });
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("Screenshots need web browsing");
  });

  it("caps the rendered text like the plain path", async () => {
    const renderer = vi.fn<PageRenderer>().mockResolvedValue(page({ text: "x".repeat(200 * 1024) }));
    const result = await fetchWith(`${base}/walled`, renderer);
    expect(result.output).toContain("[truncated at 102400 characters of rendered text]");
    expect(result.output.length).toBeLessThan(110 * 1024);
  });

  it("never asks the browser about an address the guard refuses", async () => {
    delete process.env.LOXAIC_E2E_FETCH_ALLOW;
    const renderer = vi.fn<PageRenderer>();
    const result = await fetchWith(`${base}/walled`, renderer);
    expect(result.output).toContain("private or loopback");
    expect(renderer).not.toHaveBeenCalled();
  });

  it("refuses a scheme other than http(s) before anything runs", async () => {
    const renderer = vi.fn<PageRenderer>();
    const result = await fetchWith("file:///etc/passwd", renderer, { screenshot: true });
    expect(result.output).toContain("only http and https");
    expect(renderer).not.toHaveBeenCalled();
  });
});

describe("the web_fetch the model is offered", () => {
  const webFetch = (browsing: boolean | undefined) => resolveBuiltinTools("manual", { browsing }).find((t) => t.name === "web_fetch");

  it("is the plain tool, schema untouched, while browsing is off", () => {
    for (const off of [undefined, false]) {
      const tool = webFetch(off);
      expect(tool?.description).toBe("Fetch a public http(s) URL and return its text content.");
      expect(Object.keys((tool?.parameters as { properties: object }).properties)).toEqual(["url"]);
    }
  });

  it("offers a screenshot and says it falls back to a browser once browsing is on", () => {
    const tool = webFetch(true);
    expect(tool?.description).toContain("this conversation's own browser");
    expect(Object.keys((tool?.parameters as { properties: object }).properties)).toEqual(["url", "screenshot"]);
  });
});
