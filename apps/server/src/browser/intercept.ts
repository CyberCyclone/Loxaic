/**
 * The browser's only way out (#281): every request a page makes is fetched by
 * the server, through the same guard as web_fetch, and handed back.
 *
 * Chromium itself has no usable network. It is launched with its proxy set to
 * a sinkhole on loopback that closes every connection (sinkhole.ts), so
 * anything this interception does not answer (a preconnect, a DNS prefetch, a
 * path through some future feature) fails rather than reaching the network
 * from the server's own host. What is answered is decided here, per request
 * and per redirect hop: http(s) only, the address checked at connect time
 * (guardedFetch), bounded size and count.
 */
import { BlockedTargetError, guardedFetch, type GuardedResponse } from "../agent/address-guard.ts";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { BrowserContextLike, PageLike, RouteLike } from "./types.ts";

export const RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const PAGE_MAX_BYTES = 50 * 1024 * 1024;
export const PAGE_MAX_REQUESTS = 300;
const REQUEST_TIMEOUT_MS = 15_000;
/** Redirect hops followed for one request, each checked like the first. */
export const MAX_REDIRECT_HOPS = 10;

/** Request headers that describe this hop, not the request; never forwarded.
 * `host` and `content-length` are recomputed for the request actually sent. */
const HOP_BY_HOP_REQUEST = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length",
]);

/** Response headers that would lie once the body is handed over decoded:
 * undici has already removed any content encoding and de-chunked it. */
const STALE_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** What a page has spent, so a page that requests without end is cut off. */
interface PageBudget {
  requests: number;
  bytes: number;
  /** The first refusal on the top-level document, so the tool can say why a
   * page did not load rather than "net::ERR_BLOCKED_BY_CLIENT". */
  refusal: string | null;
  /** Where the top-level document really came from after same-origin
   * redirects followed here; the browser still shows the URL it asked for. */
  documentUrl: string | null;
  /** The top-level document's own status, as fetched. */
  documentStatus: number | null;
}

/**
 * Pages render.ts opened. A request from any other page is a popup's
 * (window.open, target=_blank): it gets nothing, so a page cannot multiply its
 * request and byte allowance, or keep fetching after the tool call returns, by
 * opening windows. render.ts closes popups as well.
 */
const ownPages = new WeakSet<PageLike>();

export function claimPage(page: PageLike): void {
  ownPages.add(page);
}

export function isClaimed(page: PageLike): boolean {
  return ownPages.has(page);
}

const budgets = new WeakMap<PageLike, PageBudget>();

export function pageBudget(page: PageLike): PageBudget {
  let budget = budgets.get(page);
  if (!budget) {
    budget = { requests: 0, bytes: 0, refusal: null, documentUrl: null, documentStatus: null };
    budgets.set(page, budget);
  }
  return budget;
}

/** The decision for one request before anything is fetched. Pure, so every
 * branch is pinned by a test without a browser. */
export function admitRequest(rawUrl: string, budget: PageBudget): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Only http and https are fetched (got ${url.protocol}).` };
  }
  if (budget.requests >= PAGE_MAX_REQUESTS) {
    return { ok: false, reason: `The page made more than ${String(PAGE_MAX_REQUESTS)} requests.` };
  }
  if (budget.bytes >= PAGE_MAX_BYTES) {
    return { ok: false, reason: `The page loaded more than ${String(PAGE_MAX_BYTES / 1024 / 1024)} MB.` };
  }
  return { ok: true, url };
}

/**
 * The next request after a redirect, or null when `status` is not one. A 303,
 * and a 301/302 answering a POST, become a GET without a body, as browsers do.
 * Credentials the browser attached never travel to a different origin, which
 * includes the same host over plain http: a Secure cookie must not go out in
 * clear text.
 */
export function redirectHop(
  from: URL,
  status: number,
  location: string | null,
  request: { method: string; headers: Record<string, string>; body: Buffer | undefined },
): { url: URL; method: string; headers: Record<string, string>; body: Buffer | undefined } | null {
  if (![301, 302, 303, 307, 308].includes(status) || !location) return null;
  let url: URL;
  try {
    url = new URL(location, from);
  } catch {
    return null;
  }
  const toGet = status === 303 || ((status === 301 || status === 302) && request.method === "POST");
  const headers = { ...request.headers };
  if (url.origin !== from.origin) {
    delete headers.cookie;
    delete headers.authorization;
  }
  if (toGet) {
    delete headers["content-type"];
    return { url, method: "GET", headers, body: undefined };
  }
  return { url, method: request.method, headers, body: request.body };
}

/**
 * An HTML document that arrived from a different URL than the browser asked
 * for gets a `<base>` naming where it came from, so its relative links resolve
 * as they would have. A document with its own `<base>` is left alone.
 */
export function withBaseHref(html: string, finalUrl: string): string {
  if (/<base[\s>]/i.test(html)) return html;
  const tag = `<base href="${finalUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

/**
 * What a navigation that redirects to another origin is answered with: a page
 * that goes there. Following that hop here and handing back its body would
 * run the other origin's document as the origin the browser asked for, with
 * that origin's cookies and storage in reach (an open redirect anywhere would
 * be cross-site scripting). Navigating makes the browser ask for the new URL
 * itself, as a new request this interception checks again, and the document
 * then has its real origin.
 */
export function navigationStub(href: string): Buffer {
  const target = JSON.stringify(href).replace(/</g, "\\u003c");
  return Buffer.from(
    `<!doctype html><meta name="referrer" content="no-referrer"><script>location.replace(${target})</script>`,
    "utf8",
  );
}

export function forwardableRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST.has(lower) || lower.startsWith(":")) continue;
    out[lower] = value;
  }
  return out;
}

