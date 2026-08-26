# @shannon/e2e

End-to-end suites driven by [WebdriverIO](https://webdriver.io/). One shared smoke spec is
written against `testID`s and runs unchanged on every platform; the per-platform difference is
confined to a selector mapping and a wdio config.

> **Status:** the **web** suite is implemented and passing. Electron, iOS and Android land in
> the following PRs of this stack, along with the Appium drivers they need — the selector
> helper already speaks all four platforms so the shared spec doesn't have to change when they
> arrive.

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
| `E2E_FRESH_WEB` | — | `1` forces a rebuild of the Expo web export. |
| `E2E_HEADED` | — | `1` runs Chrome headed instead of headless. |
| `E2E_LOG_LEVEL` | `warn` | WebdriverIO log level (`trace`…`error`). |
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
scripts/standup.ts    bring the stack up + readiness gate; also the teardown
src/helpers/
  selectors.ts        testID → per-platform selector; the shared vocabulary
  app.ts              app-level steps (sign in, send a message, …)
  auth.ts             unique per-run test users
  screenshot.ts       named screenshots into artifacts/
src/specs/            the suites
```

## Notes for the platforms still to land

Recorded here so the next PRs don't have to rediscover them:

- **Appium 2, not 3.** Appium 3 changed the driver/CLI surface; the drivers will be installed
  into a repo-local `APPIUM_HOME` (`apps/e2e/.appium/`) so runs are deterministic.
- **iOS** — `expo prebuild` then a Release simulator build (Release embeds the JS bundle, so no
  Metro). testID arrives as `accessibilityIdentifier`, matched by `~id`.
- **Android** — testID arrives as an *unprefixed* `resource-id`, so the raw
  `UiSelector().resourceId(...)` form is used rather than Appium's `id` strategy, which would
  prepend the app package. Release builds also block cleartext HTTP, which the LAN/emulator
  endpoints rely on.
- **Electron** — not same-origin, so it exercises the `window.shannon.apiBaseUrl` bridge; needs
  an unpacked (`electron-builder --dir`) build to drive.
