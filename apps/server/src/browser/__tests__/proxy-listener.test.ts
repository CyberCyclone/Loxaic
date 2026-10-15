import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { BrowserProxy, handleProxiedClient } from "../proxy.ts";
import type { SessionEgressPolicy } from "../proxy.ts";

/**
 * The proxy as a running thing, against a real origin server on loopback
 * (#281). No containers: what is under test is a live listener's decisions and
 * its framing — the CONNECT handshake, the absolute-URI rewrite, the header
 * ceiling — none of which a pure-function test can see.
 *
 * The origin is `127.0.0.1`, which the guard blocks. So "200" here means a
 * loopback target was allowed *by policy*, and "403" means the guard held.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function closeServer(server: net.Server | http.Server): Promise<void> {
  // The proxy's upstream connection is keep-alive and outlives the proxied
  // request, so a plain close() would sit waiting on a socket nobody is going to
  // close — and that wait surfaces as the *next* test timing out.
  // `closeAllConnections` is on both http.Server and net.Server at runtime;
  // typed loosely because the two declarations do not line up in every @types.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** An origin server on loopback answering with a marker body. */
async function startOrigin(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url} host=${req.headers.host ?? "-"}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-body");
  });
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => closeServer(server));
  return { port, requests };
}

/** A listener with one policy attached — which *is* the design: a session's
 * policy belongs to its listener, not to the caller of a request. */
async function startListener(policy: SessionEgressPolicy): Promise<number> {
  const listener = net.createServer((client) => handleProxiedClient(client, policy, () => undefined));
  await new Promise<void>((resolve) => listener.listen({ host: "127.0.0.1", port: 0 }, resolve));
  cleanups.push(() => closeServer(listener));
  return (listener.address() as AddressInfo).port;
}

/** One proxied plain-HTTP request, returning the status code it came back with. */
function proxiedGet(host: string, port: number, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0));
    });
    socket.on("error", reject);
    socket.write(`GET ${url} HTTP/1.1\r\nHost: irrelevant.invalid\r\nConnection: close\r\n\r\n`);
  });
}

/** A CONNECT through a listener, returning its response line. */
function connectThrough(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(head.slice(0, head.indexOf("\r\n")));
    });
    socket.on("error", reject);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe("handleProxiedClient", () => {
  it("refuses a loopback origin with no loopback policy — the guard, on a live socket", async () => {
    const origin = await startOrigin();
    const port = await startListener({});
    expect(await proxiedGet("127.0.0.1", port, `http://127.0.0.1:${String(origin.port)}/x`)).toBe(403);
    expect(origin.requests).toEqual([]);
  });

  it("refuses the name localhost before trusting how this machine resolves it", async () => {
    const origin = await startOrigin();
    const port = await startListener({});
    expect(await proxiedGet("127.0.0.1", port, `http://localhost:${String(origin.port)}/x`)).toBe(403);
    expect(origin.requests).toEqual([]);
  });

  it("forwards when loopback is the session's own sandbox, keeping the original Host", async () => {
    const origin = await startOrigin();
    const port = await startListener({ loopbackTarget: "127.0.0.1" });
    expect(await proxiedGet("127.0.0.1", port, `http://localhost:${String(origin.port)}/x`)).toBe(200);
    // The Host header the origin sees is the name the page asked for, not the
    // address we dialed: virtual hosts and cookies depend on it.
    expect(origin.requests).toEqual([`GET /x host=localhost:${String(origin.port)}`]);
  });

  it("does not accept a target the policy did not name, even with one set", async () => {
    const origin = await startOrigin();
    const port = await startListener({ loopbackTarget: "127.0.0.1" });
    expect(await proxiedGet("127.0.0.1", port, "http://192.168.1.1/x")).toBe(403);
    expect(await proxiedGet("127.0.0.1", port, "http://169.254.169.254/latest/meta-data")).toBe(403);
    expect(origin.requests).toEqual([]);
  });

  it("answers an origin-form request with 400 rather than guessing a host", async () => {
    const port = await startListener({});
    expect(await proxiedGet("127.0.0.1", port, "/nope")).toBe(400);
  });

  it("answers a non-http scheme with 400", async () => {
    const port = await startListener({});
    expect(await proxiedGet("127.0.0.1", port, "ftp://example.com/x")).toBe(400);
  });

  it("refuses a CONNECT to loopback, to the metadata address, and over IPv6", async () => {
    const port = await startListener({});
    expect(await connectThrough(port, "127.0.0.1:4000")).toContain("403");
    expect(await connectThrough(port, "169.254.169.254:80")).toContain("403");
    expect(await connectThrough(port, "[::1]:6379")).toContain("403");
  });

  it("drops a connection whose header block never ends instead of buffering it", async () => {
    const port = await startListener({});
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let head = "";
      socket.on("data", (chunk) => {
        head += chunk.toString("latin1");
        socket.destroy();
        resolve(head);
      });
      socket.on("close", () => resolve("closed-without-response"));
      socket.on("error", (err) => resolve(`error:${(err as Error).message}`));
      // Never a blank line: without the ceiling this buffer would grow forever.
      socket.write("GET /");
      const pump = setInterval(() => socket.write("x".repeat(8192)), 1);
      cleanups.push(async () => {
        clearInterval(pump);
      });
    });
    expect(outcome).toContain("431");
  });
});

describe("BrowserProxy", () => {
  it("gives a session a listener bound to its own gateway address", async () => {
    const proxy = new BrowserProxy();
    cleanups.push(async () => {
      proxy.detachAll();
    });
    // 127.0.0.1 is bindable on this host, so this is the preferred per-session
    // shape; the shared fallback is decided by the subnet matching tests.
    const handle = await proxy.attach("127.0.0.1", "172.30.0.0/24", { loopbackTarget: "127.0.0.1" });
    expect(handle.mode).toBe("per-session");
    expect(handle.proxyUrl).toBe(`http://127.0.0.1:${String(handle.port)}`);

    const origin = await startOrigin();
    expect(await proxiedGet("127.0.0.1", handle.port, `http://localhost:${String(origin.port)}/`)).toBe(200);

    proxy.detach("127.0.0.1");
    expect(proxy.live()).toEqual([]);
    await expect(proxiedGet("127.0.0.1", handle.port, "http://example.com/")).rejects.toThrow();
  });

  it("changes a live session's policy without rebinding the socket", async () => {
    const proxy = new BrowserProxy();
    cleanups.push(async () => {
      proxy.detachAll();
    });
    const handle = await proxy.attach("127.0.0.1", null, {});
    const origin = await startOrigin();
    const url = `http://localhost:${String(origin.port)}/`;
    expect(await proxiedGet("127.0.0.1", handle.port, url)).toBe(403);

    proxy.setPolicy("127.0.0.1", { loopbackTarget: "127.0.0.1" });
    expect(await proxiedGet("127.0.0.1", handle.port, url)).toBe(200);
    // Same port: the agent attaching its sandbox mid-session must not move the
    // address the browser was launched with.
    expect(proxy.live()).toEqual([{ gateway: "127.0.0.1", mode: "per-session" }]);
  });
});
