import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { guardedFetch } from "../../agent/address-guard.ts";
import { dropEntry, listServerTools, type McpServerRow } from "../client-manager.ts";
import { mcpFetch } from "../http-fetch.ts";
import { startMockMcpHttp, type MockMcpHttp } from "./mock-mcp-http.ts";

/**
 * Every fixture binds to 127.0.0.1. A fixture counts as public when its
 * `host:port` is on guardedFetch's e2e allowlist (`LOXAIC_E2E_FETCH_ALLOW`,
 * honoured only under `MOCK_INFERENCE`); anything else on loopback is private,
 * as 169.254.169.254 would be in production.
 *
 * `localhost` is a rebinding name: a check-time lookup (`dns.promises`, which
 * a separate `assertPublicUrl` uses) answers a public address, and the
 * connect-time lookup (`dns.lookup`, which guardedFetch dials through) gives
 * the real loopback one. `unresolvable.test` fails at connect time.
 */
const PUBLIC_ANSWER = "93.184.216.34";
const UNRESOLVABLE = "unresolvable.test";

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const promises = {
    ...actual.promises,
    lookup: (host: string, opts: object) =>
      host === "localhost" ? Promise.resolve([{ address: PUBLIC_ANSWER, family: 4 }]) : actual.promises.lookup(host, opts),
  };
  const lookup = (host: string, opts: object, cb: (err: Error | null, ...rest: unknown[]) => void) => {
    if (host === UNRESOLVABLE) {
      cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
      return;
    }
    actual.lookup(host, opts, cb);
  };
  return { ...actual, default: { ...actual, promises, lookup }, promises, lookup };
});

process.env.MCP_ENCRYPTION_KEY ??= "http-fetch-test-key";

let privateMcp: MockMcpHttp;
let publicMcp: MockMcpHttp;
let redirector: Server;
let slow: Server;
const allowed: string[] = [];
const userId = `test-mcp-fetch-${uuid()}`;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return String((server.address() as AddressInfo).port);
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
}

function row(url: string): McpServerRow {
  return {
    id: uuid(),
    ownerId: userId,
    name: "Fetch test",
    transport: "http",
    url,
    allowPrivateNetwork: false,
    headers: {},
    secrets: null,
    updatedAt: new Date(),
  } as unknown as McpServerRow;
}

let redirectorUrl: string;
let slowUrl: string;

beforeAll(async () => {
  privateMcp = await startMockMcpHttp();
  publicMcp = await startMockMcpHttp();
  allowed.push(new URL(publicMcp.url).host);
  // 307 keeps the method and body, so a followed redirect would deliver the
  // whole MCP request to the private server.
  redirector = createServer((_req, res) => {
    res.writeHead(307, { location: privateMcp.url }).end();
  });
  const redirectorPort = await listen(redirector);
  redirectorUrl = `http://localhost:${redirectorPort}/mcp`;
  allowed.push(`localhost:${redirectorPort}`);
  // Withholds its headers past the guard's default 15 s deadline.
  slow = createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200).end("late"); }, 16_000);
  });
  const slowPort = await listen(slow);
  slowUrl = `http://127.0.0.1:${slowPort}/`;
  allowed.push(`127.0.0.1:${slowPort}`);
});

afterAll(async () => {
  await privateMcp.close();
  await publicMcp.close();
  await close(redirector);
  await close(slow);
});

beforeEach(() => {
  vi.stubEnv("MOCK_INFERENCE", "true");
  vi.stubEnv("LOXAIC_E2E_FETCH_ALLOW", allowed.join(","));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mcpFetch", () => {
  it("hands a redirect back instead of following it", async () => {
    const before = privateMcp.requests();
    const res = await mcpFetch(false)(redirectorUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(privateMcp.requests()).toBe(before);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(privateMcp.url);
  });

  it("outlives the guard's default 15 s deadline, which web_fetch keeps", async () => {
    const [plain, mcp] = await Promise.allSettled([guardedFetch(new URL(slowUrl)), mcpFetch(false)(slowUrl)]);
    expect(plain.status).toBe("rejected");
    expect(String(((plain as PromiseRejectedResult).reason as { cause?: unknown }).cause)).toMatch(/Headers Timeout/);
    expect(mcp.status).toBe("fulfilled");
    expect(await (mcp as PromiseFulfilledResult<Response>).value.text()).toBe("late");
  }, 30_000);

  it("says why a request failed, not just \"fetch failed\"", async () => {
    await expect(mcpFetch(false)(`http://${UNRESOLVABLE}/mcp`)).rejects.toThrow(`getaddrinfo ENOTFOUND ${UNRESOLVABLE}`);
  });

  it("refuses a Request rather than drop its method, headers and body", async () => {
    await expect(mcpFetch(false)(new Request(publicMcp.url, { method: "POST", body: "{}" }))).rejects.toThrow("MCP requests take a URL, not a Request");
  });

  it("is the plain fetch once the user allowed a private address", () => {
    expect(mcpFetch(true)).toBe(fetch);
  });
});

describe("connecting to an HTTP MCP server", () => {
  it("refuses a name that resolves to a private address when it connects", async () => {
    const before = privateMcp.requests();
    const r = row(`http://localhost:${new URL(privateMcp.url).port}/mcp`);
    await expect(listServerTools(userId, r)).rejects.toThrow(/Could not connect to MCP server "Fetch test": refusing to fetch a private or loopback address/);
    expect(privateMcp.requests()).toBe(before);
    await dropEntry(userId, r.id);
  });

  it("connects to a public server through the guard", async () => {
    const r = row(publicMcp.url);
    const tools = await listServerTools(userId, r);
    expect(tools.map((t) => t.name)).toContain("ping");
    await dropEntry(userId, r.id);
  });
});
