import { describe, it, expect } from "vitest";
import { describeFetchError, isLocalNetworkHost } from "../fetch-error.js";

/**
 * The host probe used to show `err.message`, and Node's fetch says
 * "fetch failed" for every network error. These are the shapes it actually
 * throws — TypeError with the reason on `cause`, TimeoutError for a deadline —
 * checked against real fetch calls before this module was written.
 */
const netError = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

describe("describeFetchError", () => {
  it("names macOS Local Network permission for an unreachable LAN host on a Mac", () => {
    const msg = describeFetchError(netError("EHOSTUNREACH"), {
      url: "http://192.168.1.50:4100/health",
      appName: "Loxaic Beta",
      platform: "darwin",
    });
    expect(msg).toContain("192.168.1.50:4100");
    expect(msg).toContain("Loxaic Beta");
    expect(msg).toContain("Privacy & Security → Local Network");
  });

  it("does not blame macOS permission off a Mac, or for a public host", () => {
    for (const [url, platform] of [
      ["http://192.168.1.50:4100", "linux"],
      ["http://example.com:4100", "darwin"],
    ]) {
      const msg = describeFetchError(netError("EHOSTUNREACH"), { url, platform });
      expect(msg).not.toContain("Local Network");
      expect(msg).toContain("No route to");
    }
  });

  it("says nothing is listening for a refused connection", () => {
    expect(describeFetchError(netError("ECONNREFUSED"), { url: "http://192.168.1.50:4100" })).toContain(
      "nothing is listening",
    );
  });

  it("says the name doesn't resolve for a DNS failure", () => {
    expect(describeFetchError(netError("ENOTFOUND"), { url: "http://gpubox.example:4100" })).toContain(
      "gpubox.example doesn't resolve",
    );
  });

  it("names Local Network permission for a .local name that doesn't resolve on a Mac", () => {
    // Node reports a nonexistent .local name as ENOTFOUND (checked with a real
    // fetch); mDNS is gated by the same permission, so a denied app sees that too.
    const msg = describeFetchError(netError("ENOTFOUND"), {
      url: "http://mac-mini.local:4100",
      appName: "Loxaic Beta",
      platform: "darwin",
    });
    expect(msg).toContain("mac-mini.local");
    expect(msg).toContain("Loxaic Beta");
    expect(msg).toContain("Privacy & Security → Local Network");
    expect(msg).toContain("check the spelling");
  });

  it("keeps the plain spelling hint for a .local name off a Mac", () => {
    const msg = describeFetchError(netError("ENOTFOUND"), { url: "http://mac-mini.local:4100", platform: "linux" });
    expect(msg).not.toContain("Local Network");
    expect(msg).toBe("mac-mini.local doesn't resolve to an address. Check the spelling.");
  });

  it("treats EAI_AGAIN as a temporary lookup failure, not a misspelling", () => {
    const msg = describeFetchError(netError("EAI_AGAIN"), { url: "http://gpubox.example:4100" });
    expect(msg).not.toContain("spelling");
    expect(msg).toContain("gpubox.example");
    expect(msg).toContain("Try again in a moment");
  });

  it("reads the code from a multi-address AggregateError", () => {
    // The shape a real fetch to localhost:<closed port> throws on Node 24: an
    // AggregateError cause with an empty message. Stripping its own `code`
    // stands in for a Node that did not copy it up from the per-address errors.
    const agg = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:4100"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4100"), { code: "ECONNREFUSED" }),
      ],
      "",
    );
    const err = Object.assign(new TypeError("fetch failed"), { cause: agg });
    expect(describeFetchError(err, { url: "http://localhost:4100" })).toContain("nothing is listening");
  });

  it("names the address it is given, whatever was actually fetched", () => {
    // main.js passes the typed address, not the tsnet sidecar's loopback
    // listener the request really went to; the sentence must follow `url`.
    const msg = describeFetchError(netError("ECONNREFUSED"), { url: "http://loxaic-host:4100" });
    expect(msg).toContain("loxaic-host:4100");
    expect(msg).not.toContain("127.0.0.1");
  });

  it("reports a timeout as no answer", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeFetchError(timeout, { url: "http://10.0.0.5:4100" })).toContain("did not answer in time");
  });

  it("never falls back to a bare 'fetch failed' when a cause exists", () => {
    const odd = Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
    expect(describeFetchError(odd, { url: "http://127.0.0.1:9" })).toBe("fetch failed: bad port");
  });
});

describe("isLocalNetworkHost", () => {
  it.each([
    ["192.168.1.50", true],
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["172.32.0.1", false],
    ["169.254.10.1", true],
    ["printer.local", true],
    ["100.64.0.10", false],
    ["example.com", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLocalNetworkHost(host)).toBe(expected);
  });
});
