# Deploying the app

The frontend is one universal Expo codebase (`apps/mobile`) targeting iOS,
Android, Web, and (via the web export) Electron.

## Website — served by the Shannon server

The Fastify server serves the Expo web export on the **same origin as the
API** — no CORS, no mixed content, one URL for everything (LAN or tailnet).

```bash
# 1. Build the web app
pnpm --filter @shannon/mobile export:web

# 2. (Re)start the server — it auto-detects apps/mobile/dist
pnpm --filter @shannon/server dev
```

Then open `http://<lan-ip>:4000` on your network, or
`https://<machine>.<tailnet>.ts.net` from anywhere on your tailnet
(see [REMOTE_ACCESS.md](REMOTE_ACCESS.md)).

Override the build location with `WEB_DIST_DIR` if you deploy the export
somewhere else. Without a build present, the server runs API-only.

## Expo Go on your phone

**Dev iteration** (with your dev machine running):

```bash
cd apps/mobile && npx expo start --tunnel
```

Scan the QR with Expo Go. The app auto-detects the server endpoint
(LAN first, then the tailnet URL — Settings override always wins).

> **Prerequisites (macOS):** raise the file-descriptor limit before starting
> Metro — this monorepo has ~22 k directories (almost all `node_modules`) and
> macOS defaults to 256 descriptors, so Metro's watcher dies with
> `EMFILE: too many open files`:
>
> ```bash
> ulimit -n 130000   # add to ~/.zshrc to make it permanent
> ```
>
> Watchman is the "official" alternative, but on this machine it fails with
> `FSEventStreamStart failed` (macOS FSEvents/TCC); it would need Full Disk
> Access to work. The `ulimit` route needs no daemon and no permissions.
>
> Tunnel mode also needs `@expo/ngrok` (`npm i -g @expo/ngrok`). If the phone
> is on your tailnet or LAN, skip the tunnel: plain `npx expo start`.

### Android emulator

The emulator often can't route to the host's LAN IP, so point it at
localhost over adb instead:

```bash
adb reverse tcp:8081 tcp:8081   # Metro
adb reverse tcp:4000 tcp:4000   # API server
adb shell am start -a android.intent.action.VIEW \
  -d "exp://127.0.0.1:8081" host.exp.exponent
```

(The app's own endpoint detection already falls back to `10.0.2.2:4000`,
the emulator's alias for the host, so the API works without the reverse
tunnel — but Metro needs it.)

**On the go via EAS Update** (no dev machine needed) — one-time setup:

```bash
npm install -g eas-cli
cd apps/mobile
eas login                # your Expo account
eas init                 # creates the project, writes extra.eas.projectId
eas update:configure     # installs expo-updates, writes updates.url
```

Then publish whenever you want the phone updated:

```bash
# Bake the endpoint URLs into the published bundle:
EXPO_PUBLIC_API_URL=https://<machine>.<tailnet>.ts.net \
EXPO_PUBLIC_LAN_API_URL=http://<lan-ip>:4000 \
eas update --branch preview --message "update"
```

Open the update from the EAS dashboard QR (or the project page) in Expo Go.
As long as Tailscale is connected on the phone, the app reaches your server
anywhere; at home it auto-picks the faster LAN connection.

## Endpoint resolution order (native apps)

1. Settings → endpoint override (never probed, always wins)
2. `EXPO_PUBLIC_LAN_API_URL` — probed via `GET /health` (1.5 s timeout)
3. `EXPO_PUBLIC_API_URL` (tailnet) — probed the same way
4. Platform default (`localhost:4000`, Android emulator `10.0.2.2:4000`)

Web builds skip probing: they're same-origin with the API.

## Electron

```bash
cd apps/desktop
pnpm dev       # dev: loads Metro's web build at localhost:8081
pnpm package   # prod: export:web + cross-compile the tsnet sidecar + electron-builder
```

Dev loads `http://localhost:8081` directly (run `pnpm --filter @shannon/mobile web`
alongside it). The packaged build serves the static `export:web` output through
the `app://` scheme via electron-serve, with SPA fallback — never `file://`
(expo-router's client-side routing needs the History API, and every asset
path is absolute, both of which break under `file://`).

There is no server at either origin, so unlike the mobile/web builds Electron
can't assume same-origin: its main process resolves the API base URL itself
(embedded-Tailscale proxy → LAN/tailnet probe → `localhost:4000`) and hands
it to the renderer via a `contextBridge` preload script. See
[REMOTE_ACCESS.md](REMOTE_ACCESS.md#electron-desktop-app) for the
embedded-Tailscale sidecar.

### Self-contained headless server

The same distributable runs with no window for server installs — a Proxmox
VM/LXC, a bare Linux box, anything you'd rather not put a display on. Two
equivalent ways to invoke it:

- **Convenience, on a machine with a display**: `Open-Shannon --headless`.
  The GUI binary re-execs itself as plain Node running `headless.js` before
  touching Electron/Chromium at all — best-effort, since a truly
  display-less machine may not let the GUI binary get that far.
- **The real headless path, for systemd**: set `ELECTRON_RUN_AS_NODE=1` and
  invoke `headless.js` inside the packaged app directly. This never
  initialises Chromium, so it needs no display and no `xvfb`, ever.

```ini
# /etc/systemd/system/open-shannon.service
[Unit]
Description=Open Shannon
After=network.target

[Service]
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=/opt/open-shannon/open-shannon /opt/open-shannon/resources/app/src/headless.js \
  --data-dir=/var/lib/open-shannon --port=4100
Restart=on-failure
User=shannon

[Install]
WantedBy=multi-user.target
```

(For an AppImage, extract it first — `./Open-Shannon.AppImage --appimage-extract`
— and point `ExecStart` at `squashfs-root/open-shannon` and
`squashfs-root/resources/app/src/headless.js`; a `.deb`/`.rpm` target with a
stable install path is tracked for a later pass.)

Flags: `--port` (default 4100, or `$SHANNON_PORT`), `--host` (default
`0.0.0.0`), `--data-dir` (default the platform user-data dir, or
`$SHANNON_DATA_DIR`), `--inference-url`, `--mock-inference`, `--help`. The
GUI's `--shannon-port`/`--shannon-data-dir` names are accepted too, so one
set of flags works with either entry point.

The GUI and the headless server share the same data directory by default (an
account created in one signs in from the other) — a machine can move between
"desktop app you look at" and "background service" without a migration step.
`Ctrl-C`/`SIGTERM` drains the server and shuts Postgres down cleanly before
exiting; a `systemctl restart` reuses the existing database.
