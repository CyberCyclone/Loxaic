# Remote access

How to reach your Shannon server from outside your home network — phone (Expo Go),
laptop browser, or the Electron desktop app — **without opening any ports** on your
router.

The recommended path is [Tailscale](https://tailscale.com) (free for personal use:
3 users, 100 devices), but nothing in Shannon depends on it. Any reverse proxy or
VPN that gives you an HTTPS URL to the server works — skip to
[Without Tailscale](#without-tailscale) if you bring your own.

## How it fits together

- The Fastify server serves **both the API and the web app on one origin**
  (port 4000). Remote browsers use a single HTTPS URL for everything — no CORS,
  no mixed-content issues.
- **Native apps** (Expo Go / Electron) probe the LAN URL first and fall back to
  the tailnet URL, so they're fast at home and still work anywhere. You can
  always override the endpoint in Settings.
- HTTPS matters for browsers: an `https://` page cannot call `http://` or
  `ws://`. Tailscale Serve terminates TLS with a real certificate for you.

## Tailscale setup (once)

1. Install Tailscale on the **server host**, your **phone**, and any laptops you
   browse from, signed into the same tailnet: <https://tailscale.com/download>
2. In the [admin console](https://login.tailscale.com/admin/dns), enable
   **MagicDNS** and **HTTPS Certificates**.
3. On the server host, front the server with Tailscale Serve:

```bash
tailscale serve --bg http://localhost:4000
```

4. Note the URL it prints — `https://<machine>.<tailnet>.ts.net`. That's your
   server address from anywhere on your tailnet. Check it from your phone:
   `https://<machine>.<tailnet>.ts.net/health`.
5. Put it in `.env`:

```
PUBLIC_API_URL=https://<machine>.<tailnet>.ts.net
LAN_API_URL=http://<lan-ip>:4000
EXPO_PUBLIC_API_URL=https://<machine>.<tailnet>.ts.net
EXPO_PUBLIC_LAN_API_URL=http://<lan-ip>:4000
```

`tailscale serve` proxies WebSockets too, so chat/agent streaming works over
`wss://` unchanged. Serve is tailnet-only; if you ever want a truly public URL,
`tailscale funnel` is the opt-in equivalent — not recommended by default.

### Running the server in Docker?

Use the optional sidecar overlay instead of host-side `tailscale serve`:

```bash
docker compose -f docker-compose.yml -f docker-compose.tailscale.yml up -d
```

Set `TS_AUTHKEY` in `.env` (create one at
[admin/settings/keys](https://login.tailscale.com/admin/settings/keys)). The
sidecar joins the tailnet as `shannon` and serves
`https://shannon.<tailnet>.ts.net` → the server container. Config lives in
[`infra/tailscale/serve.json`](../infra/tailscale/serve.json).

## Expo Go on your phone

1. Install **Tailscale** and **Expo Go** from the app store; sign Tailscale into
   your tailnet.
2. Development: run `npx expo start --tunnel` on your dev machine and scan the
   QR code. In-app, the server endpoint resolves automatically (LAN → tailnet);
   you can set it manually in Settings.
3. On the go (no dev machine): the app is published via **EAS Update** — open
   the project's update URL/QR in Expo Go. As long as Tailscale is connected on
   the phone, the app reaches the server at the tailnet URL.

## Website from anywhere

Open `https://<machine>.<tailnet>.ts.net` in a browser on any tailnet device.
The server hosts the web app itself, so there is nothing else to deploy. The
device must be on your tailnet (that's the point — no public exposure).

## Electron desktop app

Unlike the mobile/web builds, Electron's renderer has no server at its own
origin to be same-origin with (dev loads Metro at `localhost:8081`; the
packaged app loads a static bundle through the `app://` scheme) — so its
main process always resolves the API URL itself and hands it to the renderer
via a `contextBridge` preload script, rather than the renderer probing
candidates on its own the way native/web builds do.

**Embedded Tailscale (`tsnet`)**: set `TSNET_TARGET` (host:port of your
`ts.net` address, e.g. `myserver.tail1234.ts.net:443`) before launching
Electron, and its main process spawns a small bundled Go sidecar
(`infra/tsnet-proxy`, built via `pnpm --filter @shannon/desktop
build:tsnet-proxy`) that joins the tailnet as its own node — userspace
WireGuard via [`tsnet`](https://pkg.go.dev/tailscale.com/tsnet), no OS-level
VPN, no separate Tailscale install, only Shannon's own traffic goes through
it — and exposes a local HTTP reverse proxy the renderer talks to. First run
needs interactive approval: the sidecar prints a `login.tailscale.com/a/...`
URL, which Electron opens in your default browser automatically. State
persists under Electron's `userData` dir, so login is one-time.

If `TSNET_TARGET` isn't set, or the sidecar doesn't come up within 5s, the
main process falls back to probing `LAN_API_URL`/`PUBLIC_API_URL` directly
(same candidates the native/web builds use) and finally `localhost:4000`.
Mobile stays on the standalone Tailscale app — embedding on iOS/Android would
need a native module wrapping gomobile-compiled `tsnet` with no RN binding
currently available, and would mean giving up Expo Go for a custom
EAS dev-client build.

## Without Tailscale

Any of these work — Shannon only needs an HTTPS URL in `PUBLIC_API_URL`:

- **Reverse proxy you already run** (Caddy, nginx, Traefik) with a certificate,
  forwarding to `localhost:4000` (enable WebSocket upgrades).
- **Cloudflare Tunnel** (`cloudflared`) — free, no open ports, but traffic
  transits Cloudflare.
- **Plain LAN only**: skip all of this and use `http://<lan-ip>:4000`; remote
  access simply won't work.