/** Response headers for `route.fulfill`. Several `Set-Cookie` values go as
 * one newline-joined value, which is how Playwright carries a repeated header
 * to Chromium (each line becomes its own header). */
export function fulfillHeaders(headers: GuardedResponse["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STALE_RESPONSE.has(lower) || lower === "set-cookie") return;
    out[lower] = value;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies.join("\n");
  return out;
}

/** Reads a body up to `max` bytes; null when it is bigger. */
async function readCapped(body: GuardedResponse["body"], max: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const reader = (body as WebReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function answer(route: RouteLike, page: PageLike | null): Promise<void> {
  const request = route.request();
  if (page === null || !ownPages.has(page)) {
    // A popup, or a page that is not render.ts's: refused outright.
    await route.abort("blockedbyclient").catch(() => undefined);
    return;
  }
  const budget = pageBudget(page);
  const isNavigation = request.isNavigationRequest();
  let isDocument = false;
  try {
    isDocument = isNavigation && request.frame() === page.mainFrame();
  } catch {
    // A navigation issued before its frame exists (a popup's first one).
    isDocument = false;
  }
  const refuse = async (reason: string): Promise<void> => {
    if (isDocument && budget.refusal === null) budget.refusal = reason;
    await route.abort("blockedbyclient").catch(() => undefined);
  };

  const admitted = admitRequest(request.url(), budget);
  if (!admitted.ok) {
    await refuse(admitted.reason);
    return;
  }
  budget.requests++;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    // Chromium follows a fulfilled redirect on its own, outside this
    // interception, and that request would only die at the sinkhole. So
    // same-origin hops are followed here, each admitted and checked like the
    // first; a navigation to another origin is handed back to the browser.
    const method = request.method();
    let hop: { url: URL; method: string; headers: Record<string, string>; body: Buffer | undefined } = {
      url: admitted.url,
      method,
      headers: forwardableRequestHeaders(await request.allHeaders()),
      body: method === "GET" || method === "HEAD" ? undefined : (request.postDataBuffer() ?? undefined),
    };
    // Cookies a hop on the requested origin sets are the browser's to keep;
    // one from any other origin cannot be stored against this URL.
    const sameOriginCookies: string[] = [];
    let response = await guardedFetch(hop.url, { method: hop.method, headers: hop.headers, body: hop.body, signal: controller.signal });
    for (let hops = 0; ; hops++) {
      const next = redirectHop(hop.url, response.status, response.headers.get("location"), hop);
      if (!next) break;
      if (hops >= MAX_REDIRECT_HOPS) {
        await refuse(`More than ${String(MAX_REDIRECT_HOPS)} redirects.`);
        return;
      }
      const nextAdmitted = admitRequest(next.url.href, budget);
      if (!nextAdmitted.ok) {
        await refuse(nextAdmitted.reason);
        return;
      }
      if (hop.url.origin === admitted.url.origin) sameOriginCookies.push(...response.headers.getSetCookie());
      await response.body?.cancel().catch(() => undefined);
      if (isNavigation && next.url.origin !== admitted.url.origin) {
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
        if (sameOriginCookies.length > 0) headers["set-cookie"] = sameOriginCookies.join("\n");
        await route.fulfill({ status: 200, headers, body: navigationStub(next.url.href) });
        return;
      }
      budget.requests++;
      hop = next;
      response = await guardedFetch(hop.url, { method: hop.method, headers: hop.headers, body: hop.body, signal: controller.signal });
    }
    const remaining = Math.max(0, Math.min(RESOURCE_MAX_BYTES, PAGE_MAX_BYTES - budget.bytes));
    let bytes = await readCapped(response.body, remaining);
    if (bytes === null) {
      await refuse(`A response was larger than ${String(Math.round(remaining / 1024 / 1024))} MB.`);
      return;
    }
    budget.bytes += bytes.length;
    const headers = fulfillHeaders(response.headers);
    // A subresource that ended on another origin keeps working, but whatever
    // cookies that origin sent are not the requested origin's to store.
    if (hop.url.origin !== admitted.url.origin) delete headers["set-cookie"];
    if (sameOriginCookies.length > 0) {
      headers["set-cookie"] = [...sameOriginCookies, ...(headers["set-cookie"] ? [headers["set-cookie"]] : [])].join("\n");
    }
    if (hop.url.href !== admitted.url.href) {
      if (isDocument) budget.documentUrl = hop.url.href;
      if (/text\/html/i.test(headers["content-type"] ?? "")) {
        bytes = Buffer.from(withBaseHref(bytes.toString("utf8"), hop.url.href), "utf8");
      }
    }
    if (isDocument) budget.documentStatus = response.status;
    await route.fulfill({ status: response.status, headers, body: bytes });
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      await refuse("That address is private or loopback, and the browser does not reach it.");
      return;
    }
    if (isDocument && budget.refusal === null) {
      budget.refusal = controller.signal.aborted ? "The site took too long to answer." : `The request failed: ${(err as Error).message}`;
    }
    await route.abort("failed").catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

/** Puts every request of `context` through `answer`, and refuses WebSockets
 * outright: a reader has no use for one, and fetching one server-side would be
 * a second, long-lived egress path with its own rules. */
export async function installInterception(context: BrowserContextLike): Promise<void> {
  await context.route("**/*", async (route) => {
    // Nothing may escape a route handler: Playwright rethrows a handler's
    // error as an unhandled rejection, which ends the server process. Even
    // `frame()` throws, for a navigation issued before its frame exists.
    try {
      let page: PageLike | null = null;
      try {
        page = route.request().frame().page();
      } catch {
        page = null;
      }
      await answer(route, page);
    } catch {
      await route.abort("failed").catch(() => undefined);
    }
  });
  await context.routeWebSocket("**", (ws) => { ws.close(); });
}
