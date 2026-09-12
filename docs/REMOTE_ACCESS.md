# Remote access

How to reach your Loxaic host from outside your home network — the desktop app
on another machine, a phone, a laptop browser — **without opening any ports**
on your router.

The recommended path is [Tailscale](https://tailscale.com) (free for personal
use), and the desktop app has it built in: neither a host nor a desktop client
needs the Tailscale app installed. Nothing in Loxaic *depends* on it, though —
any reverse proxy or VPN that gives you an HTTPS URL works; skip to
[Without Tailscale](#without-tailscale) if you bring your own.

## How it fits together

- The server serves **both the API and the web app on one origin**. Remote
  browsers use a single HTTPS URL for everything — no CORS, no mixed content.
- HTTPS matters for browsers: an `https://` page cannot call `http://` or
  `ws://`. The built-in Tailscale support terminates TLS with a real certificate
  for you.
- The address a host is reached at is also the origin its sign-in cookies are
  issued for, so the host has to *know* it. That is what "Public address" and
  the tailnet setting below are for.

## Exposing a host on Tailscale (from the app)

In the desktop app, when setting the machine up as a **Host** — or later, from
**Settings → Server → Edit** — switch on **Expose on Tailscale** and give the
machine a name (it suggests one from the machine's own). Save. The app runs a
small bundled Tailscale node ([`infra/tsnet-proxy`](../infra/tsnet-proxy),
userspace WireGuard via `tsnet`) alongside the server: no system VPN, no
separate install, only Loxaic's traffic goes through it.

The first time, the machine has to be **approved** on your tailnet. A card on
the login screen (and in Settings) says so, with a button that opens the
approval link in your browser; sign in to your Tailscale account there and
approve. The card then shows the address other devices use:
`https://<name>.<your-tailnet>.ts.net`. That is a one-time step — the node's
identity is kept on the machine.

Two things have to be on in your tailnet's admin console for this to work:
**MagicDNS** and **HTTPS certificates** ([admin/dns](https://login.tailscale.com/admin/dns)).
Without them the card says exactly that instead of an address.

The host advertises the tailnet address automatically once it has one, unless
you set an explicit **Public address** — that always wins, as it does for a
reverse proxy. Behind the scenes the server is started a second time to pick
the address up, because sign-in cookies are scoped to it at boot; you will
see a brief blip the first time a tailnet host comes up.

### Reaching it

- **Desktop app on another machine**: choose **Connect to a host**, switch on
  **Connect through Tailscale**, enter the `https://….ts.net` address and press
  Check. That machine joins the tailnet the same way (approve it once in a
  browser), and the connection goes through its own local node — again with no
  Tailscale app installed.
- **Phone, or any browser**: the device needs to be *on* the tailnet, which on
  iOS/Android means the Tailscale app from the app store, signed into the same
  account. Then use the `https://….ts.net` address — in the mobile app's
  Settings → Server endpoint, or just in a browser. Embedding `tsnet` in the
  mobile app would need a native module with no React Native binding today,
  and would mean giving up Expo Go.

### Publishing to the internet (Funnel)

If you would rather not install Tailscale on your phone, switch on **Also
publish to the internet (Funnel)** as well. The same address is then reachable
from anywhere, relayed through Tailscale — a phone without the Tailscale app
reaches it like any website.

The trade: **anyone with the address can reach the sign-in page.** Loxaic's own
sign-in still stands between them and your data, but the door is on the public
internet rather than behind your tailnet, so use a strong password and keep an
eye on who has accounts. Funnel also has to be allowed for the node in your
tailnet's [policy file](https://tailscale.com/kb/1223/funnel); the card says
so if it is not.

### Unattended approval (auth keys)

For a machine nobody sits at — a headless box, a server in a cupboard — an
**Auth key** from [admin/settings/keys](https://login.tailscale.com/admin/settings/keys)
approves the node without a browser. It is stored on that machine only
(`secrets.json`, alongside the database password), never in `config.json` and
never in the process's arguments, and the form never shows it back.

### Self-hosted control plane (Headscale)

The **Control server** field (advanced) points the node at a
[Headscale](https://github.com/juanfont/headscale) instead of Tailscale's own
coordination server. Approval links then come from your Headscale, and the
card opens those the same way.

## Running the server in Docker?

The desktop app's built-in node is not involved there. Use the optional
sidecar overlay, which runs the official Tailscale container beside the
server:

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d
```

Set `TS_AUTHKEY` in `.env` (create one at
[admin/settings/keys](https://login.tailscale.com/admin/settings/keys)). The
sidecar joins the tailnet as `loxaic` and serves
`https://loxaic.<tailnet>.ts.net` → the server container. Config lives in
[`infra/tailscale/serve.json`](../infra/tailscale/serve.json). Or run
`tailscale serve --bg http://localhost:4000` on the Docker host itself.

## Expo Go on your phone (development)

1. Install **Tailscale** and **Expo Go** from the app store; sign Tailscale into
   your tailnet.
2. Run `npx expo start --tunnel` on your dev machine and scan the QR code. The
   app resolves the server endpoint automatically (LAN → tailnet); you can set
   it manually in Settings.

## Scripted launches (`TSNET_TARGET`)

`TSNET_TARGET=<host>:443` in the desktop app's environment makes it a client
of that tailnet host through its built-in node, before any stored config is
consulted — the same precedence as `--remote`/`LOXAIC_REMOTE_URL`. It exists
for scripted and test launches; the GUI's **Connect through Tailscale** is the
same thing with a card instead of a console. On a first run it opens the
approval link in your browser itself, and waits for you.

## Without Tailscale

Any of these work — Loxaic only needs an HTTPS URL for the host's
**Public address**:

- **Reverse proxy you already run** (Caddy, nginx, Traefik) with a certificate,
  forwarding to the server's port (enable WebSocket upgrades), and that URL as
  the Public address so cookies are issued for it.
- **Cloudflare Tunnel** (`cloudflared`) — free, no open ports, but traffic
  transits Cloudflare.
- **Plain LAN only**: skip all of this; a Host bound to *This network* is
  reachable at `http://<lan-ip>:<port>` and remote access simply won't work.
