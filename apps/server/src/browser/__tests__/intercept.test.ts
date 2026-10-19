import { Headers } from "undici";
import { describe, expect, it } from "vitest";
import {
  installInterception,
  admitRequest,
  forwardableRequestHeaders,
  fulfillHeaders,
  PAGE_MAX_BYTES,
  PAGE_MAX_REQUESTS,
  navigationStub,
  redirectHop,
  withBaseHref,
} from "../intercept.ts";

const fresh = () => ({ requests: 0, bytes: 0, refusal: null, documentUrl: null, documentStatus: null });

describe("admitRequest", () => {
  it("admits http and https", () => {
    expect(admitRequest("https://example.com/a", fresh()).ok).toBe(true);
    expect(admitRequest("http://example.com/a", fresh()).ok).toBe(true);
  });

  it.each(["file:///etc/passwd", "chrome://settings", "ftp://example.com/", "javascript:alert(1)", "not a url"])("refuses %s", (url) => {
    expect(admitRequest(url, fresh()).ok).toBe(false);
  });

  it("cuts a page off at its request count and its byte budget", () => {
    expect(admitRequest("https://example.com/", { ...fresh(), requests: PAGE_MAX_REQUESTS }).ok).toBe(false);
    expect(admitRequest("https://example.com/", { ...fresh(), bytes: PAGE_MAX_BYTES }).ok).toBe(false);
    expect(admitRequest("https://example.com/", { ...fresh(), requests: PAGE_MAX_REQUESTS - 1 }).ok).toBe(true);
  });
});

describe("forwardableRequestHeaders", () => {
  it("drops hop-by-hop and recomputed headers and keeps the rest", () => {
    const out = forwardableRequestHeaders({
      Host: "example.com",
      Connection: "keep-alive",
      "Proxy-Authorization": "Basic x",
      "Content-Length": "3",
      ":authority": "example.com",
      Cookie: "a=1",
      "User-Agent": "Chrome/1",
      Accept: "text/html",
    });
    expect(out).toEqual({ cookie: "a=1", "user-agent": "Chrome/1", accept: "text/html" });
  });
});

describe("fulfillHeaders", () => {
  it("drops the encoding headers undici already undid, and joins every Set-Cookie", () => {
    const headers = new Headers();
    headers.append("content-type", "text/html");
    headers.append("content-encoding", "gzip");
    headers.append("content-length", "10");
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    expect(fulfillHeaders(headers)).toEqual({ "content-type": "text/html", "set-cookie": "a=1\nb=2" });
  });
});

describe("redirectHop", () => {
  const from = new URL("https://a.example/start");
  const request = { method: "POST", headers: { cookie: "s=1", authorization: "Bearer t", "content-type": "x" }, body: Buffer.from("x") };

  it("is null for anything but a redirect with a location", () => {
    expect(redirectHop(from, 200, "/x", request)).toBeNull();
    expect(redirectHop(from, 302, null, request)).toBeNull();
    expect(redirectHop(from, 304, "/x", request)).toBeNull();
  });

  it("turns a 303, and a 301/302 after a POST, into a body-less GET", () => {
    for (const status of [301, 302, 303]) {
      const hop = redirectHop(from, status, "/next", request);
      expect(hop?.method).toBe("GET");
      expect(hop?.body).toBeUndefined();
      expect(hop?.headers["content-type"]).toBeUndefined();
    }
  });

  it("keeps the method and body for a 307 and 308", () => {
    for (const status of [307, 308]) {
      const hop = redirectHop(from, status, "/next", request);
      expect(hop?.method).toBe("POST");
      expect(hop?.body?.toString()).toBe("x");
    }
  });

  it("never carries credentials to another host", () => {
    const away = redirectHop(from, 302, "https://b.example/", request);
    expect(away?.headers.cookie).toBeUndefined();
    expect(away?.headers.authorization).toBeUndefined();
    const same = redirectHop(from, 307, "/again", request);
    expect(same?.headers.cookie).toBe("s=1");
  });

  it("drops them on the same host over plain http, or on another port: those are other origins", () => {
    const down = redirectHop(from, 307, "http://a.example/start", request);
    expect(down?.headers.cookie).toBeUndefined();
    expect(down?.headers.authorization).toBeUndefined();
    const port = redirectHop(from, 307, "https://a.example:8443/start", request);
    expect(port?.headers.cookie).toBeUndefined();
  });
});

describe("withBaseHref", () => {
  it("adds a <base> naming where the document came from, inside <head>", () => {
    expect(withBaseHref("<html><head><title>t</title></head></html>", "https://a.example/d/")).toBe(
      '<html><head><base href="https://a.example/d/"><title>t</title></head></html>',
    );
  });

  it("escapes the URL and leaves a document that has its own <base> alone", () => {
    expect(withBaseHref("<p>x</p>", 'https://a.example/?q="x"&y')).toBe('<base href="https://a.example/?q=&quot;x&quot;&amp;y"><p>x</p>');
    expect(withBaseHref('<head><base href="/own/"></head>', "https://a.example/")).toBe('<head><base href="/own/"></head>');
  });
});

describe("navigationStub", () => {
  it("navigates to the target and cannot be broken out of", () => {
    const html = navigationStub("https://b.example/x?q=</script><script>alert(1)</script>").toString("utf8");
    expect(html).toContain("location.replace(");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("installInterception", () => {
  it("never lets a handler error escape, even when Playwright's frame() throws", async () => {
    let handler: ((route: never) => Promise<void>) | null = null;
    const context = {
      route: (_pattern: string, h: (route: never) => Promise<void>) => { handler = h; return Promise.resolve(); },
      routeWebSocket: () => Promise.resolve(),
    };
    await installInterception(context as never);
    let aborted = false;
    const route = {
      request: () => ({
        url: () => "https://example.com/",
        frame: () => { throw new Error("Frame for this navigation request is not available"); },
        isNavigationRequest: () => true,
      }),
      abort: () => { aborted = true; return Promise.resolve(); },
    };
    expect(handler).not.toBeNull();
    await expect((handler as unknown as (r: unknown) => Promise<void>)(route)).resolves.toBeUndefined();
    expect(aborted).toBe(true);
  });
});
