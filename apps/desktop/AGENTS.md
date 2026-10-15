# apps/desktop

The Electron app and its supervisor (`src/supervisor/`), which runs an embedded Postgres, the bundled server, the local executor and the tsnet sidecar with no Docker install. These rules cover instance config, IPC, the executor, Tailscale, packaging, updates and signing.

## Instance config and modes

- Instance mode lives in `<dataDir>/config.json` (`supervisor/config.js`), shared by `main.js` and `headless.js`. Its absence is the only first-run signal (onboarding, no stack started): anything that creates a data dir must seed one.
- config.json is renderer-readable: never put database credentials, auth secrets or keys in it. They live in `secrets.json` (0600) and are injected at spawn.
- The supervisor waits for the server's `LOXAIC_LISTENING <port>` stdout line (`supervisor/server.js`); don't change it on one side only.
- `solo` is forced to loopback in `buildConfig` whatever the caller asks; `host` requires a container sandbox.
- Derive `BETTER_AUTH_URL` from the advertised URL, never loopback (better-auth signs cookies for it), and pass `TRUSTED_ORIGINS` and `ADMIN_EMAILS` through to the server.

## IPC and the renderer

- **IPC channels are fixed names and none takes a path, URL or command from the renderer.** `loxaic:pickDirectory` takes no argument, `loxaic:executor.removeRoot` only narrows the list, and `openAuthUrl` opens only the link the sidecar printed.
- Wrap pushed listeners in `preload.cjs` so the renderer never receives Electron's `IpcRendererEvent` (its `sender` reaches back into the main process).
- `power.js` forwards `powerMonitor` events as `loxaic:power`; a wake counts only while the window is showing.

## Dev launch

- Keep `LOXAIC_DEV_STACK` (and any env the root `dev` script passes to a task) in `turbo.json`'s `dev.passThroughEnv`: turbo's strict env mode drops it silently, and the desktop then starts its own stack on :4100 against a different database.

## The local executor

- Folder paths reach the executor only from the native dialog. Nothing but `supervisor/executor-store.js` writes `<dataDir>/executor-roots.json` (0600).
- `LOXAIC_E2E_PICK_DIR` stands in for the dialog under test; read it only from the app's own env, with a loud one-time warning.
- Pass the executor's session token only on stdin, first line — never env, argv, disk or logs. `supervisor/executor.js` builds the child env from scratch; `executor.test.js` checks the token is absent.

## Tailscale sidecar

- The auth key goes to the sidecar on stdin and is stored in `secrets.json`, never config.json/argv/env. `setMode` peels it with `extractAuthKey`; absent means keep, empty means forget; never send it back to the form.

## Packaging (`scripts/`)

- `build-server.mjs` must ship everything the server needs at runtime: `node_modules/yaml`, and every file `sandbox.Dockerfile` `COPY`s (e.g. `sandbox/extract.py`). Its required-file list is the check.
- After an embedded-postgres bump, run `collectNative` over every platform's tarball; Windows carries the most libraries and no local test sees it.

## Versions and variants

- `parseReleaseTag` accepts only `vX.Y.Z` and `vX.Y.Z-beta.N`; CI's `meta` job uses the same parser, so change both together.
- Electron's major decides the packaged server's Node (Electron 33 is Node 20, while dev runs Node 24): bump it only in its own PR, after checking the server's runtime dependencies on that Node (e.g. `undici`, see `apps/server/src/inference/AGENTS.md`).

## Updater (`src/updates/`)

- Bound and catch `beforeInstall()`; the renderer bridge `.catch`es install failures into error state, never `void`s them.
- Updates are off when unpackaged, under `LOXAIC_DISABLE_UPDATES=1`/`--loxaic-no-updates`, or on Linux without `$APPIMAGE`. The Electron e2e must keep `LOXAIC_DISABLE_UPDATES=1`.
- Never verified: electron-updater against a real release, and Windows packaging. Don't claim either works.

## macOS signing

- Every nested Mach-O (embedded Postgres, `tsnet-proxy`) must be signed for notarization; verify with `codesign --verify --deep --strict`.
