import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { v4 as uuid } from "uuid";
import { dropEntry, listServerTools, type McpServerRow } from "../client-manager.ts";
import { guardedFetch } from "../../agent/address-guard.ts";
import { mcpFetch } from "../http-fetch.ts";
import { startMockMcpHttp, type MockMcpHttp } from "./mock-mcp-http.ts";

/**
 * An HTTP MCP server that redirects to a private address must never get the
 * request through. Every fixture binds to 127.0.0.1, so "public" here means
 * one of `publicPorts`, in both of the checks a request can meet:
 * - `assertPublicUrl` (the up-front check in `connect()`) is mocked to pass
 *   only those ports;
 * - `guardedFetch` lets them through its existing e2e allowlist
 *   (`LOXAIC_E2E_FETCH_ALLOW`, honoured only under `MOCK_INFERENCE`).
 * Any other address is private, as 169.254.169.254 would be in production.
 */
const { publicPorts } = vi.hoisted(() => ({ publicPorts: new Set<string>() }));

vi.mock("../../agent/address-guard.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/address-guard.ts")>();
  return {
    ...actual,
    guardedFetch: vi.fn(actual.guardedFetch),
    assertPublicUrl: (url: URL) => {
      if (!publicPorts.has(url.port)) {
        return Promise.reject(new Error(`refusing to fetch a private or loopback address (${url.host})`));
      }
      return Promise.resolve();
    },
  };
});

process.env.MCP_ENCRYPTION_KEY ??= "http-fetch-test-key";

let privateMcp: MockMcpHttp;
let publicMcp: MockMcpHttp;
let redirector: Server;
let redirectorUrl: string;
const userId = `test-mcp-fetch-${uuid()}`;

function portOf(url: string): string {
  return new URL(url).port;
}

function row(url: string): McpServerRow {
  return {
    id: uuid(),
    ownerId: userId,
    name: "Redirect test",
    transport: "http",
    url,
    allowPrivateNetwork: false,
    headers: {},
    secrets: null,
    updatedAt: new Date(),
  } as unknown as McpServerRow;
}

beforeAll(async () => {
  privateMcp = await startMockMcpHttp();
  publicMcp = await startMockMcpHttp();
  // 307 keeps the method and body, so a followed redirect would deliver the
  // whole MCP request to the private server.
  redirector = createServer((_req, res) => {
    res.writeHead(307, { location: privateMcp.url }).end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  redirectorUrl = `http://127.0.0.1:${String((redirector.address() as AddressInfo).port)}/mcp`;
  publicPorts.add(portOf(redirectorUrl));
  publicPorts.add(portOf(publicMcp.url));
});

afterAll(async () => {
  await privateMcp.close();
  await publicMcp.close();
  redirector.closeAllConnections();
  await new Promise<void>((resolve) => redirector.close(() => { resolve(); }));
});

beforeEach(() => {
  vi.stubEnv("MOCK_INFERENCE", "true");
  vi.stubEnv("LOXAIC_E2E_FETCH_ALLOW", [...publicPorts].map((p) => `127.0.0.1:${p}`).join(","));
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

  it("keeps Node's 300 s deadlines, not web_fetch's 15 s, for tool calls and event streams", async () => {
    vi.mocked(guardedFetch).mockClear();
    await mcpFetch(false)(publicMcp.url, { method: "GET", headers: { accept: "text/event-stream" } })
      .then((res) => res.body?.cancel());
    expect(vi.mocked(guardedFetch)).toHaveBeenCalledWith(expect.any(URL), expect.anything(), { longLived: true });
  });

  it("is the plain fetch once the user allowed a private address", () => {
    expect(mcpFetch(true)).toBe(fetch);
  });
});

describe("connecting to an HTTP MCP server", () => {
  it("fails when the server redirects to a private address, without reaching it", async () => {
    const before = privateMcp.requests();
    const r = row(redirectorUrl);
    await expect(listServerTools(userId, r)).rejects.toThrow(/Could not connect to MCP server "Redirect test"/);
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
