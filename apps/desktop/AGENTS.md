# apps/desktop

The Electron app and its supervisor (`src/supervisor/`), which runs an embedded Postgres, the bundled server, the local executor and the tsnet sidecar with no Docker install. These rules cover instance config, IPC, the executor, Tailscale, packaging, updates and signing.

## Instance config and modes

- Instance mode lives in `<dataDir>/config.json` (`supervisor/config.js`), shared by `main.js` and `headless.js`. Its absence is the only first-run signal (onboarding, no stack started): anything that creates a data dir must seed one.
- Env and flags (`--remote`, `LOXAIC_REMOTE_URL`, `TSNET_TARGET`, `EXPO_PUBLIC_*`, a dev server on :4000) outrank config.json in `resolveApi()`. Don't reverse the order; e2e and scripts rely on it.
- Modes: `solo` is forced to loopback in `buildConfig`; `host` requires a container sandbox; `client` runs no local stack.
- Keep `instanceId` stable across mode changes (it is the `hosts` primary key and the executor's id). Detach drops it deliberately.
- Derive `BETTER_AUTH_URL` from the advertised URL, never loopback (better-auth signs cookies for it); pass `TRUSTED_ORIGINS` and `ADMIN_EMAILS` through.
- config.json is renderer-readable: never put database credentials, auth secrets or keys in it. They live in `secrets.json` (0600) and are injected at spawn.
- A mode switch stops the old stack before starting the new one (same port, one owner for the Postgres data dir).
- The packaged app defaults to port 4100 (`LOXAIC_PORT`) with an ephemeral-port embedded Postgres, never reads the repo `.env`, and its child env is built entirely by the supervisor.
- Set `UPLOADS_DIR` and `EGRESS_CA_DIR` under `dataDir`, never inside the installed bundle — an update replaces the bundle.
- `--reset-password` opens the DB through `supervisor/index.js`'s `openDatabase` (the one `startStack` uses); `startPostgres` adopts a running cluster from `postmaster.pid`, which makes it safe beside a running app.
- The supervisor waits for the server's `LOXAIC_LISTENING <port>` stdout line (`supervisor/server.js`); don't change it on one side only.

## IPC and the renderer

- **IPC channels are fixed names and none takes a path, URL or command from the renderer.** `loxaic:pickDirectory` takes no argument, `loxaic:executor.removeRoot` only narrows the list, and `openAuthUrl` opens only the link the sidecar printed.
- Wrap pushed listeners in `preload.cjs` so the renderer never receives Electron's `IpcRendererEvent` (its `sender` reaches back into the main process).
- Never use `loadFile()`/`file://` for the packaged build; use `electron-serve`'s `app://` scheme (router and absolute asset paths break otherwise).
- `power.js` forwards `powerMonitor` events as `loxaic:power`; a wake counts only while the window is showing.

## Dev launch

- In development `createWindow()` does not return until Metro answers; attach the window's `closed` handler and close the dev-server waiting window before that await.
- `dev-launch.js` waits for the dev server only when `LOXAIC_DEV_STACK=1`; otherwise it probes once.
- Keep `LOXAIC_DEV_STACK` (and any env the root `dev` script passes to a task) in `turbo.json`'s `dev.passThroughEnv`: turbo's strict env mode drops it silently, and the desktop then starts its own stack on :4100 against a different database.

## The local executor

- Folder paths reach the executor only from the native dialog. Nothing but `supervisor/executor-store.js` writes `<dataDir>/executor-roots.json` (0600).
- `LOXAIC_E2E_PICK_DIR` stands in for the dialog under test; read it only from the app's own env, with a loud one-time warning.
- Pass the executor's session token only on stdin, first line — never env, argv, disk or logs. `supervisor/executor.js` builds the child env from scratch; `executor.test.js` checks the token is absent.
- The executor's id is the desktop's `instanceId`, falling back to `<dataDir>/executor.json` only for an env/flag-pointed launch with no config.
- Pass `SANDBOX_BUILD_CONTEXT` to the executor as well as the server.

## Tailscale sidecar

- `supervisor/tsnet.js` runs at most one `infra/tsnet-proxy` (`client` or `serve`). Renderer tailnet state derives only from its stdout protocol (`AUTH_URL`, `LISTENING`, `SERVING`, `STATUS`).
- Tailnet settings are written only through `setMode`/`buildConfig`; `tailnet.*` IPC channels are live state and actions, never settings.
- The auth key goes to the sidecar on stdin and is stored in `secrets.json`, never config.json/argv/env. `setMode` peels it with `extractAuthKey`; absent means keep, empty means forget; never send it back to the form.
- A tailnet host starts on its LAN address with the sidecar unawaited, and on `SERVING` restarts only the server child via `stack.setAdvertiseUrl()`. An explicit `advertiseUrl` wins and skips the restart.
- Launch never blocks on a tailnet: only a user's Save/Connect sets `startForConfig`'s `wait`; launch waits at most `LAUNCH_TSNET_GRACE_MS`.
- Auto-open the auth link in a browser only on the `TSNET_TARGET` env path (no GUI there; also keeps e2e from opening tabs).
- Keep serve and client state dirs separate (`<dataDir>/tsnet-serve`, `<dataDir>/tsnet`); don't move the client path, or approved clients lose their node identity.
- `explainExit` order: the sidecar's `tsnet-proxy:` fatal line, then a tsnet `health(…): error:` line, then the last OS/shell line.

## Packaging (`scripts/`)

- Keep `asar: false` in `scripts/builder-variants.cjs`: embedded-postgres `spawn`s its binaries and makes symlinks asar breaks. With it, `mac.target` must include `zip` (MacUpdater downloads the zip).
- `build-server.mjs` must ship everything the server needs at runtime: `node_modules/yaml`, and every file `sandbox.Dockerfile` `COPY`s (e.g. `sandbox/extract.py`). Its required-file list is the check.
- Every package ships `THIRD_PARTY_NOTICES.txt`, `LICENSE`, `NOTICE`, and Electron's and Chromium's licences; `scripts/third-party-notices.mjs` runs in every `package*` script.
- The notices step fails the build on a missing required npm dependency, a package with no licence, or a shared library unmatched in `licenses/native-libraries.json`. Don't weaken it; add the library to the manifest.
- Copy Electron/Chromium licences into `resources/electron-licenses/` with a fallback to the release zip via `@electron/get`; never rely on `node_modules/electron/dist` alone (pnpm skips electron's install script in CI).
- Reach embedded-postgres' platform package through `collectNpm`, not `require.resolve` (it exports no `package.json`).
- After an embedded-postgres bump, run `collectNative` over every platform's tarball; Windows carries the most libraries and no local test sees it.

## Versions and variants

- `parseReleaseTag` accepts only `vX.Y.Z` and `vX.Y.Z-beta.N`; CI's `meta` job uses the same parser, so change both together.
- `stamp-version.mjs` stamps the mobile app with the numeric version even on beta tags (Apple rejects `-beta.N`); desktop and server keep the full version.
- `LOXAIC_VARIANT` makes "Loxaic Beta" a separate app (own `appId`, product name, artifact name, data dir); the running app reads its variant from `src/variant.js` (`extraMetadata`).
- Keep top-level `productName` set — Electron derives `app.name` and `userData` (the Chromium profile) from it.
- Electron's major decides the packaged server's Node (Electron 33 is Node 20, while dev runs Node 24): bump it only in its own PR, after checking the server's runtime dependencies on that Node (e.g. `undici`, see `apps/server/src/inference/AGENTS.md`).

## Updater (`src/updates/`)

- **The beta variant pins `autoUpdater.channel = "beta"`; `allowPrerelease` alone would install the stable app over beta.** Stable sets neither.
- Reset `allowDowngrade = false` immediately after assigning `channel` (the setter flips it true); `updater.test.js`'s fake mimics this.
- Read `autoUpdater` as `mod.autoUpdater ?? mod.default.autoUpdater` after `import("electron-updater")`; the CJS getter is not a named ESM export. Keep the test that imitates the real module shape.
- In `install()`: await `shutdownChildren()`, then set `quitting`, then `quitAndInstall`. The `before-quit` handler steps aside when `quitting` is set (its `app.exit` would kill the installer handover).
- Bound and catch `beforeInstall()`; the renderer bridge `.catch`es install failures into error state, never `void`s them.
- Keep `state.js` a pure reducer with no `require("electron")`: an error clears when the next check starts; a downloaded update is sticky except while `installing`.
- Updates are off when unpackaged, under `LOXAIC_DISABLE_UPDATES=1`/`--loxaic-no-updates`, or on Linux without `$APPIMAGE`. The Electron e2e must keep `LOXAIC_DISABLE_UPDATES=1`.
- A `--dir` build has no `app-update.yml`, so enabling updates there always reports ENOENT; that is not a bug.
- Never verified: electron-updater against a real release, and Windows packaging. Don't claim either works.

## macOS signing

- Never restore `identity: null`; it would make every release unsigned. Skip signing locally with `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- Packaging with no keychain identity must still succeed with a warning; don't set `forceCodeSigning`.
- Keep `allow-jit`, `allow-unsigned-executable-memory` and `disable-library-validation` in `build/entitlements.mac.plist` (the app crashes or refuses native modules without them); no App Sandbox keys; `entitlements` and `entitlementsInherit` name the same file.
- `gatekeeperAssess: false` is deliberate (the check runs before notarization); verify with `spctl -a -vv -t install` on the stapled build.
- Notarization needs all of `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; none set skips silently, one or two set throws.
- Every nested Mach-O (embedded Postgres, `tsnet-proxy`) must be signed for notarization; verify with `codesign --verify --deep --strict`.
