# apps/server/src/browser

web_fetch's browser fallback (#281): one Chromium process per conversation (`manager.ts`), every request it makes fetched by the server (`intercept.ts`), pages loaded and read (`render.ts`), the browser build itself (`install.ts`). These rules keep one conversation's browsing out of every other's and keep a page from reaching anything the address guard would refuse.

## Isolation

- Key a browser by the conversation id of the run making the call (a sub-agent's own), never by anything a request or a model supplies. Add no API that takes a session, port, path or CDP URL.
- One `chromium.launch()` per conversation, with Playwright's temporary profile; never share a browser or a profile between conversations, the same user's included.
- Close a conversation's browser when the conversation is deleted (`conversations/delete.ts`), when browsing is switched off (in-flight launches too: `generation`), on idle and on `disconnected`.

## The network

- Launch with `chromiumArgs()`: the proxy is the sinkhole (`sinkhole.ts`) with `--proxy-bypass-list=<-loopback>`, unquoted. Anything interception misses must fail there, not reach the host's network.
- Answer every request through `installInterception` and `guardedFetch` (agent/address-guard.ts); never `route.continue()`, which hands the request to Chromium's own network.
- Follow same-origin redirects in `intercept.ts`, checking every hop: Chromium follows a fulfilled 3xx itself, outside interception. Never fulfill a navigation with another origin's body (it would run as the requested origin): answer it with `navigationStub`, so the browser makes a new, intercepted request. Drop `cookie` and `authorization`, and a cross-origin hop's `Set-Cookie`, whenever the origin changes.
- Refuse every request from a page render.ts did not `claimPage`, and close popups; nothing may throw out of a route handler (Playwright turns it into an unhandled rejection).
- Close every WebSocket; block service workers and downloads in the context.
- Keep Chromium's sandbox on. `BROWSER_NO_SANDBOX=1` is the only way off, env only, for a server already in a container; never fall back to it.
- Fall back from the managed build only on a sandbox failure, and only to `systemBrowsers()`: root-owned paths the OS already exempts. Never ask an admin to relax a system hardening (AppArmor, sysctl) to make browsing work.

## Reading pages

- Bound every page call by the action timeout and the run's signal; on a timeout close the conversation's browser, since the renderer may be wedged.
- Read page text in an isolated world (`readIsolated`), cut before it crosses CDP: the page's own scripts can redefine anything in the main world. Cap screenshots (`SCREENSHOT_MAX_BYTES`).
- `manager.ts` is the only importer of playwright-core, through a variable specifier; type it with `types.ts`, never the package's declarations (they push `tsc` past a 512 MB container).

## Tests

- `__tests__/chromium.test.ts` drives a real Chromium from `BROWSER_DIR` or the e2e cache (`~/.cache/loxaic-e2e/browsers`), and skips without one; CI installs it. Prove containment there, not with fakes.
