# @loxaic/e2e

End-to-end suites driven by [WebdriverIO](https://webdriver.io/). One shared smoke spec is
written against `testID`s and runs unchanged on every platform; the per-platform difference is
confined to a selector mapping and a wdio config.

> **Status:** **web**, **Electron**, **Android** and **iOS** all run the same smoke spec
> unchanged and pass, each against a real build.

## Quick start (web)

From a fresh checkout, this is the whole thing:

```bash
pnpm install
pnpm --filter @loxaic/e2e test:web
```

Everything else is automatic: the runner stands the stack up before the session and tears the
server down after. First run is slow (a couple of minutes) because it builds the Expo web
export; later runs reuse it.

**Prerequisites:** Docker (for Postgres), Node >= 22, and Google Chrome. WebdriverIO manages
its own matching chromedriver — nothing to install by hand.

To watch it happen in a real browser window instead of headless:

```bash
E2E_HEADED=1 pnpm --filter @loxaic/e2e test:web
```

## Electron

Needs an unpacked desktop build first, then runs like any other suite:

```bash
pnpm --filter @loxaic/desktop package:dir     # builds the web export + packages the app
pnpm --filter @loxaic/e2e test:electron
```

Re-run `package:dir` whenever `apps/desktop` or the app itself changes — the suite drives the
built binary, not your working tree.

It runs against the **packaged** app rather than `pnpm dev` on purpose. Electron is the one
target that can't assume same-origin: the window loads from `app://`, where no server exists, so
the renderer only learns where the API is through the main process's `window.loxaic.apiBaseUrl`
bridge. The dev shell loads Metro over http instead and never exercises that path.
`src/specs/electron/endpoint.spec.ts` covers the bridge specifically.

Chromedriver is matched to the Electron version automatically, read from the version
`apps/desktop` actually has installed — so the two can't drift apart.

### Self-contained mode

```bash
E2E_SELF_CONTAINED=1 pnpm --filter @loxaic/e2e test:electron
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
pnpm --filter @loxaic/e2e setup:appium
```

### Android

```bash
pnpm --filter @loxaic/mobile prebuild:android
cd apps/mobile/android && ./gradlew assembleRelease
pnpm --filter @loxaic/e2e test:android
```

Needs the Android SDK (`ANDROID_HOME`, or Android Studio's default location) and a running
emulator or connected device. `expo prebuild` regenerates `android/gradle.properties` with
`org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m`, which is not enough for a clean
SDK 57 / React Native 0.86 release build — KSP and lint die with `Metaspace` — so pass a
bigger daemon on the command line (or set the same in `~/.gradle/gradle.properties`, which
survives prebuilds):

```bash
./gradlew assembleRelease -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g"
```

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
E2E_PORT=4055 pnpm --filter @loxaic/e2e test:android
```

Gradle caches the JS bundle, so changing that variable alone will not rebuild it — pass
`--rerun-tasks` (or delete `app/build/generated/assets`) when you change the URL.

Release builds block cleartext HTTP, which every self-hosted/LAN endpoint here relies on, so
`app.json` enables `usesCleartextTraffic` through `expo-build-properties`.

**A photo is seeded into the emulator's library before each run** (`onPrepare`), for
`attachments.spec.ts`'s system-picker step — `adb push` plus a `MEDIA_SCANNER_SCAN_FILE`
broadcast, since the picker reads MediaStore, not the filesystem, and a pushed file is invisible
until the media scanner indexes it. See `seedAndroidPhoto` in `scripts/native.ts`.

### iOS

```bash
pnpm --filter @loxaic/mobile prebuild:ios
cd apps/mobile/ios && pod install
xcodebuild -workspace loxaic.xcworkspace -scheme loxaic \
  -configuration Release -sdk iphonesimulator -derivedDataPath build \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
pnpm --filter @loxaic/e2e test:ios
```

Do **not** pass `CODE_SIGNING_ALLOWED=NO`. Simulator builds need no team or certificate —
Xcode ad-hoc signs them — but disabling signing entirely also strips the app's
*entitlements*, and the Keychain (expo-secure-store, where the session token lives) fails
every call without the application-identifier entitlement. The failure mode is nasty: the
app launches and sits on a blank white screen with no visible error, because the rejection
happens during session bootstrap before anything renders. Match `-destination` to a
simulator that exists for your Xcode's iOS runtime (`xcrun simctl list devices available`).

Point `E2E_IOS_DEVICE` at a simulator name (default `iPhone 17`) and `E2E_IOS_APP` at a `.app`
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
E2E_PORT=4055 pnpm --filter @loxaic/e2e test:ios
```

Two harness behaviours specific to iOS, both handled automatically:

- **The simulator keychain is reset before each run** (`onPrepare`). Unlike Android — where
  uninstalling the app wipes its storage — the iOS keychain survives reinstalls, so a previous
  run's session token would auto-sign the app in and break the sign-up spec on every re-run.
- **System alerts are auto-dismissed** (`appium:autoDismissAlerts`): iOS interrupts the first
  sign-in with a "Save Password?" sheet that sits above the app and blocks every element query.
- **A photo is seeded into the simulator's library before each run**, for `attachments.spec.ts`'s
  PHPicker step — `xcrun simctl addmedia`, the supported way in (it imports through Photos
  itself, so a plain file copy would never appear in the picker). See `seedIosPhoto` in
  `scripts/native.ts`, including what to do if that command hangs.

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

## What the attachments spec covers

`src/specs/attachments.spec.ts` — pick an image → upload → send → thumbnail in the bubble →
fullscreen viewer → and the two negative cases the server-side guards exist for (an image-only
message with no text, and one user's ref being unreachable to another).

The load-bearing assertion is `[Mock] Received 1 image(s).`: the mock provider only emits that
when the assembled prompt actually carried `image_url` parts, so it proves the whole chain —
multipart upload, ownership check, `attachment` content blocks, the history loader, OpenAI content
parts — rather than merely that a thumbnail rendered locally.

**Getting an image into the composer is the one platform-shaped step**, and it lives entirely in
`helpers/attachments.ts`:

| Platform | How |
|---|---|
| web, Electron | `browser.uploadFile()` + `addValue` on the composer's real `<input type="file">` (`composer.attach.input`). `addValue`, not `setValue` — the latter clears first, and `clearValue` on a file input throws. |
| iOS | Taps through to PHPicker and selects the first cell, seeded by `simctl addmedia` in `onPrepare`. |
| Android | Taps through to the system photo picker and selects the first cell, seeded by `adb push` + a `MEDIA_SCANNER_SCAN_FILE` broadcast in `onPrepare`. |

The two native branches select **system UI we don't own** (Apple's and Google's pickers), so they
match on OS accessibility traits rather than `testID`s. That is a deliberate exception to the rule
in AGENTS.md, in the same category as `appium:autoDismissAlerts` — and it is confined to that one
helper so a picker redesign breaks one function, not every spec.

The fixture is `fixtures/images/red-square.png` (64×64 solid crimson, 136 bytes) — deliberately a
colour nothing in the app's own chrome uses, so a thumbnail of it is unmistakable in a screenshot.

The **camera** path is deliberately not covered: the iOS simulator has no camera to drive. It
carries a `testID` (`composer.attach.camera`) and is verified by hand.

> **If `seedIosPhoto` fails with "addmedia hung"**, that simulator's Photos daemon is wedged —
> `xcrun simctl shutdown <udid>` (or erasing the simulator) clears it. The helper bounds the call
> at 60s rather than letting `onPrepare` hang indefinitely.

## What stand-up actually does

`scripts/standup.ts`, run automatically from the wdio `onPrepare` hook:

1. **Postgres** — reused if something already answers on the `DATABASE_URL` host/port,
   otherwise `docker compose up -d db` and wait for it.
2. **Migrations** — `pnpm --filter @loxaic/db db:migrate`, run explicitly rather than relying
   on the server's boot-time migration (that one is cwd-sensitive and only logs on failure).
3. **Web export** — built if `apps/mobile/dist/index.html` is missing. Must happen *before* the
   server starts: static serving is only registered at boot, and only if the export exists.
4. **Server** — started with `MOCK_INFERENCE=true` (or `INFERENCE_BASE_URL` under
   `E2E_REAL_MODEL=1`). **Never reused**, even if something is already healthy at `E2E_BASE_URL`:
   a health check can't confirm that server was wired with *this* run's `GITHUB_API_URL`,
   `MOCK_SCENARIOS_FILE`, or sandbox network settings, so stand-up always starts its own —
   `E2E_NO_STANDUP=1` is the documented way to point a run at a server on purpose. Attachment
   uploads are pointed at `artifacts/.run/uploads` (`UPLOADS_DIR`) rather than `apps/server`'s
   default `./uploads`, so a run never leaves image files in the working tree; `teardown()`
   removes it alongside the sandbox root.
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
`e2e-admin@loxaic.test` (see `helpers/auth.ts`'s `provisionAdmin()`), rather than a per-run unique
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

## What the GitHub connection spec covers

`github-settings.spec.ts` drives connecting/disconnecting a GitHub personal access token
against `apps/e2e/scripts/mock-github.ts` — a minimal in-process HTTP server standing in for
`api.github.com`, started by `standup.ts` before the test server and passed to it as
`GITHUB_API_URL` (the same env var `apps/server/src/github/client.ts` reads at call time; see
AGENTS.md's "GitHub connection" section). No spec ever reaches real GitHub. The mock accepts
exactly one token (`VALID_TOKEN`, exported from `mock-github.ts`); anything else 401s, so the
"bad token" case exercises the server's real validation path rather than a canned rejection.

## What the GitHub-workspace and mock-scenario specs cover

`agent-github-workspace.spec.ts` and `agent-git-actions.spec.ts` clone a real repository through
the server's ordinary workspace path with nothing stubbed server-side: `scripts/git-server.ts`
turns each fixture directory under `fixtures/` (`bugfix-app`, `other-repo`, `seeded-app`) into a
bare repo with one commit on `main`, served over `git://` by `git daemon --enable=receive-pack`,
and `scripts/mock-github.ts` hands out that URL as the repo's `clone_url`. A sandbox reaches the
harness machine as `host.docker.internal` — Docker Desktop resolves that on its own; Linux and
Podman need the `SANDBOX_EXTRA_HOSTS=host.docker.internal:host-gateway` entry `standup.ts` passes
to the server it spawns, mapped to `HostConfig.ExtraHosts`. Cloning needs sandbox network access,
which is off by default: a spec that clones turns `allowNetwork` on through the admin API in
`before` and resets it in `after`, the same discipline every sandbox-mode spec follows — this is
deliberately *not* a global `standup.ts` setting, since pinning it would 409 every spec's own
`patchSandboxSettings`/`resetSandboxSettings` calls (an env-pinned setting is read-only) and would
break the specs that specifically test the network-off and degraded states.

`agent-bugfix.spec.ts` and `agent-new-project.spec.ts` drive a realistic multi-step coding task
end to end under `MOCK_INFERENCE` — clone (or start from scratch), run the real tests, fix a real
bug, rerun them, commit, push, open a PR — using the **mock scenario engine**
(`apps/server/src/inference/mock-scenarios.ts`) rather than the single-tool-call
`MOCK_TOOL_TRIGGERS` every other mock-driven spec uses. `MOCK_SCENARIOS_FILE`
(`fixtures/scenarios.json`, passed by `standup.ts` unconditionally — it's inert under
`E2E_REAL_MODEL=1`) is a JSON array of `{match, steps: [{tool, args}], finalText}` scenarios: the
prompt is matched against `match` (a case-insensitive regex source), and one step fires per tool
message already in the current turn — bypassing `MOCK_TOOL_TRIGGERS`'s one-call-per-turn rule,
which is the entire reason a scenario exists, since a scenario is defined by needing more than
one real tool call in a turn. A step only fires when its tool is actually offered, matching the
ordinary trigger rule; once every step has run, `finalText` replaces the generic
"`[Mock] Done. The tool returned: …`" wrap-up. Every tool call is executed for real against the
sandbox — the JSON only scripts *which* tool runs with *which* arguments, not the result.

## Real-model task suite

Everything above runs on `MOCK_INFERENCE`, which is exactly why it can't prove an agent can
actually get real work done — even the scenario-driven specs above script which tools run, not
whether the model would have chosen them. This suite is different: a real OpenAI-compatible
endpoint drives the agent through a genuine multi-step coding task with no scripted tool sequence
standing in for any of it.

```bash
E2E_REAL_MODEL=1 E2E_INFERENCE_URL=http://localhost:1234 pnpm --filter @loxaic/e2e test:web:real-model
```

`E2E_INFERENCE_URL` points at any OpenAI-compatible endpoint — LM Studio, `llama.cpp` started
with `--jinja` (see `docs/RUNTIME.md`), OpenRouter, etc. — the same thing `INFERENCE_BASE_URL`
means everywhere else in this repo. Pick a model with real tool-calling support; a small local
"coder" model (e.g. `qwen2.5-coder-7b-instruct`) is enough for the task described below.

**Never part of `pnpm test`, and never run in CI.** It needs a real (often local, often
GPU-bound) inference endpoint CI doesn't have, takes minutes rather than seconds, and a local
model's output isn't deterministic the way the mock's is — it's a manual, on-demand suite you run
before a release or when touching the tool loop, not a check that gates every push.

### The three tasks

- **`real-model-build.spec.ts`** clones `fixtures/seeded-app/` — a minimal Vite + React +
  TypeScript app — through the same GitHub-workspace path the mock lane's specs use (repo id 3 in
  `mock-github.ts`'s catalog). `INSTRUCTIONS.md` tells the agent to `npm install`, then fix
  `src/App.tsx` — seeded in a state that **doesn't compile** (it references a `count`/`setCount`
  that were never declared) — and get `npm run build` passing. That's deliberate: a stub that
  already builds would make "the build passed" prove nothing about whether the agent did
  anything. Cloning replaced an earlier `E2E_SANDBOX_SEED_DIR` hook that pre-populated *every*
  sandbox any user created for the life of the server — a repo the spec chooses per-conversation
  is the same mechanism the mock lane already proves out, and it means this suite no longer needs
  a server-wide flag nobody else may set.
- **`real-model-bugfix.spec.ts`** clones `fixtures/bugfix-app/` (repo id 1 — the same fixture and
  git server the mock lane's `agent-bugfix.spec.ts` drives with a scripted scenario) and gives the
  model a plain natural-language instruction: find the failing test, fix the real off-by-one,
  confirm `node --test` passes, and commit. No scenario file is involved — the model decides which
  tools to call.
- **`real-model-new-project.spec.ts`** starts from an empty scratch workspace with a
  natural-language instruction to build a small Node project (a `package.json` with a `test`
  script, a source file, a test file) and get its own tests passing. The prompt pins the test
  command so the pass bar is checkable; file names and content are the model's own decision.

All three run the agent in **auto** mode (no per-tool approval prompt — see
`toolRequiresApproval()` in `packages/agent`, required for an autonomous multi-step task to finish
unattended). The two GitHub-workspace tasks get the network access (`SANDBOX_ALLOW_NETWORK=1`, set
automatically by `standup.ts` under `E2E_REAL_MODEL=1`) that cloning and `npm install` need and
sandboxes don't have by default.

### What "pass" means

Every check happens **after** `waitForRunDone` — the agent's *entire* turn finishing, not the
moment a polled command happens to exit 0. Polling the target command directly and returning as
soon as it passed was tried first for the bugfix task and is a genuine race: the model's last two
steps are "see tests pass" then "commit", and an external poller reading the same sandbox can
observe the passing tests after the model's own test run but before its commit — catching the
model one step short of what it was asked to do isn't a finding about the model, it's a bug in the
harness. Once the run has finished, each spec resolves the sandbox it actually used
(`GET /v1/sandboxes`) and runs its pass/fail command (`npm run build`, `node --test`, `npm test`)
**through the same sandbox exec API a client would use** — not by trusting the model's account of
what it did, and not by scraping its wording for a specific phrase the way the mock-driven specs
can (a real model's phrasing isn't deterministic). A non-zero exit fails the test with the
command's real stdout/stderr, so a failure says what actually went wrong rather than just
"timed out". The bugfix spec additionally checks `git rev-list --count` for a real commit, not
whether the Inspector's Git panel says so.

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
| `E2E_REAL_MODEL` | — | `1` runs the agent against a real inference endpoint instead of the mock — see "Real-model task suite". Requires `E2E_INFERENCE_URL`. |
| `E2E_INFERENCE_URL` | — | The OpenAI-compatible endpoint `E2E_REAL_MODEL=1` talks to (e.g. `http://localhost:1234` for LM Studio). |
| `E2E_HEADED` | — | `1` runs Chrome headed instead of headless. |
| `E2E_LOG_LEVEL` | `warn` | WebdriverIO log level (`trace`…`error`). |
| `E2E_IOS_DEVICE` | `iPhone 17` | Simulator to run the iOS suite on. |
| `E2E_IOS_VERSION` | — | Pin a simulator iOS version (e.g. `18.6`). |
| `E2E_IOS_APP` | — | Path to a built `.app` bundle, if not in the default location. |
| `E2E_ANDROID_AVD` | — | AVD to boot; otherwise uses the running emulator/device. |
| `ANDROID_HOME` | Android Studio's default SDK path | Android SDK location. |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/loxaic` | Test database. |

Stand-up and teardown can also be driven on their own, which is handy when iterating on a spec
and you don't want to pay the start-up cost each time:

```bash
pnpm --filter @loxaic/e2e standup
E2E_NO_STANDUP=1 pnpm --filter @loxaic/e2e test:web
pnpm --filter @loxaic/e2e teardown
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
