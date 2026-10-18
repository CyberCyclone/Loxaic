import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * DNS rebinding against web_fetch: a name that answers public when it is
 * checked and private when it is dialled.
 *
 * Simulated by giving the guard a resolver that says `localhost` is
 * 203.0.113.5 (public, as far as the address rules go) while the operating
 * system still resolves it to loopback. A guard that checks one answer and
 * then lets the transport resolve the name again connects to loopback; one
 * that dials exactly the address it checked never can.
 */
const answers: Record<string, string> = { localhost: "203.0.113.5", "rebind.test": "127.0.0.1" };
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const pick = (host: string) => answers[host];
  const lookup = ((host: string, opts: unknown, cb: (e: Error | null, a: unknown, f?: number) => void) => {
    const address = pick(host);
    if (!address) {
      actual.lookup(host, opts as never, cb as never);
      return;
    }
    const all = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all;
    if (all) cb(null, [{ address, family: 4 }]);
    else cb(null, address, 4);
  }) as typeof actual.lookup;
  const promisesLookup = (async (host: string, opts?: unknown) => {
    const address = pick(host);
    if (!address) return actual.promises.lookup(host, opts as never);
    return (opts as { all?: boolean } | undefined)?.all ? [{ address, family: 4 }] : { address, family: 4 };
  }) as typeof actual.promises.lookup;
  return { ...actual, default: { ...actual, lookup, promises: { ...actual.promises, lookup: promisesLookup } }, lookup, promises: { ...actual.promises, lookup: promisesLookup } };
});

const { executeTool } = await import("../executor.ts");

describe("web_fetch dials the address it checked", () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("the server's own loopback answered");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  });

  it("never reaches loopback through a name that checked out as public", async () => {
    const result = await executeTool(null, "web_fetch", { url: `http://localhost:${String(port)}/` });
    expect(result.output).not.toContain("loopback answered");
    expect(hits).toBe(0);
  }, 30_000);

  it("refuses a name whose answer is private, at the connection", async () => {
    const result = await executeTool(null, "web_fetch", { url: `http://rebind.test:${String(port)}/` });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("private or loopback");
    expect(hits).toBe(0);
  });
});
