# @shannon/e2e

End-to-end suites driven by [WebdriverIO](https://webdriver.io/). One shared smoke spec is
written against `testID`s and runs unchanged on every platform; the per-platform difference is
confined to a selector mapping and a wdio config.

> **Status:** **web**, **Electron**, **Android** and **iOS** all run the same smoke spec
> unchanged and pass, each against a real build.

## Quick start (web)

From a fresh checkout, this is the whole thing:

```bash
pnpm install
pnpm --filter @shannon/e2e test:web
```

Everything else is automatic: the runner stands the stack up before the session and tears the
server down after. First run is slow (a couple of minutes) because it builds the Expo web
export; later runs reuse it.

**Prerequisites:** Docker (for Postgres), Node >= 22, and Google Chrome. WebdriverIO manages
its own matching chromedriver — nothing to install by hand.

To watch it happen in a real browser window instead of headless:

```bash
E2E_HEADED=1 pnpm --filter @shannon/e2e test:web
```

## Electron

Needs an unpacked desktop build first, then runs like any other suite:

```bash
pnpm --filter @shannon/desktop package:dir     # builds the web export + packages the app
pnpm --filter @shannon/e2e test:electron
```

Re-run `package:dir` whenever `apps/desktop` or the app itself changes — the suite drives the
built binary, not your working tree.

It runs against the **packaged** app rather than `pnpm dev` on purpose. Electron is the one
target that can't assume same-origin: the window loads from `app://`, where no server exists, so
the renderer only learns where the API is through the main process's `window.shannon.apiBaseUrl`
bridge. The dev shell loads Metro over http instead and never exercises that path.
`src/specs/electron/endpoint.spec.ts` covers the bridge specifically.

Chromedriver is matched to the Electron version automatically, read from the version
`apps/desktop` actually has installed — so the two can't drift apart.

### Self-contained mode

```bash
E2E_SELF_CONTAINED=1 pnpm --filter @shannon/e2e test:electron
```

Targets the packaged app's own embedded stack (its bundled Postgres + spawned server) instead of
a server this harness stands up — the strongest proof that a real install works end to end, not
just the renderer. `scripts/electron-env.ts` allocates a free port and a throwaway data directory
before `standup.ts` is even imported (module-load order matters here); `standup()`/`teardown()`
become no-ops since the app's own supervisor owns that stack's lifecycle. Electron-only — there is
no equivalent for the web suite, which has no supervisor to embed a stack under.

## iOS and Android

Both use Appium. Install its drivers once — they go into a repo-local `.appium/`, so a run uses
the versions this repo pins rather than whatever is installed globally:

```bash
pnpm --filter @shannon/e2e setup:appium
```

### Android

```bash
pnpm --filter @shannon/mobile prebuild:android
cd apps/mobile/android && ./gradlew assembleRelease
pnpm --filter @shannon/e2e test:android
```

Needs the Android SDK (`ANDROID_HOME`, or Android Studio's default location) and a running
emulator or connected device.

A **release** build is used because release embeds the JS bundle, so the app under test is
self-contained and no Metro server has to stay alive beside the suite. It is signed with the
debug keystore, which is fine for an emulator.

**Networking.** The suite runs `adb reverse` so the device reaches the server at plain
`localhost`. The emulator could instead use its `10.0.2.2` host alias — and does, by default, via
the app's own fallback — but that alias is emulator-only, whereas the reversed port behaves
identically on a physical device.

On the **default port 4000** that fallback needs no configuration at all. On **any other port**,
or on a physical device, the APK must be built with the URL baked in, because `EXPO_PUBLIC_*`
values are inlined at bundle time rather than read at runtime:

```bash
EXPO_PUBLIC_API_URL=http://localhost:4055 ./gradlew assembleRelease
E2E_PORT=4055 pnpm --filter @shannon/e2e test:android
```

Gradle caches the JS bundle, so changing that variable alone will not rebuild it — pass
`--rerun-tasks` (or delete `app/build/generated/assets`) when you change the URL.

Release builds block cleartext HTTP, which every self-hosted/LAN endpoint here relies on, so
`app.json` enables `usesCleartextTraffic` through `expo-build-properties`.

### iOS

```bash
pnpm --filter @shannon/mobile prebuild:ios
cd apps/mobile/ios && pod install
xcodebuild -workspace openshannon.xcworkspace -scheme openshannon \
  -configuration Release -sdk iphonesimulator -derivedDataPath build \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
pnpm --filter @shannon/e2e test:ios
```

Do **not** pass `CODE_SIGNING_ALLOWED=NO`. Simulator builds need no team or certificate —
Xcode ad-hoc signs them — but disabling signing entirely also strips the app's
*entitlements*, and the Keychain (expo-secure-store, where the session token lives) fails
every call without the application-identifier entitlement. The failure mode is nasty: the
app launches and sits on a blank white screen with no visible error, because the rejection
happens during session bootstrap before anything renders. Match `-destination` to a
simulator that exists for your Xcode's iOS runtime (`xcrun simctl list devices available`).

Point `E2E_IOS_DEVICE` at a simulator name (default `iPhone 15`) and `E2E_IOS_APP` at a `.app`
bundle if yours is somewhere other than the default derived-data path.

No port forwarding is needed: the simulator shares the host's loopback, so the app's own
`localhost` fallback already reaches the server, and App Transport Security exempts localhost
from HTTPS. That is why iOS needs neither `adb reverse` nor the cleartext opt-in Android does.

**Non-default ports need the URL baked in**, exactly like Android: the loopback fallback only
covers port 4000, and `EXPO_PUBLIC_*` values are inlined at bundle time. Without this the app
silently talks to whatever occupies 4000 — possibly a *real* dev server, which fails the mock
assertions confusingly (or worse, runs real inference):

```bash
EXPO_PUBLIC_API_URL=http://localhost:4055 xcodebuild ... build
E2E_PORT=4055 pnpm --filter @shannon/e2e test:ios
```

Two harness behaviours specific to iOS, both handled automatically:

- **The simulator keychain is reset before each run** (`onPrepare`). Unlike Android — where
  uninstalling the app wipes its storage — the iOS keychain survives reinstalls, so a previous
  run's session token would auto-sign the app in and break the sign-up spec on every re-run.
- **System alerts are auto-dismissed** (`appium:autoDismissAlerts`): iOS interrupts the first
  sign-in with a "Save Password?" sheet that sits above the app and blocks every element query.

Two setup traps worth knowing, both hit while building this:

- **CocoaPods needs a UTF-8 locale.** Without it `pod install` dies with
  `Unicode Normalization not appropriate for ASCII-8BIT`. Export `LANG=en_US.UTF-8`.
- **Xcode needs its iOS platform runtime downloaded**, separately from Xcode itself. Without it
  `xcodebuild` reports *"Found no destinations for the scheme"* / *"iOS <version> is not
  installed"* even though simulators exist and both SDKs are present — a confusing error, since
  nothing about it points at a missing runtime. Fix with `xcodebuild -downloadPlatform iOS`.

## What the smoke suite covers

`src/specs/smoke.spec.ts` — sign-up → sign-out → sign-in → send a chat message and see the
mock-inference reply → trigger an agent tool call and approve it through the permission bar →
sign-out. Assertions target the mock provider's deterministic output (`[Mock] Echo: …`,
`[Mock] Done. The tool returned: …`), which is what makes the run repeatable.

## What stand-up actually does

`scripts/standup.ts`, run automatically from the wdio `onPrepare` hook:

1. **Postgres** — reused if something already answers on the `DATABASE_URL` host/port,
   otherwise `docker compose up -d db` and wait for it.
2. **Migrations** — `pnpm --filter @shannon/db db:migrate`, run explicitly rather than relying
   on the server's boot-time migration (that one is cwd-sensitive and only logs on failure).
3. **Web export** — built if `apps/mobile/dist/index.html` is missing. Must happen *before* the
   server starts: static serving is only registered at boot, and only if the export exists.
4. **Server** — started with `MOCK_INFERENCE=true`, or reused if one is already healthy.
5. **Readiness gate** — polls `GET /health` until it reports both `database: "ok"` and
   `inference: "mock"`. That one check proves the DB is up *and* migrated (the endpoint runs a
   real query) and that the server booted in mock mode.

Every step is re-entrant, so running a suite on a machine that already has `pnpm dev` or another
checkout's containers up reuses what's there instead of colliding on a port.

Redis is **not** required: `STREAM_BACKEND` defaults to an in-memory broker, which is all a
single-server, single-run suite needs.

Docker is needed for more than Postgres — an approved `fs_write` executes in the agent sandbox,
so the tool-approval step of the smoke suite needs a working Docker socket.

## What the sandbox specs cover

`sandbox-bash.spec.ts`, `sandbox-settings.spec.ts`, and `sandbox-degraded.spec.ts` exercise the
admin-only sandbox settings API and GUI (mode, container engine, network access — see
`apps/server/src/settings.ts` and the `/sandbox` screen). They log in as a fixed admin account,
`e2e-admin@shannon.test` (see `helpers/auth.ts`'s `provisionAdmin()`), rather than a per-run unique
one: "whoever signs up first" is unreliable against a database stand-up reuses across runs, so this
email is granted the admin role via `ADMIN_EMAILS`, which `standup.ts` sets on the server it spawns.

These specs switch sandbox mode **live, through the real GUI**, mid-run — container → host → back
— rather than starting separate server processes per mode. That is a deliberate choice, not a
shortcut: it is a stronger test than a static per-mode server, because it exercises the exact
runtime-apply path `updateSandboxSettings()` exists for (resetting the container engine's cached
connection, stopping sandboxes so a new one picks up the new mode) — the same class of bug that
made an engine switch silently keep using the old engine before that code existed. A host-mode
sandbox created this way writes under a per-run temp directory (`artifacts/.run/sandboxes`,
via `SANDBOX_HOST_ROOT`) that `teardown()` removes.

Because mode is server-wide state, every sandbox spec restores it to the default
(`{mode: "container", engine: "auto", allowNetwork: false}`) in an `after()` hook, straight through
the API rather than the UI, so restoration still runs (and still works) if the test itself failed
partway through a UI flow — see `resetSandboxSettings()` in `helpers/app.ts`.

## Screenshots

`shot('name')` writes `artifacts/<platform>/<run-timestamp>/NN-name.png`, numbered in capture
order. Failures are captured automatically as `NN-FAILED-<test title>.png`.

**`artifacts/` is gitignored and screenshots are never committed.** They are evidence for the
PR description — drag the PNGs into the PR body. See AGENTS.md → "End-to-end tests".

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_PORT` | `4000` | Port the test server listens on. |
| `E2E_BASE_URL` | `http://localhost:$E2E_PORT` | Point the suite at an already-running stack. |
| `E2E_NO_STANDUP` | — | `1` skips stand-up entirely and assumes the stack is up. |
| `E2E_SELF_CONTAINED` | — | `1` targets a packaged Electron build's own embedded stack instead of a server this harness spawns — see "Self-contained mode" under Electron. |
| `E2E_FRESH_WEB` | — | `1` forces a rebuild of the Expo web export. Needed after any `apps/mobile` change — a stale export is reused otherwise (see `ensureWebExport()`), which silently tests old UI. |
| `E2E_HEADED` | — | `1` runs Chrome headed instead of headless. |
| `E2E_LOG_LEVEL` | `warn` | WebdriverIO log level (`trace`…`error`). |
| `E2E_IOS_DEVICE` | `iPhone 15` | Simulator to run the iOS suite on. |
| `E2E_IOS_VERSION` | — | Pin a simulator iOS version (e.g. `18.6`). |
| `E2E_IOS_APP` | — | Path to a built `.app` bundle, if not in the default location. |
| `E2E_ANDROID_AVD` | — | AVD to boot; otherwise uses the running emulator/device. |
| `ANDROID_HOME` | Android Studio's default SDK path | Android SDK location. |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/shannon` | Test database. |

Stand-up and teardown can also be driven on their own, which is handy when iterating on a spec
and you don't want to pay the start-up cost each time:

```bash
pnpm --filter @shannon/e2e standup
E2E_NO_STANDUP=1 pnpm --filter @shannon/e2e test:web
pnpm --filter @shannon/e2e teardown
```

## Writing a spec

Select by `testID`, never by CSS class, text position, or list index — the message list is
inverted *and* virtualised, so position is not stable. The convention for testIDs themselves
(`area.element[.qualifier]`) is documented in AGENTS.md.

```ts
import { tap, typeInto, waitForVisible } from '../helpers/selectors.ts';

await typeInto('composer.input', 'hello');
await tap('composer.send');
await waitForVisible('chat.messageList');
```

Prefer the app-level helpers in `src/helpers/app.ts` (`signIn`, `sendAndAwaitReply`, …) so specs
read as behaviour rather than as clicks.

## Layout

```
wdio.shared.ts        base config: hooks, timeouts, stand-up wiring
wdio.web.ts           web capabilities (Chrome against the served export)
wdio.electron.ts      electron capabilities (the packaged desktop build)
wdio.ios.ts           XCUITest against a simulator
wdio.android.ts       UiAutomator2 against an emulator/device
scripts/standup.ts    bring the stack up + readiness gate; also the teardown
scripts/native.ts     Appium home, SDK resolution, adb reverse, build paths
src/helpers/
  selectors.ts        testID → per-platform selector; the shared vocabulary
  app.ts              app-level steps (sign in, send a message, …)
  auth.ts             unique per-run test users
  screenshot.ts       named screenshots into artifacts/
src/specs/*.spec.ts   shared suites — every platform runs these
src/specs/<platform>/ platform-only suites, opted into by that platform's config
```

## How testIDs resolve, per platform

| Platform | `testID` becomes | Selector used | Confirmed? |
| --- | --- | --- | --- |
| web / Electron | `data-testid` attribute | `[data-testid="id"]` | yes, against a real build |
| Android | **unprefixed** `resource-id` | `new UiSelector().resourceId("id")` | yes, against a real build |
| iOS | `accessibilityIdentifier` | `~id` (accessibility id) | yes, against a real build |

The Android row is the one with a trap in it. Appium's `id` strategy prepends
`<appPackage>:id/`, which never matches a testID-derived resource-id — hence the raw
`UiSelector` form. Confirmed by dumping the live hierarchy from a release build on an emulator:
`resource-id="login.email"`, with no package prefix, under React Native 0.81 with the new
architecture enabled.

**Appium 3, not 2.** The current `uiautomator2` and `xcuitest` drivers both require Appium 3
(`^3.0.0-rc.2`); pinning Appium 2 would mean pinning older drivers, which is the riskier choice
against a recent Xcode and RN's new architecture.

## Asserting on text

`waitForTextIn` looks deliberately asymmetric, and the asymmetry is load-bearing. On the web,
`getText()` returns the DOM's concatenated `textContent`, so searching the whole message-list
container holds even when the markdown renderer splits a reply across several nodes. On native
there is no such concatenation — `getText()` on a container returns *that view's own* (empty)
text — so the search has to go to the leaf that actually carries the string, via
`textContains` / an `NSPredicate`. Using the web approach on Android silently finds nothing.
