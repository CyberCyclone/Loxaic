import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedExecutable } from "../install.ts";

/**
 * web_fetch's browser fallback against a real Chromium (#281).
 *
 * Runs wherever a managed build is installed: `BROWSER_DIR`, or the e2e
 * harness's cache (`~/.cache/loxaic-e2e/browsers`), which CI's test job fills.
 * Skipped otherwise, like the container tests without an engine.
 *
 * The fixture site is on loopback, which the address guard refuses; the one
 * port it serves on is let through with LOXAIC_E2E_FETCH_ALLOW (honoured only
 * with MOCK_INFERENCE), so a second loopback server stands in for "a private
 * address" and must stay unreachable.
 */
const dir = process.env.BROWSER_DIR ?? path.join(homedir(), ".cache", "loxaic-e2e", "browsers");
const executable = managedExecutable(dir);

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string; hostPort: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${String(port)}`, hostPort: `127.0.0.1:${String(port)}` });
    });
  });
}

describe.skipIf(!executable)("the browser fallback, in a real Chromium", () => {
  let site: Awaited<ReturnType<typeof listen>>;
  let privateSite: Awaited<ReturnType<typeof listen>>;
  let privateHits = 0;
  let upgrades = 0;
  let render: typeof import("../render.ts").renderPage;
  let manager: typeof import("../manager.ts");
  let sinkhole: typeof import("../sinkhole.ts");

  beforeAll(async () => {
    privateSite = await listen((_req, res) => {
      privateHits++;
      res.end("private");
    });
    site = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "text/html");
      switch (url.pathname) {
        case "/js":
          res.end(`<div id=a></div><script>document.getElementById('a').textContent='drawn by script'</script>`);
          return;
        case "/set":
          res.setHeader("set-cookie", ["one=1; Path=/", "two=2; Path=/"]);
          res.end("<p>set</p>");
          return;
        case "/echo":
          res.end(`<p>cookie=${req.headers.cookie ?? "none"}</p>`);
          return;
        case "/sub-private":
          res.end(`<p>top</p><img src="${privateSite.base}/pixel.png">`);
          return;
        case "/hop":
          res.writeHead(302, { location: "/dir/doc", "set-cookie": "hopped=yes; Path=/" });
          res.end();
          return;
        case "/dir/doc":
          res.end(`<html><head><title>doc</title></head><body><p id=t>before</p><script src="app.js"></script></body></html>`);
          return;
        case "/dir/app.js":
          res.setHeader("content-type", "text/javascript");
          res.end(`document.getElementById('t').textContent = 'relative script ran';`);
          return;
        case "/to-private":
          res.writeHead(302, { location: `${privateSite.base}/` });
          res.end();
          return;
        case "/ws":
          res.end(`<p id=s>pending</p><script>
            const w = new WebSocket('ws://' + location.host + '/socket');
            w.onopen = () => { document.getElementById('s').textContent = 'ws open'; };
            w.onclose = () => { if (document.getElementById('s').textContent !== 'ws open') document.getElementById('s').textContent = 'ws closed'; };
          </script>`);
          return;
        case "/hang":
          res.end(`<p>loaded</p><script>setTimeout(() => { for (;;) {} }, 0)</script>`);
          return;
        case "/slow":
          setTimeout(() => { res.end("<p>late</p>"); }, 20_000);
          return;
        default:
          res.end("<p>ok</p>");
      }
    });
    site.server.on("upgrade", (_req, socket) => {
      upgrades++;
      socket.destroy();
    });
    process.env.MOCK_INFERENCE = "true";
    process.env.LOXAIC_E2E_FETCH_ALLOW = site.hostPort;
    process.env.BROWSER_EXECUTABLE = executable ?? "";
    process.env.BROWSER_ENABLED = "true";
    process.env.BROWSER_ACTION_TIMEOUT_MS = "8000";
    ({ renderPage: render } = await import("../render.ts"));
    manager = await import("../manager.ts");
    sinkhole = await import("../sinkhole.ts");
  }, 60_000);

  afterAll(async () => {
    await manager.__resetBrowsersForTest();
    await sinkhole.closeSinkhole();
    site.server.close();
    privateSite.server.close();
    for (const k of ["LOXAIC_E2E_FETCH_ALLOW", "BROWSER_EXECUTABLE", "BROWSER_ENABLED", "BROWSER_ACTION_TIMEOUT_MS"]) Reflect.deleteProperty(process.env, k);
  });

  const opts = { screenshot: false, maxTextChars: 10_000 };

  it("renders a page whose text only exists once its script has run", async () => {
    const page = await render("conv-js", new URL(`${site.base}/js`), opts);
    expect(page.status).toBe(200);
    expect(page.text).toContain("drawn by script");
  }, 60_000);

  it("keeps cookies within one conversation and never lets another see them", async () => {
    await render("conv-a", new URL(`${site.base}/set`), opts);
    const same = await render("conv-a", new URL(`${site.base}/echo`), opts);
    expect(same.text).toContain("one=1");
    expect(same.text).toContain("two=2");
    const other = await render("conv-b", new URL(`${site.base}/echo`), opts);
    expect(other.text).toContain("cookie=none");
  }, 60_000);

  it("never reaches a private address: not as the page, a subresource, or a redirect", async () => {
    const before = privateHits;
    await expect(render("conv-p", new URL(`${privateSite.base}/`), opts)).rejects.toThrow(/private or loopback/);
    const sub = await render("conv-p", new URL(`${site.base}/sub-private`), opts);
    expect(sub.text).toContain("top");
    await expect(render("conv-p", new URL(`${site.base}/to-private`), opts)).rejects.toThrow(/private or loopback/);
    expect(privateHits).toBe(before);
  }, 60_000);

  it("follows a redirect itself, keeps its cookie, and resolves the page's relative links from where it came from", async () => {
    const page = await render("conv-r", new URL(`${site.base}/hop`), opts);
    expect(page.text).toContain("relative script ran");
    expect(page.finalUrl).toBe(`${site.base}/dir/doc`);
    const echo = await render("conv-r", new URL(`${site.base}/echo`), opts);
    expect(echo.text).toContain("hopped=yes");
  }, 60_000);

  it("never lets a page's WebSocket reach anything", async () => {
    // Closed by the interception, and the sinkhole behind it would catch one
    // that got past: either way nothing is ever upgraded.
    const page = await render("conv-ws", new URL(`${site.base}/ws`), opts);
    expect(page.text).toContain("ws closed");
    expect(upgrades).toBe(0);
  }, 60_000);

  it("refuses schemes other than http(s) before the browser sees them", async () => {
    await expect(render("conv-s", new URL("file:///etc/passwd"), opts)).rejects.toThrow(/Only http and https/);
  });

  it("returns a real PNG when asked for a screenshot", async () => {
    const page = await render("conv-shot", new URL(`${site.base}/js`), { ...opts, screenshot: true });
    expect(page.image?.mime).toBe("image/png");
    expect(page.image?.bytes.subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);

  it("gives up on a page whose script never yields, and closes that conversation's browser", async () => {
    await render("conv-hang", new URL(`${site.base}/js`), opts);
    const before = manager.__activeBrowserCount();
    await expect(render("conv-hang", new URL(`${site.base}/hang`), opts)).rejects.toThrow(/did not finish loading/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(manager.__activeBrowserCount()).toBe(before - 1);
  }, 60_000);

  it("stops when the run is stopped", async () => {
    const controller = new AbortController();
    const pending = render("conv-stop", new URL(`${site.base}/slow`), { ...opts, signal: controller.signal });
    setTimeout(() => { controller.abort(); }, 1500);
    await expect(pending).rejects.toThrow(/Stopped/);
  }, 60_000);

  it("sends anything that escapes interception to the sinkhole, not the network", async () => {
    // Chromium launched with the manager's own flags but no interception: the
    // fixture site is reachable from this host, so only the flags stop it.
    const { chromiumArgs } = manager;
    const { chromium } = (await import("playwright-core")) as unknown as {
      chromium: { launch: (o: unknown) => Promise<{ newPage: () => Promise<{ goto: (u: string) => Promise<unknown> }>; close: () => Promise<void> }> };
    };
    const browser = await chromium.launch({ executablePath: executable, args: chromiumArgs(await sinkhole.sinkholePort()) });
    try {
      const page = await browser.newPage();
      const hits = sinkhole.sinkholeHits();
      await expect(page.goto(`${site.base}/`)).rejects.toThrow();
      expect(sinkhole.sinkholeHits()).toBeGreaterThan(hits);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
