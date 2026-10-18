import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeTool, isBlockedAddress } from "../executor.ts";

/**
 * The address check behind web_fetch and the sandbox egress proxy.
 *
 * IPv6 is matched by value, not spelling: getaddrinfo (macOS, at least) and
 * the WHATWG URL parser both turn `[::ffff:127.0.0.1]` into `::ffff:7f00:1`,
 * and the old string patterns only knew the dotted form, so web_fetch
 * reached the server's own loopback.
 */
describe("isBlockedAddress", () => {
  const blockedV6 = [
    "::1",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "::0:1",
    "::1%1",
    "[::1]",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::FFFF:7F00:0001",
    "::ffff:a9fe:a9fe", // 169.254.169.254, the cloud metadata service
    "::ffff:10.0.0.1",
    "::ffff:0:0", // 0.0.0.0
    "::ffff:0:7f00:1", // IPv4-translated 127.0.0.1 (RFC 2765)
    "::ffff:0:a9fe:a9fe",
    "::ffff:0:808:808", // translated forms are refused outright, public or not
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "::127.0.0.1",
    "64:ff9b::7f00:1", // NAT64 to 127.0.0.1
    "64:ff9b::192.168.1.1",
    "64:ff9b:1::808:808", // local-use NAT64
    "2002:7f00:1::", // 6to4 around 127.0.0.1
    "2002:c0a8:101::1", // 6to4 around 192.168.1.1
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "2001:db8::1",
    "3fff::1", // documentation (RFC 9637)
    "2001:2::1", // benchmarking
    "5f00::1", // SRv6
    "100::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "not-an-address",
    "1:2:3:4:5:6:7:8:9",
  ];
  it.each(blockedV6)("blocks %s", (ip) => {
    expect(isBlockedAddress(ip, 6)).toBe(true);
  });

  const publicV6 = [
    "2606:4700:4700::1111",
    "2a00:1450:4001:82a::200e",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808", // NAT64 to 8.8.8.8
    "2002:808:808::1", // 6to4 around 8.8.8.8
  ];
  it.each(publicV6)("allows %s", (ip) => {
    expect(isBlockedAddress(ip, 6)).toBe(false);
  });

  it("keeps the IPv4 rules", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isBlockedAddress(ip, 4)).toBe(true);
    }
    expect(isBlockedAddress("8.8.8.8", 4)).toBe(false);
  });
});

describe("web_fetch refuses loopback in every IPv6 spelling", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.end("the server's own loopback answered");
    });
    // Rejects rather than hangs on a host with IPv6 switched off
    // (EAFNOSUPPORT), so the failure names the cause.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  });

  // The URL parser folds both [0:0:0:0:0:0:0:1] and [::1] to "::1", which the
  // old string check already refused: those two are kept as coverage, not as
  // proof of this fix. The ::ffff spellings are the regression cases.
  it.each(["[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:0:0:1]", "[::1]"])("%s", async (host) => {
    const result = await executeTool(null, "web_fetch", { url: `http://${host}:${String(port)}/` });
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("loopback answered");
  });
});
