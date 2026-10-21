import { describe, it, expect } from "vitest";
import { probeCandidates } from "../probe-host.js";

const answer = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

/** A stand-in for fetch that answers per URL and records what was asked. */
function server(routes) {
  const asked = [];
  const request = async (url) => {
    asked.push(url);
    const route = routes[url];
    if (route === undefined || route instanceof Error) throw route ?? refused();
    return route;
  };
  return { asked, request };
}

const describeErr = (err, url) => `could not reach ${url}: ${err.cause?.code ?? err.message}`;
const both = [{ url: "https://box:4100" }, { url: "http://box:4100" }];

describe("probeCandidates", () => {
  it("stops at https when it answers, and never tries http", async () => {
    const { asked, request } = server({
      "https://box:4100/health": answer(200),
      "https://box:4100/v1/cluster": answer(200, { cluster: { id: "c", name: "Studio" }, hosts: [] }),
    });
    const result = await probeCandidates(both, { request, describe: describeErr });
    expect(result).toEqual({ ok: true, url: "https://box:4100", cluster: { id: "c", name: "Studio" }, hosts: [] });
    expect(asked.some((u) => u.startsWith("http://"))).toBe(false);
  });

  it("falls back to http when https does not connect, and returns the http address", async () => {
    const { request } = server({
      "http://box:4100/health": answer(200),
      "http://box:4100/v1/cluster": answer(404),
    });
    const result = await probeCandidates(both, { request, describe: describeErr });
    expect(result).toEqual({ ok: true, url: "http://box:4100" });
  });

  it("does not fall back when https answers with an error status", async () => {
    // A 503 is the server talking; trying http would hide what it said.
    const { asked, request } = server({ "https://box:4100/health": answer(503), "http://box:4100/health": answer(200) });
    const result = await probeCandidates(both, { request, describe: describeErr });
    expect(result).toEqual({ ok: false, reason: "Server answered 503" });
    expect(asked).toEqual(["https://box:4100/health"]);
  });

  it("reports the https failure, and that both were tried, when neither connects", async () => {
    const { request } = server({ "https://box:4100/health": new TypeError("certificate has expired") });
    const result = await probeCandidates(both, { request, describe: describeErr });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("could not reach https://box:4100: certificate has expired (Tried both https:// and http://.)");
  });

  it("asks the fetch base but names the typed address, for the tsnet sidecar", async () => {
    const { asked, request } = server({
      "http://127.0.0.1:5555/health": answer(200),
      "http://127.0.0.1:5555/v1/cluster": answer(404),
    });
    const result = await probeCandidates([{ url: "https://box.tail1234.ts.net", fetchBase: "http://127.0.0.1:5555" }], {
      request,
      describe: describeErr,
    });
    expect(result).toEqual({ ok: true, url: "https://box.tail1234.ts.net" });
    expect(asked[0]).toBe("http://127.0.0.1:5555/health");
  });

  it("says only the one failure for a single candidate", async () => {
    const { request } = server({});
    const result = await probeCandidates([{ url: "https://box.tail1234.ts.net", fetchBase: "http://127.0.0.1:1" }], {
      request,
      describe: describeErr,
    });
    expect(result).toEqual({ ok: false, reason: "could not reach https://box.tail1234.ts.net: ECONNREFUSED" });
  });
});
