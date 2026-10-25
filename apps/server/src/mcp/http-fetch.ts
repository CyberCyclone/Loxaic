import { guardedFetch } from "../agent/address-guard.ts";

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
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    // The SDK's own `redirect` is dropped: the guard decides that.
    const res = await guardedFetch(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    } as Parameters<typeof guardedFetch>[1], { longLived: true });
    // undici's Response, not the global one; the SDK reads only what both have.
    return res as unknown as Response;
  };
}
