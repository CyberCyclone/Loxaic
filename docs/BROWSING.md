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

The admin screen shows why the last launch failed.

### "Chromium's sandbox needs unprivileged user namespaces" (Ubuntu 23.10 and later)

Ubuntu restricts unprivileged user namespaces with AppArmor (`kernel.apparmor_restrict_unprivileged_userns = 1`), and Chromium's sandbox needs them. Ubuntu ships profiles that allow it for Google Chrome and the Chromium snap, but not for the build Loxaic installs. Give that build its own profile, in the same form as Ubuntu's `/etc/apparmor.d/chrome`, then reload it (needs root):

```bash
sudo tee /etc/apparmor.d/loxaic-chromium >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

# Loxaic's managed Chromium (web_fetch's browser fallback). Unconfined like
# Ubuntu's own chrome profile; it exists to allow user namespaces.
profile loxaic-chromium /home/*/{.config/Loxaic*,**/apps/server}/browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,
  include if exists <local/loxaic-chromium>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/loxaic-chromium
```

The path covers the desktop app (`~/.config/Loxaic…/browsers`) and a server run from a checkout (`apps/server/browsers`). With a different `BROWSER_DIR` or `BROWSER_EXECUTABLE`, put that binary's path in the profile instead. Nothing needs restarting: the next fetch launches with the sandbox.

Do not turn the restriction off system-wide, and do not use `BROWSER_NO_SANDBOX` on a host: without its sandbox, a page that exploits Chromium runs as the server's user.

### Other failures

- **Inside a container**, the sandbox's kernel features are usually missing. There, and only there, set `BROWSER_NO_SANDBOX=1`: the container is the boundary.
- **Missing shared libraries on Linux**: install Chromium's dependencies, e.g. `sudo npx playwright-core install-deps chromium-headless-shell`.
