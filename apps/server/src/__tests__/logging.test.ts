import { describe, expect, it } from "vitest";
import { redactUrl } from "../logging.ts";

/**
 * Regression lock on the credential-in-logs bug: two routes take a session
 * token in the query string because their clients can't send a header
 * (`/ws/chat?token=`, and `/v1/files/:ref?token=` behind an <img> src), and
 * Fastify's default request serializer logged `req.url` verbatim — writing a
 * live bearer token to stdout once per socket and once per thumbnail.
 */
describe("redactUrl", () => {
  it("replaces a token value while leaving the path intact", () => {
    expect(redactUrl("/v1/files/9dfa11c1-5539-42a9-804e-3177389226f0?token=s3cr3t")).toBe(
      "/v1/files/9dfa11c1-5539-42a9-804e-3177389226f0?token=REDACTED",
    );
  });

  it("redacts the WebSocket route the same way", () => {
    expect(redactUrl("/ws/chat?token=abc123")).toBe("/ws/chat?token=REDACTED");
  });

  it.each(["access_token", "refresh_token", "api_key", "apikey", "password", "secret"])(
    "redacts %s too",
    (param) => {
      expect(redactUrl(`/x?${param}=value`)).toBe(`/x?${param}=REDACTED`);
    },
  );

  it("matches the parameter name case-insensitively", () => {
    expect(redactUrl("/x?Token=abc")).toBe("/x?Token=REDACTED");
    expect(redactUrl("/x?API_KEY=abc")).toBe("/x?API_KEY=REDACTED");
  });

  it("keeps non-sensitive parameters readable, so log lines stay useful", () => {
    expect(redactUrl("/v1/files/abc?token=s3cr3t&width=64")).toBe("/v1/files/abc?token=REDACTED&width=64");
  });

  it("redacts every occurrence of a repeated token parameter", () => {
    // A duplicated key is a 401 at the auth layer (it arrives as an array),
    // but neither value may reach the log on the way to that rejection.
    const out = redactUrl("/x?token=one&token=two");
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
  });

  it("returns a url with no query string untouched", () => {
    expect(redactUrl("/v1/conversations")).toBe("/v1/conversations");
  });

  it("returns a url with nothing sensitive byte-for-byte unchanged, not re-encoded", () => {
    const url = "/v1/search?q=a%20b&sort=desc";
    expect(redactUrl(url)).toBe(url);
  });

  it("handles an empty query string and a bare '?' without throwing", () => {
    expect(redactUrl("/x?")).toBe("/x?");
    expect(redactUrl("/x?token=")).toBe("/x?token=REDACTED");
  });
});
