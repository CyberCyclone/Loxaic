# Deploying the app

Two ways to run Loxaic — **self-contained** (one binary, brings its own
Postgres; recommended) or **Docker Compose** (containers for everything; the
dev workflow, and an alternative if you'd rather manage Postgres yourself).
Both serve the same frontend: one universal Expo codebase (`apps/mobile`)
targeting iOS, Android, Web, and (via the web export) Electron.

## Self-contained app (desktop + headless)

One distributable, two invocations:

```bash
cd apps/desktop
pnpm dev         # dev: brings up the embedded stack, loads Metro's web build at localhost:8081
pnpm package     # prod: full build — mac dmg, linux AppImage + deb, windows nsis (untested)
pnpm package:dir # prod, unpacked (skips the installer step — faster iteration)
```

### Desktop (GUI)

**First launch asks what this machine should be**, and the answer is stored in
`<dataDir>/config.json`:

- **Just this machine (Solo)** — the self-contained stack for you alone:
  embedded Postgres + the bundled server on loopback. No Docker/Podman needed.
- **Host for others** — the same stack, bound to your network so other people
  sign in and use its models. You give it a **name**, which is what appears
  against its models in everyone's model picker. Requires Docker or Podman:
  hosting runs other people's agent commands, and the server refuses to start
  without container isolation (see [RUNTIME.md](RUNTIME.md)).
- **Connect to a host** — no local stack at all; the app points at a Loxaic
  running elsewhere.

Settings has a **Server** section for changing a Solo/Host's port, bind
(LAN vs this machine only), public address, and Tailscale exposure later —
Save restarts the embedded stack on the new settings, without an app
restart. A Client can likewise change or re-probe which host it points at
from the same section. (An external PostgreSQL, instead of the embedded one,
has no GUI yet at all — first setup or later.)

A Host can **expose itself on Tailscale** from the same form, with no
Tailscale app installed: the desktop bundles a `tsnet` node that publishes
the server at `https://<name>.<tailnet>.ts.net` (optionally to the public
internet via Funnel), and a Client can connect through the same node. See
[REMOTE_ACCESS.md](REMOTE_ACCESS.md) — including the one-time browser
approval, the MagicDNS/HTTPS prerequisites, and why a tailnet host's first
start briefly restarts its server.

On launch the main process resolves how to reach a server, in order:
`--remote=<url>` / `LOXAIC_REMOTE_URL` (connect to a server elsewhere, skip
everything below) → the embedded-Tailscale proxy (`TSNET_TARGET`) → a
LAN/tailnet candidate that answers `/health` → in dev, a running `pnpm dev`
server on :4000 → **the stored instance mode** → otherwise, first-run
onboarding. Those environment overrides deliberately outrank the stored mode,
so a scripted or test launch always wins. The renderer has no server at its
own origin (`app://` in prod, `localhost:8081` in dev) so the resolved URL is
handed to it via a `contextBridge` preload script — see
[REMOTE_ACCESS.md](REMOTE_ACCESS.md#electron-desktop-app) for the
embedded-Tailscale sidecar.

### Headless (no window)

For server installs — a Proxmox VM/LXC, a bare Linux box, anything you'd
rather not put a display on. Two equivalent ways to invoke it:

- **Convenience, on a machine with a display**: `Loxaic --headless`.
  The GUI binary re-execs itself as plain Node running `headless.js` before
  touching Electron/Chromium at all — best-effort, since a truly
  display-less machine may not let the GUI binary get that far.
- **The real headless path, for systemd**: set `ELECTRON_RUN_AS_NODE=1` and
  invoke `headless.js` inside the packaged app directly. This never
  initialises Chromium, so it needs no display and no `xvfb`, ever.

```ini
# /etc/systemd/system/loxaic.service
[Unit]
Description=Loxaic
After=network.target

[Service]
Environment=ELECTRON_RUN_AS_NODE=1
ExecStart=/opt/loxaic/loxaic /opt/loxaic/resources/app/src/headless.js \
  --data-dir=/var/lib/loxaic --port=4100
Restart=on-failure
User=loxaic

[Install]
WantedBy=multi-user.target
```

A headless instance reads the same `config.json` the GUI writes, so a machine
set up through the app can be moved to a systemd unit without reconfiguring
it. On a box that has never seen the GUI, add `--as-host` (with optional
`--host-name`, `--bind`, and `--advertise-url`) to configure and start it as
a Host in one step. Headless **client** mode — joining someone else's host
with no window — is not built yet; the flag exits with a message rather than
silently starting a host instead.

For the AppImage, extract it first — `./Loxaic.AppImage --appimage-extract`
— and point `ExecStart` at `squashfs-root/loxaic` and
`squashfs-root/resources/app/src/headless.js`. The `.deb` build gives a
stable install path (`/opt/Loxaic` by default) without that extraction
step, which is why the unit above assumes one.

Flags: `--port` (default 4100, or `$LOXAIC_PORT`), `--host` (default
`0.0.0.0`), `--data-dir` (default the platform user-data dir, or
`$LOXAIC_DATA_DIR`), `--as-host`, `--host-name`, `--bind` (`lan` or
`localhost`, persisted with `--as-host`; default `lan`), `--advertise-url`
(persisted with `--as-host` — a reverse proxy or domain other machines
should use instead of this one's own LAN address), `--inference-url`,
`--mock-inference`, `--help`. The GUI's `--loxaic-port`/`--loxaic-data-dir`
names are accepted too, so one set of flags works with either entry point.

The GUI and the headless server share the same data directory by default (an
account created in one signs in from the other) — a machine can move between
"desktop app you look at" and "background service" without a migration step.
`Ctrl-C`/`SIGTERM` drains the server and shuts Postgres down cleanly before
exiting; a `systemctl restart` (or replacing the binary — see Upgrading
below) reuses the existing database.

### Ports and data

| | Server port | Postgres | Data directory |
|---|---|---|---|
| **Self-contained** (GUI or headless) | `4100` default — `LOXAIC_PORT` / `--loxaic-port` | embedded, ephemeral localhost port chosen at startup | platform user-data dir — `LOXAIC_DATA_DIR` / `--loxaic-data-dir` |
| **Dev** (`pnpm dev` + Compose) | `4000` | Compose, `localhost:5432` | Compose volume |

A self-contained release build and a dev checkout run **simultaneously on the
same host with zero collisions** — different ports, different Postgres,
separate data. Neither needs the other stopped; quitting either leaves the
other untouched.

### Upgrading

The GUI app updates itself — see "Desktop auto-update" below. For a headless
install, or an install from a `.deb`, replace the binary/`.app`/AppImage with
the new version. Either way the data directory
(embedded Postgres + generated secrets) is untouched, and migrations apply
automatically on next start — a failed migration is a **fatal boot error**
in this mode (`MIGRATIONS_STRICT=1`), not a silent skip, so a broken upgrade
can't leave the app quietly running against a stale schema. No separate
"run migrations" step.

## Docker Compose (alternative / dev)

The stack from `docker-compose.yml` — Postgres, the server, optionally
inference — is unchanged, and is still the dev workflow
(`pnpm dev` + `docker compose up db redis`, or the whole stack via
`docker compose up --build`). See [RUNTIME.md](RUNTIME.md) for the
container-engine and inference matrices, and [`.env.example`](../.env.example)
for every variable either deployment reads.

## Website — served by the Loxaic server

The Fastify server serves the Expo web export on the **same origin as the
API** — no CORS, no mixed content, one URL for everything (LAN or tailnet).
This is true for both deployment shapes above; the self-contained app just
does the build-and-serve step for you.

```bash
# 1. Build the web app
pnpm --filter @loxaic/mobile export:web

# 2. (Re)start the server — it auto-detects apps/mobile/dist
pnpm --filter @loxaic/server dev
```

Then open `http://<lan-ip>:4000` on your network (`:4100` for a
self-contained build), or `https://<machine>.<tailnet>.ts.net` from anywhere
on your tailnet (see [REMOTE_ACCESS.md](REMOTE_ACCESS.md)).

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

**Expo Go runs Metro only.** It cannot open a published EAS update — a
published update is built for a *runtime version* that only a real build of
this app has. To try the current state of `master` without a dev machine,
install a development or preview build (see Releases below) rather than
reaching for Expo Go.


## Releases and updates

A release is a git tag. Nothing else is committed: `apps/desktop/package.json`,
`apps/server/package.json` and `apps/mobile/app.json` all hold `0.0.0` in the
repository, and `apps/desktop/scripts/stamp-version.mjs` writes the real number
into all three during the release run.

| You push | Goes to | What sees it |
|---|---|---|
| a commit on `master` | `preview` branch | development and preview builds |
| `v1.2.3-beta.4` | `beta` branch + a GitHub pre-release | anyone who chose Beta in Settings |
| `v1.2.3` | `production` **and** `beta` branches + a GitHub release | everyone |

A release tag publishes to beta as well, so beta is always a superset of
production. Someone who opted in must never end up on an older build than a
stable release.

A tag builds desktop installers for macOS (arm64), Linux and Windows into a
**draft** release, and only undrafts it once every platform has finished
uploading and the mobile update has published. GitHub's `/releases/latest` and
its Atom feed both skip drafts, so no installed app can see a half-published
release.

### Channels are a runtime choice, not a separate app

There is one production binary. Settings → Updates switches which channel it
asks for, by setting the `expo-channel-name` request header
(`apps/mobile/lib/expo-updates.ts`). Switching back to production does not
downgrade the running build: it takes effect at the next update that channel
publishes.

### One-time setup

On the Expo account that owns the project:

```bash
cd apps/mobile
npx --yes eas-cli@latest login
npx --yes eas-cli@latest channel:create beta
npx --yes eas-cli@latest channel:edit beta --branch beta
npx --yes eas-cli@latest channel:list   # expect production→production, preview→preview, beta→beta
```

`npx`, rather than a bare `eas`, for two reasons that both bite in practice. A
global `npm install -g eas-cli` lands in the bin directory of whichever Node
version nvm had selected at the time, so it silently disappears from `PATH` the
next time you switch versions — which reads as "command not found" with the
binary still sitting on disk. And `eas.json` here requires `>= 13.0.0`, so a
global copy left over from an older project is refused by this one anyway.
Pinning `@latest` sidesteps both. CI is unaffected: `expo/expo-github-action`
puts a current `eas` on `PATH` itself, which is why the workflows call it
directly.

Repository secret `EXPO_TOKEN` (an Expo access token) is what lets CI publish;
the publish step fails without one. Both workflows skip themselves entirely on
a fork, so a fork's `master` never tries to publish to this project.

### Before the first production publish: sign the bundles

Over-the-air bundles are currently trusted on TLS alone — expo-updates accepts whatever the
update server returns, so a leaked or misused `EXPO_TOKEN` means arbitrary JS in every install.
Code signing makes a private key held *outside* CI the thing that authorises a bundle. It is
cheapest to add before anything real is published, because enabling it later needs a native
release to carry the certificate:

```bash
cd apps/mobile && npx expo-updates configuration:generate-signing-key
```

Commit the generated public certificate and the `codeSigningCertificate`/`codeSigningMetadata`
it adds to `app.json`; keep the private key out of the repository and out of CI secrets that
every branch can read; pass it to `eas update` in the publish step only.

### Native builds

`runtimeVersion` uses the `fingerprint` policy, so a change to native code or
dependencies produces a new runtime version and an update published for it
reaches no existing binary. The release workflow asks EAS whether a finished
production build already exists for the runtime it just published for, and
starts one only when none does — a JS-only release costs no build. Force one
with the `force_native_build` input on a `workflow_dispatch` run.

Stamping never changes the runtime version by itself: `stamp-version.mjs`
writes only `version` fields, and the fingerprinter ignores
`version`/`buildNumber`/`versionCode`.

### Desktop auto-update

The desktop app checks GitHub Releases for a newer build, downloads it, and offers a restart
from Settings → Updates. The channel is the same choice as on mobile and is stored in
`<dataDir>/updates.json`, so it survives a detach and a mode switch.

- **Stable** follows `/releases/latest`, which GitHub defines as the newest release that is
  neither a draft nor a pre-release — so a beta never reaches it.
- **Beta** additionally accepts pre-releases (`allowPrerelease`).
- **Switching back to Stable never downgrades you.** `allowDowngrade` stays off, so someone
  on `1.3.0-beta.2` keeps it until `1.3.0` proper is published.

Nothing installs itself behind your back: the download is automatic, the restart is a button.

**What the channel verifies, and what it does not.** On macOS a signed, notarized build is
verified by the OS on install. On Windows and Linux the installers are **not signed**, so the
only integrity check on a downloaded update is the `sha512` in `latest.yml` — a file written
and uploaded by the same CI job, into the same GitHub release, as the installer it describes.
That means anyone who can write an asset to a release (a compromised `GITHUB_TOKEN` or runner,
a hijacked build-time dependency with an install script, a stolen maintainer token) can ship a
trojaned installer with a matching hash, and every install would fetch it automatically and run
it on the next restart. Until Windows signing exists, treat desktop auto-update on Windows as
convenient rather than trustworthy, and keep the release workflow's write access as narrow as
it is.

**Checks are off** — with the reason shown in Settings rather than a silent no-op — in a
development build, when `LOXAIC_DISABLE_UPDATES=1` or `--loxaic-no-updates` is given, and on
Linux unless the app is running as an AppImage. A `.deb` is owned by the package manager;
update it the way you installed it.

Restarting into an update stops the embedded Postgres, the server, the executor and the
Tailscale sidecar first, and waits for them — the installer is about to replace the binary
those children were spawned from.

To test against this repository while it is still private, set `LOXAIC_GH_TOKEN` to a token
that can read it. It is never persisted and never logged, and it is for local testing only.

### macOS: signing and notarization

A macOS release build is signed with a Developer ID Application certificate and notarized by
Apple, so Gatekeeper opens it without a right-click-Open workaround. Both are driven entirely
by environment variables — nothing in `apps/desktop/package.json` names a certificate or an
Apple account:

| Secret | What it's for |
|---|---|
| `CSC_LINK` | The `.p12` certificate (base64-encoded, or a URL electron-builder can fetch) |
| `CSC_KEY_PASSWORD` | The passphrase the `.p12` was exported with |
| `APPLE_ID` | The Apple ID to submit the notarization request as |
| `APPLE_APP_SPECIFIC_PASSWORD` | An [app-specific password](https://support.apple.com/en-us/102654) for that Apple ID — never the account password |
| `APPLE_TEAM_ID` | The Developer Team ID the certificate belongs to |

Set as repository secrets, they take effect automatically in `release.yml`'s macOS build —
electron-builder imports the certificate into its own throwaway keychain and submits for
notarization once packaging finishes. Missing all five is not an error: a contributor's local
`pnpm --filter @loxaic/desktop package:dir` produces an unsigned build with a log warning, which
is what makes local development possible with no Apple account at all. Missing *some* of the
three notarization variables **is** an error, deliberately — a half-configured secret set should
fail loudly rather than notarize incorrectly.

To build unsigned on a machine that happens to have some other certificate in its keychain, set
`CSC_IDENTITY_AUTO_DISCOVERY=false` rather than editing the config — it's a per-invocation
choice, not a committed one.

Verifying a real signed, notarized build (needs a release actually built with the secrets
above):

```bash
codesign --verify --deep --strict Loxaic.app   # every nested binary signed, recursively
codesign -d --entitlements :- Loxaic.app         # confirm the three hardened-runtime grants
spctl -a -vv -t install Loxaic.app               # "accepted", source=Notarized Developer ID
xcrun stapler validate Loxaic.app                # the notarization ticket is stapled on
```

## Endpoint resolution order (native apps)

1. Settings → endpoint override (never probed, always wins)
2. `EXPO_PUBLIC_LAN_API_URL` — probed via `GET /health` (1.5 s timeout)
3. `EXPO_PUBLIC_API_URL` (tailnet) — probed the same way
4. Platform default (`localhost:4000`, Android emulator `10.0.2.2:4000`)

Web builds skip probing: they're same-origin with the API.
