# Web browsing (web_fetch's browser fallback)

Some sites refuse a plain fetch (a 403 to anything that isn't a browser) or build the page with JavaScript, so `web_fetch` gets back an error or an empty shell. With web browsing on, Loxaic loads those pages in a headless Chromium instead and returns the text a person would see. The model can also ask for a screenshot, which appears on the tool card and, for a model that can see images, is sent to it.

It is **off by default**.

## Turning it on

1. Settings → Agent Sandbox → **Web browsing** (admins only).
2. Press **Install Chromium**. It downloads Playwright's `chromium-headless-shell` build (about 100 MB) into `BROWSER_DIR`. The desktop app keeps it in its data directory; a server run from a checkout uses `apps/server/browsers`.
3. Switch **Web browsing** on.

No Docker is needed. Chromium runs on the server's own machine.

## What it can and cannot reach

- **Each conversation gets its own Chromium process** with a fresh, temporary profile. Cookies, storage, cache and history never cross between conversations, the same person's included. A browser closes after five minutes unused, when its conversation is deleted, or when browsing is switched off.
- **Every request a page makes is fetched by the server**, through the same address check as `web_fetch`: pages, scripts, images, every redirect hop. Anything on a private, loopback or link-local address is refused. Chromium's own network points at a dead end, so a request the server does not answer fails rather than going out.
- **WebSockets, service workers and downloads are blocked.** This is for reading pages, not running web apps.
- **Chromium's own sandbox stays on.**

## Screenshots and models

A screenshot is stored like an uploaded image: it is owned by the conversation's owner, it counts against their storage quota, and anyone the conversation is shared with can see it.

It is sent to the model only when Loxaic knows the model can see images. Today that means a built-in llama.cpp model loaded with a vision projector. Models from a configured provider get the text only, because a provider records nothing about which of its models take images.

## Settings

| Setting | Default | Env variable |
|---|---|---|
| On / off | off | `BROWSER_ENABLED` |
| Close an unused browser after | 5 minutes | `BROWSER_IDLE_MS` |
| Browsers at once, across the server | 3 | `BROWSER_MAX` |
| One page's load-and-read time | 30 s | `BROWSER_ACTION_TIMEOUT_MS` |

Other variables:

- `BROWSER_DIR`: where the managed Chromium is installed.
- `BROWSER_EXECUTABLE`: use an existing Chrome or Chromium instead of the managed one. For example, Alpine's `chromium` package in the server container, where Playwright's build cannot run.
- `BROWSER_NO_SANDBOX=1`: launch Chromium without its own sandbox. Only for a server that already runs inside a container, where the kernel features the sandbox needs are missing. There is no switch for this in the app.

## When it will not start

The admin screen shows the last launch error.

- **Linux "No usable sandbox"**: Chromium's sandbox needs unprivileged user namespaces. On Ubuntu 23.10 and later, AppArmor restricts them. Either allow them for the Chromium binary with an AppArmor profile, or, inside a container, set `BROWSER_NO_SANDBOX=1`.
- **Missing shared libraries on Linux**: install Chromium's dependencies, e.g. `npx playwright-core install-deps chromium-headless-shell` as root.
