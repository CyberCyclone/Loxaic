# apps/e2e

WebdriverIO end-to-end suites for web, Electron, iOS and Android, plus the mocks they stand up. README.md is the setup guide; this file is the rules a spec or helper must follow.

## Before you call a spec done

- Run it on every lane it targets, with `E2E_PORT=4055` on every lane (4000 is the dev server; the wrong port reads as "no admin credentials" on most specs).
- Set `E2E_FRESH_WEB=1` after any `apps/mobile` change: `ensureWebExport()` reuses a stale `apps/mobile/dist` (symptom: testID absent while the screenshot looks right).
- Prove it fails: run it once with the fix reverted and see it go red. A test that passes either way is not coverage.
- Assert what an element says, not only that it is visible: give the text its own testID and use `waitForFreshText`.
- Any lane you could not run goes in the PR as "Not verified", with why.
- Never run two suites at once (an e2e lane, server vitest, `pnpm dev` edits): they share the dev Postgres and Docker, and one kills the other's sandboxes.
- Don't edit a watched `apps/server/src` file during a run; `tsx watch` restarts and `stopStrayRunning` pauses the run's sandboxes.

## Selectors and helpers

- Never hand-roll selectors in specs; use `src/helpers/` (`selectors.ts` owns the per-platform mapping, `app.ts` the app-level steps).
- Mapping: web/Electron `[data-testid]`; Android unprefixed `resource-id` via `UiSelector().resourceId(...)` (Appium's `id` strategy prefixes the package and never matches); iOS `~id`.
- Select by testID, never by CSS class, text position or list index (the message list is inverted and virtualised).
- A native lookup of a `Pressable` has no text: assert on a label `Text` with its own testID (e.g. `localModels.runtime.revert.label`) and tap the button.
- When the node under a testID is replaced (download status → finished pill, a panel reopening), use `waitForFreshText`; `waitForTextIn` holds one reference. Under a sheet on native, `waitForTextIn` finds the card behind it; use `waitForFreshText`.
- Wait for a dismissed sheet's or closed modal's contents with `waitForAbsent` (re-queries), never `waitForGone`: UiAutomator2 keeps reporting a closed window's element as displayed.
- Use `sendInNewRun` to find a new conversation (the one absent before the send), never "the newest run".
- Size windows with `helpers/window.ts`, never `browser.setWindowSize`. Phone-width web cases use `browser.setViewport` (Chrome won't go below 500 px).
- A spec must pass alone and in any order: run `provisionAdmin()` in its own `before` if it uses the admin API.
- On a phone (iOS and Android) the thread list is a slide-over covering the menu button: close it (open a row) before a case needs the sidebar.

## Assertions that actually prove something

- **Assert reachability, not visibility, for anything in a modal or long panel**: find an ancestor with computed `overflow-y` auto/scroll and `scrollHeight > clientHeight`, then check the bounding rect. `isDisplayed()` is true below the fold, and `scrollTop` moves on `overflow: hidden`. Step the window down until it really overflows.
- Assert an MCP switch's effect against the stored breakdown (`lastToolSourceKeys`), never only the switch.
- Parse elapsed labels (`elapsedSeconds`) and compare with the stored start; never assert "contains an s".
- A reconnect-flash check uses a `MutationObserver` and slows the socket `open`; localhost reconnects take milliseconds, so polling passes with the bug.
- A real-model spec checks its pass bar once after `waitForRunDone`, never by polling a command until it passes (races the model's next step).
- Only a cold start proves a snapshot carries a pending approval; lock and switch-away cases keep it in React state.
- Never use `scrollIntoView` to prove a list scrolls: it puts the target on screen whatever the list does.

## Reaching the real thing

- Drive the real OS event: native lifecycle specs freeze the run's server with `helpers/server.ts` (`pauseServer`, SIGSTOP); Electron sleep/wake emits real `powerMonitor` events in the main process.
- Minimising an Electron window cannot be tested on macOS; the lane runs `--disable-backgrounding-occluded-windows`, so no spec may depend on minimising.
- No spec may reach real GitHub: `scripts/mock-github.ts` stands in via `GITHUB_API_URL`, and `scripts/git-server.ts` serves fixture repos as `e2e/<name>` via `GITHUB_WEB_URL`. It refuses requests without the token, so a working clone proves the proxy.
- Seed a sandbox by cloning a fixture repo through the GitHub-workspace path (`mock-github.ts` catalog + `git-server.ts` fixture map), never a server-wide seed hook.

## Stand-up and settings

- `standup.ts` never reuses a running server; `E2E_NO_STANDUP=1` is the deliberate way to target an existing one (and `pauseServer` refuses it).
- Never env-pin `SANDBOX_ALLOW_NETWORK` in `standup.ts`: it 409s every spec's `patchSandboxSettings`/`resetSandboxSettings`. Toggle `allowNetwork` through the admin API in `before` and reset in `after`. The same goes for `SANDBOX_CUSTOM_IMAGES` (`resetSandboxSettings` turns it off).
- The custom-image specs pull from `scripts/mock-registry.ts`: a real `registry:2` on a fixed loopback port (Docker Desktop's engine cannot reach an ephemeral one), Docker only. Push over the Engine API with the login in its header; never run `docker login`, which leaves a credential every later pull can fall back on.
- Scenario-driven specs (`agent-bugfix`, `agent-new-project`) run in auto mode.
- Specs that sign in for admin calls go through `adminApi` (it caches the token); per-call sign-ins hit better-auth's rate limit. Cleanup runs first and throws rather than logging.
- `E2E_SELF_CONTAINED=1` runs only a subset: admin and GitHub specs fail by construction. Compare with default mode before concluding anything.
- Screenshots (`shot('name')`) go to gitignored `artifacts/`; capture the state that would look wrong if it regressed. Never commit them.
- Wait prefs have a 5 s floor: shorten waits with `APPROVAL_TIMEOUT_MS`, never a pref.

## Mock triggers (keep these working)

- The mock's 4K window is real to the room check; a prompt over ~4K must run on a large host model (as `attachment-budget.spec.ts` does at 512K).
- Anything a spec must see while running needs a slow prompt ("take your time"): an instant mock reply is over before a lookup lands, and the server rightly reports it idle.
- A routine created through the API needs a `model`, or its run fails at once. A send goes into the open thread: call `startNewThread` first when the case expects a new conversation.
- The mock's generic bash trigger must write (`touch .mock-bash && …`); `echo` alone is read-only and never asks.
- Sub-agent trigger is "sub-agent"/"delegate"; text after the first colon is the child's task. Keep child tasks clear of every scenario `match` regex (matched against the child prompt too). Read a card's call id from `listSubAgents`.
- The slow-child scenario (`survey in passes`) stays seven requests long so native lanes can open the panel in time.
- Fake router / mock: chat events log `cache_n`, and `slot-save`/`slot-restore` name the conversation in `file`; "fill the context" 80%, "overflow the context" 90% of the loaded window; "take your time N" holds a reply N ms per word; `LOXAIC_FAKE_LOAD_MS` slows loads; "overflow the provider" refuses llama.cpp- or OpenAI-style; "give a different answer" numbers replies; "thinking level" echoes the received fields (mock provider records `thinkingFields`).
- HTTP MCP mock (`mock-mcp-http-server.ts`) is added by a spec as slug `httpmock`; "http mcp who am i" calls `get_me`; it refuses every bearer but `MOCK_MCP_HTTP_TOKEN`.
- Mock HF: `POST /__e2e/unreachable?repo=…&on=1` makes a repo's file list answer 503. Show both machines by rewriting the `LOXAIC_FAKE_HARDWARE` file and pressing Restart.
- Never special-case a fixed text (e.g. `PLAN_REJECTED_MESSAGE`) in a mock; react to its words, so the wording is what the test checks.

## Android traps

- Beside a spinner or a ticking counter (running cards, badges, sub-agents) set `waitForIdleTimeout: 0` and restore it after; UiAutomator2 otherwise waits ~11 s per query. Probe `getPageSource()` before concluding an element is missing.
- Emulator stuck on sign-in with `MissingWebViewPackageException` in logcat: `adb reboot`.

## iOS traps

- A keyboard left up hides modal footers from XCUITest: call `closeKeyboard()` before tapping. WebDriverAgent's `hideKeyboard` can't close it; press Return in a single-line field. After a send, tap the message list; with an approval bar up, reach panels via the ⋮ list.
- `scrollTo` (selectors.ts) drags the middle of the screen; don't use `mobile: scroll` predicates or UiScrollable inside modals. On the phone admin screen pass `across` 0.75 to drag the detail pane, and assert via `admin.transcript.newest`.
- XCUITest exposes neither a sheet's backdrop nor a container's testID: close overlays with a positional tap near the top, anchor on pressables and switches, and give card text its own `Text` testIDs.

## Electron

- The dev launch is covered only by `test:electron-dev` (`wdio.electron-dev.ts`, `specs/electron-dev/`, `scripts/dev-stand-ins.ts`); every other Electron spec drives the packaged build.
- Pass chromedriver `--app=<dir>`, never a bare path. Launch the dev lane from an APFS clone in a temp dir: chromedriver-started Electron can't read a checkout under `~/Documents` ("DevToolsActivePort file doesn't exist").
- Copy any fixture a packaged app executes (e.g. `fixtures/fake-tsnet.sh`) to a temp dir; macOS TCC blocks `~/Documents` with exit 126.
- Always pass `--loxaic-data-dir`, in every mode, or a run writes into the developer's real Loxaic config. A data dir without a config lands on onboarding; seed one.
- Values every process must agree on (pick dir, app data dir) are env vars minted with `??=` in `scripts/electron-env.ts`; a module-level `mkdtempSync` runs once per process.
- `LOXAIC_TSNET_BIN` and `LOXAIC_DISABLE_UPDATES=1` are set on every Electron run; never remove them (real control plane, real release feed).
