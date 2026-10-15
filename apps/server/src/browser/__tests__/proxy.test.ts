import { describe, expect, it } from "vitest";
import {
  decideTarget,
  normalizeSource,
  parseAbsoluteTarget,
  parseAuthority,
  rewriteLoopback,
  sanitizeHeader,
  sourceMatchesSubnet,
} from "../proxy.ts";

/**
 * The SSRF decisions browsing makes (#281), tested as pure functions because
 * they are the whole boundary: a page reaches nothing that these lines allow
 * and nothing else. Each blocked class here is a real target — the cloud
 * metadata address, the reverse-proxy host, the Tailscale range — not an
 * arbitrary sample.
 */

const BLOCKED = [
  "127.0.0.1",
  "127.1.2.3",
  "0.0.0.0",
  "10.1.2.3",
  "172.16.5.6",
  "192.168.0.7",
  "169.254.169.254",
  "169.254.1.1",
  "100.64.0.1",
  "100.127.255.255",
  "198.18.0.1",
  "224.0.0.1",
  "::1",
  "fc00::1",
  "fe80::1",
];

describe("decideTarget", () => {
  it.each(BLOCKED)("refuses a literal private or reserved address: %s", (host) => {
    expect(() => decideTarget(host, 80, {})).toThrowError(/not reachable/);
  });

  it.each(["::ffff:127.0.0.1", "::ffff:169.254.169.254"])(
    "refuses an IPv4-mapped IPv6 literal: %s",
    (host) => {
      expect(() => decideTarget(host, 80, {})).toThrowError(/not reachable/);
    },
  );

  it.each(["93.184.216.34", "140.82.112.3", "8.8.8.8"])("allows a public literal: %s", (host) => {
    expect(decideTarget(host, 443, {})).toEqual({ host, port: 443 });
  });

  it("passes a hostname through unresolved, so the guard runs after DNS", () => {
    // A name is not the decision — the resolution is. `dial` re-checks it, and
    // a test that let a name skip this function would miss the case where a
    // name answers 127.0.0.1.
    expect(decideTarget("example.com", 80, {})).toEqual({ host: "example.com", port: 80 });
  });
});

describe("rewriteLoopback", () => {
  const policy = { loopbackTarget: "172.30.0.2" };

  it.each([
    "localhost",
    "LOCALHOST",
    "app.localhost",
    "127.0.0.1",
    "127.9.9.9",
    "::1",
  ])("maps %s to the session's own workspace sandbox", (host) => {
    // The lowercase case matters: Chromium lowercases the hostname before it
    // reaches us, but a test only proves the shape we actually receive.
    expect(rewriteLoopback(host.toLowerCase(), policy)).toEqual({ dialHost: "172.30.0.2", rewritten: true });
  });

  it("leaves every other host alone", () => {
    expect(rewriteLoopback("example.com", policy)).toEqual({ dialHost: "example.com", rewritten: false });
    expect(rewriteLoopback("10.0.0.5", policy)).toEqual({ dialHost: "10.0.0.5", rewritten: false });
  });

  it("does nothing at all without a policy target (chat surface)", () => {
    expect(() => decideTarget("localhost", 3000, {})).toThrowError(/not reachable/);
    expect(rewriteLoopback("localhost", {})).toEqual({ dialHost: "localhost", rewritten: false });
  });

  it("allows the rewritten sandbox address, which is the one private target ever dialed", () => {
    expect(decideTarget("localhost", 3000, policy)).toEqual({ host: "172.30.0.2", port: 3000 });
  });

  it("still refuses a private literal that is not loopback, policy or not", () => {
    expect(() => decideTarget("169.254.169.254", 80, policy)).toThrowError(/not reachable/);
    expect(() => decideTarget("192.168.1.1", 80, policy)).toThrowError(/not reachable/);
    // And a *different* private address is not laundered by being reachable.
    expect(() => decideTarget("172.31.0.9", 80, policy)).toThrowError(/not reachable/);
  });
});

describe("parseAuthority", () => {
  it("reads host, port and IPv6 literals out of a CONNECT target", () => {
    expect(parseAuthority("example.com:8443", 443)).toEqual({ host: "example.com", port: 8443 });
    expect(parseAuthority("example.com", 443)).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[::1]:9222", 443)).toEqual({ host: "::1", port: 9222 });
    expect(parseAuthority("[2606:2800:220:1::]", 443)).toEqual({ host: "2606:2800:220:1::", port: 443 });
  });

  it.each(["", "   ", "[::1", "host:notaport:2", "host:0", "host:70000"])(
    "refuses a malformed authority: %j",
    (raw) => {
      expect(() => parseAuthority(raw, 443)).toThrow();
    },
  );
});

describe("parseAbsoluteTarget", () => {
  it("reads an absolute proxied request", () => {
    expect(parseAbsoluteTarget("http://example.com/a/b?c=1")).toEqual({
      host: "example.com",
      port: 80,
      path: "/a/b?c=1",
      secure: false,
    });
    expect(parseAbsoluteTarget("https://example.com:8443")).toEqual({
      host: "example.com",
      port: 8443,
      path: "/",
      secure: true,
    });
  });

  it("returns null for an origin-form target rather than guessing a host", () => {
    expect(parseAbsoluteTarget("/just/a/path")).toBeNull();
  });

  it("refuses a scheme that is not http(s)", () => {
    // Not reachable through CONNECT either, but a plain request must not be
    // able to smuggle one past.
    expect(() => parseAbsoluteTarget("ftp://example.com/x")).toThrow();
  });
});

describe("sourceMatchesSubnet", () => {
  it("matches only a source inside the session's own network", () => {
    expect(sourceMatchesSubnet("172.30.0.7", "172.30.0.0/24")).toBe(true);
    expect(sourceMatchesSubnet("172.31.0.7", "172.30.0.0/24")).toBe(false);
    expect(sourceMatchesSubnet("172.30.1.7", "172.30.0.0/24")).toBe(false);
  });

  it("handles a v4-mapped source address as the socket reports it", () => {
    expect(sourceMatchesSubnet(normalizeSource("::ffff:172.30.0.7"), "172.30.0.0/24")).toBe(true);
  });

  it("refuses to place anything it cannot read, which is the fail-closed side", () => {
    expect(sourceMatchesSubnet("::1", "172.30.0.0/24")).toBe(false);
    expect(sourceMatchesSubnet("", "172.30.0.0/24")).toBe(false);
    expect(sourceMatchesSubnet("172.30.0.7", null)).toBe(false);
    expect(sourceMatchesSubnet("172.30.0.7", "not-a-cidr")).toBe(false);
    expect(sourceMatchesSubnet("172.30.0.7", "172.30.0.0/notanumber")).toBe(false);
  });
});

describe("sanitizeHeader", () => {
  it("cannot let a target inject a second response line", () => {
    expect(sanitizeHeader("a\r\nX-Injected: 1\r\n\r\nGET / HTTP/1.1")).toBe("aX-Injected: 1GET / HTTP/1.1");
    expect(sanitizeHeader("x".repeat(500)).length).toBe(200);
  });
});
