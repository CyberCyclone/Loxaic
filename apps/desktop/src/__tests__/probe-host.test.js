import { describe, it, expect } from "vitest";
import http from "node:http";
import { noTlsThere, probeCandidates, probeRequest } from "../probe-host.js";

const answer = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});
/** The shapes Node's fetch throws, measured against real servers. */
const netError = (code, message = code) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });
const refused = () => netError("ECONNREFUSED");
const plaintextReply = () => netError("ERR_SSL_PACKET_LENGTH_TOO_LONG", "packet length too long");
const selfSigned = () => netError("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate");
const reset = () => netError("ECONNRESET");
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** A stand-in for fetch that answers per URL and records what was asked. */
function server(routes) {
  const asked = [];
  const request = async (url) => {
    asked.push(url);
    const route = routes[url];
    if (route === undefined) throw refused();
    if (typeof route === "function") throw route();
    return route;
  };
  return { asked, request };
}

const describeErr = (err, url) => `could not reach ${url}: ${err.cause?.code ?? err.name}`;
const both = [{ url: "https://box:4100" }, { url: "http://box:4100" }];
const httpUp = { "http://box:4100/health": answer(200), "http://box:4100/v1/cluster": answer(404) };

describe("noTlsThere", () => {
  it("is true only when nothing speaks TLS at the address", () => {
    expect(noTlsThere(refused())).toBe(true);
    expect(noTlsThere(plaintextReply())).toBe(true);
    expect(noTlsThere(netError("ERR_SSL_WRONG_VERSION_NUMBER"))).toBe(true);
    // localhost resolves twice; both attempts refused is still "nothing there".
    expect(
      noTlsThere(Object.assign(new TypeError("fetch failed"), { cause: { errors: [refused().cause, refused().cause] } })),
    ).toBe(true);
    for (const err of [selfSigned(), reset(), timeout(), netError("ERR_TLS_CERT_ALTNAME_INVALID"), netError("ENOTFOUND")]) {
      expect(noTlsThere(err)).toBe(false);
    }
  });
});

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

  it("falls back to http when nothing listens for https, and flags it", async () => {
    const { request } = server(httpUp);
    expect(await probeCandidates(both, { request, describe: describeErr })).toEqual({
      ok: true,
      url: "http://box:4100",
      plainHttp: true,
    });
  });

  it("falls back to http when a plain-HTTP server answers the TLS hello", async () => {
    const { request } = server({ "https://box:4100/health": plaintextReply, ...httpUp });
    expect(await probeCandidates(both, { request, describe: describeErr })).toMatchObject({ ok: true, url: "http://box:4100" });
  });

  it("never falls back past a certificate error, a reset or a timeout", async () => {
    // The failures someone on the network can cause; each is reported, and
    // plain http is never asked.
    for (const failure of [selfSigned, reset, timeout]) {
      const { asked, request } = server({ "https://box:4100/health": failure, ...httpUp });
      const result = await probeCandidates(both, { request, describe: describeErr });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^could not reach https:\/\/box:4100/);
      expect(asked).toEqual(["https://box:4100/health"]);
    }
  });

  it("does not fall back when https answers with an error status", async () => {
    // A 503 is the server talking; trying http would hide what it said.
    const { asked, request } = server({ "https://box:4100/health": answer(503), ...httpUp });
    expect(await probeCandidates(both, { request, describe: describeErr })).toEqual({ ok: false, reason: "Server answered 503" });
    expect(asked).toEqual(["https://box:4100/health"]);
  });

  it("does not take an http redirect as http answering", async () => {
    // A followed http→https redirect would save the cleartext address.
    const { request } = server({ "http://box:4100/health": answer(301, {}, { location: "https://box:4100/health" }) });
    const result = await probeCandidates(both, { request, describe: describeErr });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      "could not reach https://box:4100: ECONNREFUSED (http://box:4100 said: It redirects to https://box:4100/health.)",
    );
  });

  it("reports the https failure, not the status plain http gave after it", async () => {
    const { request } = server({ "http://box:4100/health": answer(404) });
    const result = await probeCandidates(both, { request, describe: describeErr });
    expect(result).toEqual({
      ok: false,
      reason: "could not reach https://box:4100: ECONNREFUSED (http://box:4100 said: Server answered 404.)",
    });
  });

  it("reports the https failure, and that both were tried, when neither connects", async () => {
    const { request } = server({});
    expect(await probeCandidates(both, { request, describe: describeErr })).toEqual({
      ok: false,
      reason: "could not reach https://box:4100: ECONNREFUSED (Tried both https:// and http://.)",
    });
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

describe("probeRequest", () => {
  it("hands back a redirect rather than following it", async () => {
    // A real server and the real fetch: following this would land on https
    // and read as the http address answering.
    const redirecting = http.createServer((_req, res) => {
      res.writeHead(301, { location: "https://box.example.com/health" });
      res.end();
    });
    await new Promise((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = /** @type {import("node:net").AddressInfo} */ (redirecting.address());
      const res = await probeRequest(1500)(`http://127.0.0.1:${String(port)}/health`);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://box.example.com/health");
    } finally {
      redirecting.close();
    }
  });
});
