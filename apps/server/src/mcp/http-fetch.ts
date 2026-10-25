import type { BodyInit as UndiciBodyInit } from "undici";
import { guardedFetch } from "../agent/address-guard.ts";

/** Statuses a Response must be built with a null body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * The fetch an HTTP MCP transport uses. Unless the user confirmed a private
 * address (`allowPrivateNetwork`), every request goes through the SSRF guard,
 * which checks the address at connect time (a public hostname can re-resolve
 * to an internal one later) and never follows a redirect. The SDK follows a
 * same-origin redirect by calling this again, so every hop is checked here
 * whatever redirect policy the SDK has. Long-lived, because a tool call may
 * take up to CALL_TIMEOUT_MS and the event stream idles: the same deadlines
 * Node's own fetch has.
 */
export function mcpFetch(allowPrivateNetwork: boolean): typeof fetch {
  if (allowPrivateNetwork) return fetch;
  return async (input, init) => {
    // A Request brings its own method, headers and body; the SDK never passes
    // one, so refuse it rather than send a bare GET without its credentials.
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("MCP requests take a URL, not a Request");
    }
    // Every field passes through but `redirect`: the guard decides that. The
    // body and the response's stream are cast only because the DOM lib and
    // node:stream/web type the same runtime classes apart.
    const { redirect: _redirect, body, ...rest } = init ?? {};
    let res;
    try {
      res = await guardedFetch(new URL(input), { ...rest, body: body as UndiciBodyInit | null | undefined }, { longLived: true });
    } catch (err) {
      // undici says only "fetch failed"; the reason (the host does not
      // resolve, the connection was refused) is in its cause.
      const cause = (err as { cause?: unknown }).cause;
      if (err instanceof TypeError && cause instanceof Error) throw new Error(cause.message, { cause: err });
      throw err;
    }
    // Rebuilt as the global Response the SDK is typed against, so the compiler
    // checks every member it reads.
    const nullBody = NULL_BODY_STATUSES.has(res.status);
    if (nullBody) await res.body?.cancel().catch(() => undefined);
    return new Response(nullBody ? null : (res.body as ReadableStream<Uint8Array> | null), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
