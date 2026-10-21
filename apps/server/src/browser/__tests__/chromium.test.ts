import dgram from "node:dgram";
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
 * Skipped otherwise, like the container tests without an engine. It goes
 * through the real launch order, so on an Ubuntu 23.10+ runner, where the
 * managed build cannot sandbox, these run in the system browser it falls
 * back to (the runner's Google Chrome): both builds get the same checks.
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
  let other: Awaited<ReturnType<typeof listen>>;
  let popupHits = 0;
  let upgrades = 0;
  let render: typeof import("../render.ts").renderPage;
  let manager: typeof import("../manager.ts");
  let sinkhole: typeof import("../sinkhole.ts");

  beforeAll(async () => {
    privateSite = await listen((_req, res) => {
      privateHits++;
      res.end("private");
    });
    other = await listen((req, res) => {
      // Served as `localhost`, a different host from the main fixture's
      // 127.0.0.1: cookies are per host, so only that makes it another site.
      const url = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "text/html");
      if (url.pathname === "/landing") {
        // Another origin: says which origin it runs as, and tries to plant a
        // cookie, which must never land on the origin that redirected here.
        res.setHeader("set-cookie", "planted=1; Path=/");
        res.end(`<p id=o>pending</p><script>document.getElementById('o').textContent = 'origin=' + location.origin</script>`);
        return;
      }
      if (url.pathname === "/pixel") {
        res.setHeader("set-cookie", "planted_by_image=1; Path=/");
        res.setHeader("content-type", "image/gif");
        res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
        return;
      }
      if (url.pathname === "/popup") popupHits++;
      res.end("<p>other</p>");
    });
    site = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "text/html");
      switch (url.pathname) {
        case "/img-to-other":
          res.writeHead(302, { location: `${other.base}/pixel` });
          res.end();
          return;
        case "/with-image":
          res.end(`<p>with image</p><img src="/img-to-other">`);
          return;
        case "/to-other":
          res.writeHead(302, { location: `${other.base}/landing` });
          res.end();
          return;
        case "/popups":
          res.end(`<p>opener</p><p id=w></p><script>
            document.getElementById('w').textContent = 'popup opened=' + (window.open('${other.base}/popup?a') !== null);
            const a = document.createElement('a'); a.href = '${other.base}/popup?b'; a.target = '_blank'; document.body.append(a); a.click();
          </script>`);
          return;
        case "/liar":
          // A page that tries to lift the text cut by redefining what the
          // reader uses, then fills itself with far more than the cap.
          res.end(`<script>
            String.prototype.slice = function () { return String(this); };
            Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return 'x'.repeat(5e6); } });
          </script><p>${"short ".repeat(10)}</p>`);
          return;
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
    other = { ...other, base: other.base.replace("127.0.0.1", "localhost"), hostPort: other.hostPort.replace("127.0.0.1", "localhost") };
    process.env.LOXAIC_E2E_FETCH_ALLOW = `${site.hostPort},${other.hostPort}`;
    // The real launch order: Loxaic's own build from this directory, then any
    // browser the system exempts if its sandbox cannot start.
    process.env.BROWSER_DIR = dir;
    delete process.env.BROWSER_EXECUTABLE;
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
    other.server.close();
    for (const k of ["LOXAIC_E2E_FETCH_ALLOW", "BROWSER_DIR", "BROWSER_ENABLED", "BROWSER_ACTION_TIMEOUT_MS"]) Reflect.deleteProperty(process.env, k);
  });

  const opts = { screenshot: "none" as const, maxTextChars: 10_000 };

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

  it("returns a real PNG when asked for a screenshot, and when the person is the only one who sees it", async () => {
    for (const screenshot of ["required", "best-effort"] as const) {
      const page = await render("conv-shot", new URL(`${site.base}/js`), { ...opts, screenshot });
      expect(page.image?.mime).toBe("image/png");
      expect(page.image?.bytes.subarray(1, 4).toString()).toBe("PNG");
    }
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
    // The browser the launch order actually chose for these tests.
    const executablePath = manager.browserStatus().using?.executable ?? executable;
    const browser = await chromium.launch({ executablePath, args: chromiumArgs(await sinkhole.sinkholePort()) });
    try {
      const page = await browser.newPage();
      const hits = sinkhole.sinkholeHits();
      await expect(page.goto(`${site.base}/`)).rejects.toThrow();
      expect(sinkhole.sinkholeHits()).toBeGreaterThan(hits);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("hands a navigation to another origin back to the browser: the page runs as that origin and plants no cookie on the first", async () => {
    const page = await render("conv-x", new URL(`${site.base}/to-other`), opts);
    expect(page.text).toContain(`origin=${other.base}`);
    expect(page.finalUrl).toBe(`${other.base}/landing`);
    const echo = await render("conv-x", new URL(`${site.base}/echo`), opts);
    expect(echo.text).not.toContain("planted");
  }, 60_000);

  it("keeps a subresource that ends on another origin working, without storing that origin's cookie", async () => {
    await render("conv-img", new URL(`${site.base}/with-image`), opts);
    const echo = await render("conv-img", new URL(`${site.base}/echo`), opts);
    expect(echo.text).not.toContain("planted_by_image");
  }, 60_000);

  it("gives a popup nothing: it never fetches, whether window.open or a target=_blank link", async () => {
    const page = await render("conv-pop", new URL(`${site.base}/popups`), opts);
    // The page really did open one: what stops it is Loxaic, not the browser.
    expect(page.text).toContain("popup opened=true");
    await new Promise((r) => setTimeout(r, 1500));
    expect(popupHits).toBe(0);
  }, 60_000);

  it("cuts the text where the page cannot interfere", async () => {
    const page = await render("conv-liar", new URL(`${site.base}/liar`), { screenshot: "none", maxTextChars: 1000 });
    expect(page.text.length).toBeLessThanOrEqual(1001);
    expect(page.text).toContain("short");
  }, 60_000);

  it("sends no WebRTC traffic and gathers no addresses, in the browser the tests run in, frames included", async () => {
    const udp = dgram.createSocket("udp4");
    let packets = 0;
    udp.on("message", () => { packets++; });
    await new Promise<void>((resolve) => { udp.bind(0, "127.0.0.1", resolve); });
    const stun = `stun:127.0.0.1:${String(udp.address().port)}`;
    const { chromium } = (await import("playwright-core")) as unknown as {
      chromium: {
        launch: (o: unknown) => Promise<{
          newContext: () => Promise<{
            addInitScript: (x: { content: string }) => Promise<void>;
            newPage: () => Promise<{ setContent: (h: string) => Promise<void>; evaluate: (e: string) => Promise<unknown> }>;
          }>;
          close: () => Promise<void>;
        }>;
      };
    };
    // The launch flags and the init script manager.ts gives every context,
    // in the browser these tests actually run in.
    const executablePath = manager.browserStatus().using?.executable ?? executable;
    const browser = await chromium.launch({ executablePath, args: manager.chromiumArgs(await sinkhole.sinkholePort()) });
    try {
      const context = await browser.newContext();
      await context.addInitScript({ content: manager.BLOCK_WEBRTC_SCRIPT });
      const page = await context.newPage();
      await page.setContent("<p>rtc</p><iframe></iframe>");
      const candidates = await page.evaluate(`(async () => {
        // Not even through a fresh frame's window.
        const fromFrame = document.querySelector("iframe").contentWindow.RTCPeerConnection;
        const Ctor = globalThis.RTCPeerConnection ?? fromFrame;
        if (typeof Ctor !== "function") return [];
        const pc = new Ctor({ iceServers: [{ urls: ${JSON.stringify(stun)} }] });
        pc.createDataChannel("x");
        const found = [];
        pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate.candidate); };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((r) => setTimeout(r, 3000));
        return found;
      })()`);
      expect(candidates).toEqual([]);
      expect(packets).toBe(0);
    } finally {
      await browser.close();
      udp.close();
    }
  }, 60_000);
});
