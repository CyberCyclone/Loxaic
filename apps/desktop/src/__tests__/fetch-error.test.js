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
      url: "http://192.168.1.13:4100/health",
      appName: "Loxaic Beta",
      platform: "darwin",
    });
    expect(msg).toContain("192.168.1.13:4100");
    expect(msg).toContain("Loxaic Beta");
    expect(msg).toContain("Privacy & Security → Local Network");
  });

  it("does not blame macOS permission off a Mac, or for a public host", () => {
    for (const [url, platform] of [
      ["http://192.168.1.13:4100", "linux"],
      ["http://example.com:4100", "darwin"],
    ]) {
      const msg = describeFetchError(netError("EHOSTUNREACH"), { url, platform });
      expect(msg).not.toContain("Local Network");
      expect(msg).toContain("No route to");
    }
  });

  it("says nothing is listening for a refused connection", () => {
    expect(describeFetchError(netError("ECONNREFUSED"), { url: "http://192.168.1.13:4100" })).toContain(
      "nothing is listening",
    );
  });

  it("says the name doesn't resolve for a DNS failure", () => {
    expect(describeFetchError(netError("ENOTFOUND"), { url: "http://pheonix.example:4100" })).toContain(
      "pheonix.example doesn't resolve",
    );
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
    ["192.168.1.13", true],
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["172.32.0.1", false],
    ["169.254.10.1", true],
    ["printer.local", true],
    ["100.93.38.95", false],
    ["example.com", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLocalNetworkHost(host)).toBe(expected);
  });
});
