# AGENTS.md

**This file is the source of truth** for architecture, conventions, and gotchas.
([`HANDOVER.md`](HANDOVER.md) is a legacy document kept for historical context only.)

## Project in one line

Self-hosted, multi-user AI platform — a Claude + Claude Code replacement: llama.cpp
inference, a real agent tool-calling loop with sandboxed execution, one universal Expo
frontend (iOS/Android/Web/Electron), reachable remotely over Tailscale (or your own
reverse proxy).

## Layout

- `apps/server` — Fastify API + WS (chat + agent tool loop) + routines scheduler + agent sandbox providers (`src/sandbox/`)
- `apps/mobile` — the one frontend (Expo + expo-router + gluestack-ui v5), targets iOS/Android/Web
- `apps/desktop` — the deployment artifact: an Electron GUI, a `--headless` entry (`src/headless.js`), and a
  service supervisor (`src/supervisor/`) that brings up an embedded Postgres + the bundled server so the app
  is self-contained with no Docker/Postgres install required; also embeds a Tailscale sidecar
- `packages/agent` — tool definitions, permission-mode logic (shared by server + client); the wire event
  union (`StreamEventKind`) lives in `packages/types` instead
- `packages/api-client` — typed REST + WS client used by `apps/mobile`
- `packages/db` — Drizzle schema + re-exported query operators
- `packages/sync` — fork/conflict detection for the offline sync protocol
- `packages/types` — shared primitive types (`ContentBlock`, `Result`, etc.)
- `packages/config-ts` — shared tsconfig bases
- `infra/` — Dockerfiles, the `tsnet-proxy` Go module (Electron's embedded Tailscale sidecar), Tailscale Serve config
- `design/` — the original static HTML/CSS prototype; historical reference only, not built or imported by anything

There is no separate web app and no separate UI package — `apps/mobile`'s Expo web
export **is** the web app, served same-origin by `apps/server` (see HANDOVER.md).

## Commands

```bash
pnpm install
pnpm dev                          # turbo: server (4000) — mobile/web/desktop have their own dev scripts, see HANDOVER.md
docker compose up --build         # db + server (serves API + web same-origin) + inference + ntfy
pnpm --filter @loxaic/mobile web # Expo web dev server (localhost:8081)
pnpm --filter @loxaic/mobile ios # or android

pnpm --filter @loxaic/desktop dev         # self-contained desktop app, dev mode (embedded stack, Metro web build)
pnpm --filter @loxaic/desktop package     # prod build: mac dmg, linux AppImage + deb, windows nsis (untested)
pnpm --filter @loxaic/desktop package:dir # prod, unpacked — faster iteration, what the e2e suite drives

pnpm test        # turbo test — vitest (only apps/server + apps/desktop have tests today)
pnpm lint        # turbo lint — eslint (apps/server)
pnpm typecheck   # turbo typecheck — tsc --noEmit across all packages
```

Tests are Vitest, colocated under `__tests__/` dirs. Run one package or one test:

```bash
pnpm --filter @loxaic/server test               # all server tests
pnpm --filter @loxaic/server test -- authz      # tests matching "authz"
pnpm --filter @loxaic/server test -- src/streams/__tests__/drivers.test.ts
```

End-to-end suites are WebdriverIO, in `apps/e2e`, and run on demand (never as part of
`pnpm test`). They stand the whole stack up themselves:

```bash
pnpm --filter @loxaic/e2e test:web        # see apps/e2e/README.md for setup + env vars
E2E_SELF_CONTAINED=1 pnpm --filter @loxaic/e2e test:electron  # against the packaged app's own embedded stack
```

## End-to-end tests

**Every feature PR adds or updates e2e coverage for the behaviour it changes**, and carries
screenshots showing that behaviour working. Writing those tests is the implementer's job
(human or AI) — the harness already exists, so this is normally a spec file and a few
`testID`s, not new infrastructure.

- **Tests** live in `apps/e2e/src/specs/`. Select by `testID` using the helpers in
  `src/helpers/` — never by CSS class, text position, or list index (the message list is
  inverted and virtualised, so position is not stable). New interactive elements need a
  `testID` following the convention in Gotchas above.
- **Screenshots** are captured with `shot('name')` at the moments that actually evidence the
  feature — the state that would look wrong if it regressed, not just the happy end state.
  Failures are captured automatically.
- **Screenshots are never committed.** `apps/e2e/artifacts/` is gitignored; embed the PNGs in
  the PR description instead, straight from that directory.
- If a change genuinely isn't user-visible, say so in the PR rather than skipping the section.

## Gotchas

### TypeScript + React Native

- **JSX files must use `.tsx`** — TypeScript ignores JSX in `.ts` files.
- **Relative imports in packages with no build step** (`packages/db`, `packages/agent`,
  `packages/sync`) **must include the `.ts` extension** (`from "./schema.ts"`, not
  `from "./schema"`). These packages ship raw TS — `apps/server`'s bundler (tsup) leaves
  them external, so they run under Node's native TypeScript support in production, which
  follows real ESM resolution rules (dev's `tsx` loader is more forgiving and won't catch
  a missing extension).
- **`expo-image-picker` is native-only.** Its web implementation creates a transient hidden
  `<input type="file">` at click time and clicks it programmatically — no stable element to
  attach a `testID` to, and nothing for e2e to drive. The composer's attach control is split
  per-platform instead (`components/composer/AttachButton.tsx` / `.web.tsx`, same convention as
  `ImageViewer.tsx` / `.web.tsx`): native keeps the camera/library actionsheet over
  `expo-image-picker`, web renders a real, persistent `<input type="file">`
  (`composer.attach.input`) that `apps/e2e/src/helpers/attachments.ts` drives directly.
- **Expo SDK 57 / New Architecture only.** `newArchEnabled` is no longer a valid `app.json`
  key (SDK 55 removed the legacy architecture), `expo prebuild` now wipes `ios/`/`android/`
  before regenerating (pass `--no-clean` to keep them), and `runtimeVersion.policy:
  "sdkVersion"` means each SDK bump starts a fresh EAS Update runtime — clients on the old
  build simply stop receiving updates. Upgrade with `npx expo install expo@^NN --fix` run
  *inside* `apps/mobile`, then `npx expo install --check` and `npx expo-doctor@latest`.
- **TypeScript is deliberately held at 5.9** via `expo.install.exclude` in
  `apps/mobile/package.json`: every other workspace package is `^5.7` and the shared eslint
  config's TS 6 support is unverified. Bump it workspace-wide in its own PR, not as a side
  effect of an SDK upgrade.
- **Never add a dependency with a required `nativewind` peer.** UniWind is the styling engine
  and `nativewind` is not installed; pnpm satisfies such a peer by materialising a second
  `react`/`react-native` island, and any hook reached through it binds to the wrong React
  ("Invalid hook call" / "Cannot read property 'useState' of null" on device). `@legendapp/
  motion` did exactly this and forced a React-singleton `resolveRequest` shim in
  `metro.config.js`; both are gone. Overlays animate with react-native-reanimated
  `entering`/`exiting` layout animations instead (`components/ui/modal`, `menu`, `popover`,
  and `actionsheet/animated.tsx`, which is also what `select/select-actionsheet.tsx` uses).
  If a second React ever reappears, `ls node_modules/.pnpm | grep '^react@'` finds it — fix
  the dependency, don't re-add the shim.
- **`babel-preset-expo` must stay a declared devDependency** even though `expo` depends on
  it: under pnpm it is only hoisted to `node_modules/.pnpm/node_modules`, which Babel can't
  resolve from `apps/mobile`. It injects `react-native-worklets/plugin` itself, so that plugin
  is intentionally absent from `babel.config.js` — listing it twice breaks reanimated.
- **`expo/fetch` is `globalThis.fetch` on native since SDK 56, and its FormData encoder only
  accepts a string, a `Blob`, or an object with `bytes()`.** React Native's classic
  `{uri, name, type}` upload part is *not* one of them — it fails client-side with
  "Unsupported FormDataPart implementation" before any request is made (this shipped briefly
  during the SDK 57 upgrade; the iOS attachments spec caught it). Native uploads therefore go
  through `nativeAttachmentFile` in `apps/mobile/lib/attachmentUpload.ts`, which returns a
  `{name, type, bytes()}` part: `file://` URIs are read via `fetch(uri)` (expo/fetch supports
  the file scheme on both platforms), `data:` URIs are decoded in JS. Do **not** reach for
  `EXPO_PUBLIC_USE_RN_FETCH=1` to paper over this — it is inlined at bundle time, so it would
  have to be set in every build shell forever, and it silently changes fetch semantics for the
  whole app.
- **`SettingsModal`'s `ModalContent` is height-bounded (`max-h-[85%]`) and its `ModalBody` has
  `scrollEnabled` on**, because the vendored `ModalBody` (`components/ui/modal/index.tsx`)
  hardcodes `scrollEnabled={false}` and the modal has no max-height by default — content past
  the fold simply extends past the viewport edge with nothing to scroll it into view. Adding
  one more settings row (GitHub, alongside MCP/Sandbox) pushed the Sandbox row off-screen and
  broke three e2e specs that clicked it, none of which had ever exercised the modal's actual
  height. `McpServerModal.tsx` already carries the `max-h-[85%]` half of this fix; `scrollEnabled`
  is a caller override on `<ModalBody>` (the creator spreads `{...props}` after its own
  hardcoded default, so passing the prop wins) — **any modal expected to grow past a handful of
  rows needs both**, not just the height cap.

### testIDs and e2e selectors

- **Naming scheme:** dot-separated `area.element[.qualifier]`, lowerCamel per segment
  (`login.submit`, `agent.mode.manual`, `sidebar.nav.chat`). `area` is the screen or shared
  component family (`login`, `composer`, `chat`, `agent`, `sidebar`, `shell`); `qualifier`
  is used for items generated from an existing data array (`MODES`, `NAV_ITEMS`) — never an
  invented string.
- **testID goes on the interactive element the user actually touches** (the real
  `InputField`/`TextareaInput`/`Pressable`/`Button`), not a decorative wrapper — except for
  assertion anchors that have no interactive element of their own (a message bubble, an
  error `Text`).
- **Web/Electron selector caveat:** most `apps/mobile/components/ui/**` wrappers spread
  `{...props}` straight through, so `testID` reaches react-native-web's `Button`/
  `Pressable`/`Input`/`Textarea`/native `FlatList`, which map it to the DOM attribute
  `data-testid` automatically. But `box`, `heading`, `hstack`, `vstack`, and `text` have
  `.web.tsx` overrides that render a raw DOM element directly (`<div>`, `<span>`, `<h1>`–
  `<h6>`) — those five have been patched by hand to also emit `data-testid={testID}`, so
  every testID resolves to `[data-testid="…"]` on web regardless of which wrapper it's on.
  **If gluestack is ever re-vendored/regenerated, this patch is lost and must be re-applied**
  to those five `index.web.tsx` files. `icon`'s `.web.tsx` delegates to a third-party
  `PrimitiveIcon`/`Svg` layer instead of rendering DOM directly and is not patched — don't
  put a testID on an `Icon` element; put it on the `Pressable`/`Button` that wraps it.
- **Per-platform mapping:** web/Electron → `[data-testid="…"]`; Android → an **unprefixed**
  `resource-id`, found via UiAutomator2 (`new UiSelector().resourceId("id")`) — note Appium's
  `id` strategy prepends `<appPackage>:id/` and so never matches; iOS → `accessibilityIdentifier`,
  found via XCUITest's `accessibility id` strategy (`~id`). All three mappings are confirmed
  against real builds (see `apps/e2e/README.md`).
- Don't hand-roll these selectors in specs — use the helpers in `apps/e2e/src/helpers/`, which
  own the mapping.

### DB / Drizzle

- **Never import from `drizzle-orm` directly.** `packages/db` re-exports every operator
  (`eq`, `and`, `desc`, etc.) and the `db` instance — import from `@loxaic/db`. Two
  drizzle-orm instances in the dependency tree cause type errors.
- **No `users` table** — the table is `user` (singular), owned by Drizzle like any other
  table (`packages/db/src/schema.ts`), not auto-created by better-auth: it's passed
  explicitly to `drizzleAdapter(db, { schema: { user, session, account, verification } })`
  in `apps/server/src/auth/index.ts`, and its columns (including the admin plugin's `role`/
  `banned`/`banReason`/`banExpires`) go through the normal migration flow. App tables
  reference `user.id`, which is `text`, not `uuid`. The first user to sign up (or any email
  listed in `ADMIN_EMAILS`) gets `role: "admin"` via a `databaseHooks.user.create.before`
  hook — an existing deployment's already-registered user does not retroactively become
  admin; use `ADMIN_EMAILS` or `UPDATE "user" SET role='admin'` to promote one.
- **`banned` is enforced by our own middleware, not by better-auth.** The admin plugin only
  checks it in `session.create.before` (i.e. at sign-in), so a ban applied out of band — the
  `UPDATE "user" SET banned = true` counterpart to the promotion above — would leave every
  live session working. `resolveSession()` in `apps/server/src/auth/middleware.ts` re-checks
  it on every authenticated request (403, expired bans treated as lifted). Route handlers get
  this for free by going through `authenticate`/`requireAdmin`; anything that calls
  `auth.api.getSession` directly does not.
- **Postgres/postgres.js returns `SUM()`/`AVG()` over `integer` columns as strings**
  (bigint/numeric precision preservation). Cast to `::float8` in SQL, not `::int` (avoids a
  32-bit overflow ceiling on lifetime token sums). Columns typed `real` parse natively.
- Migrations auto-run on server startup (`apps/server/src/db/migrate.ts`). Migration folder:
  `packages/db/drizzle/`. Run `pnpm --filter @loxaic/db db:generate` after schema changes.

### Inference

- **Set `MOCK_INFERENCE=true`** for dev without llama.cpp. Mock mode drives the full agent
  tool loop too — it emits a real (fake) tool call when the prompt mentions one, so the
  approval/deny/auto/planning paths are all testable without a GGUF.
- Real inference needs llama.cpp started with `--jinja` (native OpenAI tool calling) at
  `INFERENCE_BASE_URL` (default `http://localhost:4002`). See `docs/RUNTIME.md` for the
  per-platform (Mac/Windows/Linux, Metal/CUDA/ROCm) setup matrix.

### Tool loop (Chat and Agent both)

- **Chat and Agent share one tool loop** — `apps/server/src/streams/runs/engine.ts`'s
  `runToolLoop`, parameterized by surface and base prompt. The two starters
  (`chatRun.ts`, `agentRun.ts`) only differ in conversation setup and which system prompt
  they pass in; `agentRun.ts` additionally exposes planning/manual/auto modes. **Chat has no
  mode selector** — it always runs manual-mode approval semantics (write builtins and
  non-allowlisted MCP tools ask; read-only builtins run free).
- `packages/agent` owns the builtin `TOOLS` plus the `ResolvedTool`/`ToolSource` types; the
  server's per-run `Toolset` (`apps/server/src/mcp/registry.ts`) resolves names, approval
  policy, and dispatch for builtins and MCP tools alike (see "MCP servers" below). The wire
  event union lives in `packages/types` (`StreamEventKind`), not here.
- **"Allow always"**: an MCP tool patches its server's own per-tool policy
  (`PATCH /v1/mcp/servers/:id`, same allowlist the `/mcp` screen manages); a builtin patches
  the user's global allowlist instead — the `user_prefs.tool_allowlist` column, read by
  `buildToolset` (`apps/server/src/mcp/registry.ts`) and exposed via `GET`/`PATCH /v1/prefs`.
  This is global and mode-independent (it clears `requiresApproval`, not the `isWrite` gate),
  so it also silently benefits agent's manual mode — planning mode is unaffected since it
  filters on `isWrite` regardless of approval policy.
- Sandbox execution goes through `apps/server/src/sandbox/provider.ts`'s
  `SandboxHandle`/`SandboxProvider` interface — never a raw `Docker.Container`. Two
  providers: `container-provider.ts` (dockerode; Docker, Podman, OrbStack, Colima — any
  Docker-Engine-API-compatible socket, auto-discovered) and `host-provider.ts` (no
  isolation, agent commands run directly on the host — an explicit `SANDBOX_MODE=host`
  opt-in). Selected via `getSandboxMode()`, resolved at call time — see `docs/RUNTIME.md`.
- **Server-level settings** (`apps/server/src/settings.ts`) back the sandbox mode, engine,
  socket, and network toggle. Precedence is always **env > `server_settings` row >
  default**; an env-pinned field is rejected by the API with a `409` and rendered read-only
  in the GUI. Reads are sync against a cache loaded once at boot (`loadServerSettings()`),
  because `getSandboxMode()` is sync by contract. A failed load **fails closed** (mode
  resolves to `off`), because migrations only warn in non-strict mode and quietly falling
  back to the permissive default would restart execution an admin had disabled. Writes go
  through `PATCH /v1/admin/settings/sandbox`, which is **admin-only** (`requireAdmin`) —
  host mode and sandbox networking are deployment-wide security decisions, not per-user
  preferences, and **nothing may let a caller choose them per request**: `POST /v1/sandboxes`
  once accepted a `provider` field in the body, which let any signed-in user get host
  execution and bypass `mode: "off"` entirely. Derive the kind from `getSandboxMode()`.
- `updateSandboxSettings()` must apply as well as persist, **in this order**: stop the
  affected sandboxes *first*, then `resetEngineCache()`. Stopping a container means
  attaching through the engine that created it, so resetting first sends those calls to the
  new engine, which 404s, marks the row stopped anyway, and orphans a still-running
  container the boot sweep can never find (it only lists the current engine's containers).
  Scope the sweep with `invalidatedKinds()` — a host sandbox's `stop()` **deletes its
  working directory**, so a container-only change must not sweep host sandboxes.
- **Anything that authenticates must go through `apps/server/src/auth/middleware.ts`** —
  `authenticate`/`requireAdmin` for routes, `resolveSessionFromToken` for WebSocket
  handlers. Calling `auth.api.getSession` directly skips the ban re-check and leaves a
  banned user holding live sockets (including a sandbox terminal) until the session expires.
- Sandbox containers are created with **no network** (`NetworkMode: "none"`) unless an admin
  enables `allowNetwork` — everything in them is model-directed, so egress is an
  exfiltration path. Host sandboxes always have the host's network. `web_fetch` is
  unaffected: it always runs server-side behind the SSRF guard, never in the sandbox.
- Sandboxes are per-conversation, lazily created on first tool use, and **survive socket
  close** (reconnecting mid-task keeps the working directory) — see
  `apps/server/src/agent/sandbox-manager.ts`.
  A sandbox row (`sandboxes` table) records which provider it belongs to; a mode switch
  mid-deployment makes old rows unusable rather than silently reattaching to the wrong kind.
  A crash between `provider.create` and the row insert leaves a container no row claims, so
  it is only findable by its `loxaic.sandbox` label; `sweepOrphanSandboxes()` does that
  sweep at boot (container provider only — host sandboxes are plain directories), alongside
  the stream log's own orphan recovery.

### Sandbox lifecycle: stopping is a pause, destroying is the exception

- **`stop()` keeps everything; only `destroy()` discards.** A sandbox is a coding session's
  actual work — edits, a repo checkout, installed dependencies — so an idle timer must never
  delete one. Both providers implement four verbs: `isRunning()`, `exists()` (**true for a
  stopped sandbox** — the distinction `isRunning` cannot make), `start()` (resume; throws when
  there is nothing left, which is how "paused" is told from "gone"), `stop()`, `destroy()`.
  This replaced a 30-minute reaper that deleted: going to lunch cost you your workspace, and
  the model came back with no idea why the files were gone.
- **Exactly two things destroy a sandbox**: deleting the conversation
  (`destroyConversationSandboxes`, fired from `DELETE /v1/conversations/:id`) and
  `reapAbandonedSandboxes` (off by default after `reapAfterMs`, default 30 days). Everything
  else — the idle timer, a settings change, a boot sweep — stops. `POST /v1/sandboxes/:id`'s
  DELETE also destroys, being a person saying so.
- **The three retention settings are admin-level and live with the other sandbox settings**
  (`idleStopMs` 4h, `reapEnabled` true, `reapAfterMs` 30d; env pins `SANDBOX_IDLE_STOP_MS`,
  `SANDBOX_REAP_ENABLED`, `SANDBOX_REAP_AFTER_MS`, in **milliseconds** so a harness can ask for
  an immediate stop). `reapAfterMs` must exceed `idleStopMs` or the two timers race over the
  same sandbox. Deletion is separately switchable because it is the only timer that can lose
  someone's work.
- **`reap_at` is derived on read, never stored** (`sandboxReapAt()`), so it always reflects the
  policy the reaper will actually apply. A stored date is a promise the settings screen can
  silently break: an admin moving 30 days to 7 would leave every row advertising the old one.
- **`last_used_at` is flushed on a tick, not written per tool call.** A database write per
  `bash` would be absurd, so a live sandbox's row can lag by one reaper interval — which is why
  `reapAbandonedSandboxes` also skips anything in the in-memory `active` map, and why the tick
  runs flush → idle-stop → abandoned-reap in that order.
- **Rows still marked `running` are reap-eligible.** After a crash or a host reboot nothing
  else would ever move them, so excluding them would make a sandbox permanently unreclaimable
  precisely because the server died while it was in use.
- **Containers now outlive the server** (`AutoRemove: false`), so the boot sweep gained a third
  direction: pause containers a previous process left running, which no idle timer in the new
  process would ever see.
- **`Init: true` is load-bearing, not hygiene.** `tail -f` as PID 1 gets no default signal
  handlers and ignores SIGTERM, so every `stop()` waited out the full 10-second grace period and
  was SIGKILLed (`Exited (137)`) — tolerable when stopping meant deleting, absurd now that an
  idle pause is routine. tini also reaps the orphans a days-long container accumulates from
  every `bash -c`, which would otherwise pile up against `PidsLimit`.
- **The per-user cap counts *running* sandboxes only.** It protects memory, CPU and pids, which
  a paused sandbox holds none of; counting paused ones would refuse a user a new sandbox until
  they went and deleted old conversations.
- **Extraction-pool sandboxes (`files/extract.ts`) are the exception and still destroy on
  idle.** They hold no work anyone returns to, are keyed by user rather than conversation, and
  have no row — nothing could ever resume one, so pausing them would leak containers forever.
- **Vitest shares one process across test files, so `process.env` is shared.**
  `settings.test.ts` legitimately pins `SANDBOX_IDLE_STOP_MS=1` to prove the env
  override works; a case elsewhere that means "the default 4-hour window" must pin it
  explicitly rather than inherit, or it sees its sandbox stopped instantly by another
  file's variable.
- **Tests must not assert on a global sweep's return count.** `stopAllSandboxes` and
  `reapAbandonedSandboxes` are server-wide, suites share one Postgres, and there is now more
  than one host-provider suite — assert on the rows the test created instead. `reapAbandoned`
  takes an optional `kind` purely so a test's deliberately tiny retention window cannot destroy
  the container another suite is mid-run in.
- `web_fetch` always runs on the **server**, never in the sandbox — container sandboxes
  have no network (`NetworkMode: none`) and host-mode ones deliberately aren't trusted with
  an unfiltered fetch either. It has a real SSRF guard (DNS-resolves and rejects
  private/loopback/link-local answers, follows redirects manually so every hop is
  re-checked).
- **`web_fetch` strips markup BEFORE it truncates, never after.** The two caps are
  separate and both matter: `WEB_FETCH_MAX_RAW_BYTES` bounds the bytes read off the wire
  (streamed, so a model-chosen URL can't buffer a huge asset into the server), and
  `WEB_FETCH_MAX_BYTES` bounds the *extracted text* that reaches the prompt. Capping the
  source instead spends the whole budget on markup — and worse, a cut that lands inside a
  `<style>` leaves htmlToText's non-greedy `<style>…</style>` with no closing tag to match,
  so **nothing** is stripped. That is not hypothetical: one news fetch put 100 KB of raw CSS
  into a prompt and cost 109 seconds of prompt evaluation. htmlToText therefore also drops a
  trailing *unterminated* script/style block, which by construction can only be a truncation
  artefact. `extractFetchText` is pure and exported so the ordering is asserted without a
  network round-trip.
- The container sandbox image (`loxaic-sandbox`) builds itself automatically on first use
  if missing — nothing needs to build it ahead of time (`ensureImage()` in
  `container-provider.ts`).

### Prompt caching (why the history window is anchored)

- **llama.cpp and LM Studio cache the KV state of a prompt *prefix*.** A turn is cheap only
  when the previous turn's prompt is a literal prefix of it; the moment the first tokens
  differ, the backend re-evaluates the whole history. Measured on a 14.5k-token thread
  against a local LM Studio: **312 ms** when the window held still versus **14,551 ms** the
  turn one message fell off the front, and the gap grows with the conversation.
- **So `HISTORY_LIMIT` is a floor, not a window size.** `loadHistory`'s oldest edge is
  quantised by `historyAnchor` to `HISTORY_STEP` (25), letting the replay grow to
  `HISTORY_LIMIT + HISTORY_STEP - 1` messages and re-anchoring only once per step. A plain
  "newest 50" window slides by one every turn — past message 50 that is a **full prompt
  evaluation on every single turn, forever**, which is exactly what it looked like from the
  outside ("the second message reprocesses the whole history"). An agent turn can persist a
  dozen messages, so 50 arrives faster than it sounds.
- This needs a real `COUNT(*)`, not the old limit+1 over-fetch: the anchor has to be a stable
  function of the conversation's actual length, and an over-fetch by one can only answer
  "is there more?". One indexed count per run (not per tool iteration).
- **Anything that changes an *older* part of the prompt breaks the cache just as badly**, which
  is why `selectAffordableAttachments` spends its history budget oldest-first — see the
  attachment-budget bullet below.
- **Partner-less tool calls and results are stripped in both directions.** An interrupted run
  leaves an assistant `tool_call` with no result (`resolvedCallIds`); the window's oldest edge
  can equally orphan a `tool_result` whose call fell outside it (`presentCallIds`). Most
  backends reject either.

### Telling the user what the prompt actually carried

- **An attachment dropped for budget reasons is reported to the user, not just to
  the model.** `attachmentContentParts` has always substituted a marker naming the file, but
  nothing reached the client — so the chip sat in the transcript looking exactly like one the
  model could see, and someone whose file was dropped got a reply that ignored it with no way
  to connect the two. `loadHistory` now returns `omittedAttachments` from the *same* verdict
  the prompt acted on, so the claim and the prompt cannot disagree.
- **It is a fact about the turn, deliberately, not a prediction about the next one.** It rides
  on that turn's `TurnUsage`, so it is exactly what was sent and appears beside the answer it
  explains. It is not persisted: after a reload the notice is absent, and **absence must be
  read as "we were not told", never as "nothing was dropped"** — which is why the client only
  renders it on positive information.
- **It names every file, and does not advise re-attaching.** A bare "2 attachments weren't
  sent" leaves the user unable to tell whether it dropped the spreadsheet that mattered. And
  re-attaching, which looks like the obvious fix, is not one: it brings that file back via the
  current-turn reserve while pushing another out of the history pool in its place. Measured on
  four over-budget documents, the dropped file simply alternates (C → D → C) and the notice
  never clears. Compaction genuinely frees the budget, because the replay then starts after the
  summary and the older attachment turns stop being counted — so that is what it recommends.
- **Rendered on the newest message only.** Being over budget is a standing condition,
  re-derived over the whole replay every turn, so a per-message notice staples the same
  sentence to every subsequent reply — including ones the user attached nothing to.
- **Unreadable is not unaffordable.** `selectAffordableAttachments` admits an image whose bytes
  are missing (costing no budget) rather than skipping it, so it reaches
  `attachmentContentParts`' `[image unavailable]` branch instead of being described — to the
  model *and* now to the user — as over a budget it has nothing to do with. The document branch
  always drew this distinction; the image branch did not, which meant the prompt itself was
  already saying the wrong thing whenever bytes outlived their row.

### The agent step limit

- **`user_prefs.max_iterations` (default 20, clamped 1-50) bounds the tool loop**, replacing a
  hard-coded constant. Worth exposing because in auto mode it is the *only* brake — nothing
  else asks permission — and people genuinely differ on how long they want the agent working
  unattended.
- **Clamped on read as well as validated on write.** The route rejects out-of-range values
  rather than silently clamping (a client that asked for 500 should be told it did not get
  500), and `userMaxIterations` clamps anyway, because the column is plain data and a value
  that arrived by some other route must not be able to remove the brake. A failed lookup falls
  back to the default, never to "unlimited".

### Automatic compaction

- **The server compacts on its own** once a finished turn's `prompt + completion` crosses
  `AUTO_COMPACT_THRESHOLD` (default 0.85) of the model's window, provided the replay holds at
  least `AUTO_COMPACT_MIN_MESSAGES` (8) and the user hasn't turned it off. Policy lives in
  `streams/runs/auto-compact.ts`; `/compact` is the same machinery with `auto: false`, no
  threshold, and no pref check — asking for it is a decision.
- **It is a per-user pref (`user_prefs.auto_compact`, default true), read only after the
  threshold has already been crossed** — so an ordinary turn costs no extra query. A failed
  prefs lookup **fails closed** (no compaction): not compacting costs one long prompt, whereas
  compacting against someone's wishes costs a conversation they can't get back.
- **`PATCH /v1/prefs` is partial.** It used to require `toolAllowlist` on every call; a second
  field on a route shaped like that is how one setting silently reverts another, since any
  client writing one key would have had to send the other, and a client holding stale prefs
  would write back the old value. Absent keys are left alone, present ones are still validated,
  and an empty patch is a 400 rather than an empty row.
- **The settings toggle spells out both outcomes, not just the one being enabled**
  (`components/settings/AutoCompactToggle.tsx`). The trade is between two unlike costs — losing
  detail from old turns versus a conversation that eventually stops replying — and neither is
  guessable from a switch label. The inactive branch stays on screen, dimmed, so the
  consequence of flipping it is visible before it is flipped.
- **The trigger sits past `runToolLoop`'s `finally`, and must stay there.** `startCompactRun`
  takes the per-conversation lock the run holds until `unregisterRun`, so triggering one line
  earlier makes the run refuse itself with "already in progress" — silently, forever. There is
  a test that fails (by timing out) if it is moved back inside the `try`.
- **Only the success path fires it.** The error and cancel paths `return` before reaching it:
  a failed turn never established what the prompt costs, and compacting straight after a user
  pressed stop is the opposite of what they asked for. A refused lock or a backend hiccup is
  caught and logged, never surfaced as a failure of the turn that already succeeded.
- **The check is deliberately *after* a turn, not before the next one** — that is the one point
  where the measured prompt size and the window it was assembled against are both in hand.
  What makes acting after the fact safe is the headroom: the threshold has to be low enough
  that the following turn still fits.
- **`AUTO_COMPACT_MIN_MESSAGES` is an anti-thrash guard, not a nicety.** After a compaction the
  replay restarts at zero, so without a floor a conversation whose *summary alone* sits near
  the threshold would re-compact every turn, burning a model call and a full prompt
  re-evaluation each time to save nothing.
- **An unknown window disables it.** A fraction of null is not a number, and compacting on a
  guess rewrites a conversation for no established reason.
- **`auto-compact.ts` exists to break a cycle.** The engine needs the policy and `compactRun`
  needs the engine's `loadHistory`, so keeping the policy in `compactRun.ts` would have the two
  importing each other — working only by the accident that every binding crossing it is a
  hoisted function declaration. The engine reaches `startCompactRun` itself through a dynamic
  `import()` for the same reason.
- **Compaction always costs one full prompt re-evaluation**, because the whole prefix changes
  (see the prompt-caching section). That is the trade being made: one expensive turn to make
  every subsequent one cheap. It is also why the threshold is not lower.
- The summarisation prompt **weights recency** — recent exchanges kept in near-full detail,
  older material compressed harder — with section 6 ("All User Messages") the deliberate
  exception, since nothing else survives verbatim. `stats.auto` reaches the client so the card
  can explain a summary nobody asked for.
- **`prompt-prefix.test.ts` is the guard for all of this, and it is the only
  test that can see this class of bug.** It records the actual `messages` array
  handed to `streamCompletion` on every request and asserts each is an
  element-wise extension of the one before. Four separate defects broke that
  invariant and every one was found by inspection after shipping: a sliding
  window; the replay dropping `name` from tool messages; the replay
  re-serialising tool `arguments` (with jsonb reordering keys underneath it);
  and the live loop sending untrimmed assistant text where the replay trimmed.
  All four are *serialisation mismatches between two paths that must agree*, so
  no unit test on either path alone can catch them. Each was re-introduced and
  confirmed to fail this test before it was committed.
- **MOCK_INFERENCE's untidiness is load-bearing.** Its tool-call text ends in a
  newline and its tool arguments are in an order Postgres jsonb will not
  preserve — because a mock tidier than a real model is *why* two of those four
  defects stayed invisible. `prompt-prefix.test.ts` has a canary case that fails
  if either property is cleaned up, since the other cases would otherwise just
  quietly stop covering anything.

### The run queue (what actually protects the prompt cache)

- **The prefix invariant is per conversation, and on its own it is not enough.**
  `prompt-prefix.test.ts` proves each conversation's requests extend its own previous one —
  and two conversations can each do that perfectly while alternating, which evicts the
  backend's single cached prefix on every call. `streams/registry.ts` only ever enforced one
  run per *conversation*. `inference/scheduler.ts` is what stops two of them interleaving.
- **The unit of scheduling is the run, never the model call.** One user turn including all of
  its tool iterations holds one slot from its first request to its last. Rotating between
  runs per call would keep the queue fair and destroy the cache on every iteration, which is
  the whole problem.
- **A run waiting for a human gives the slot back** (`slot.yieldWhile`, wrapped around
  `waitForApproval`). A manual-mode approval can sit for minutes and would otherwise stall
  every other conversation for exactly that long. It re-enters at the **front**: it has
  already been admitted once, its prefix is the one the backend most likely still holds, and
  charging a user for approving is backwards.
- **Concurrency follows the backend, not a number we invent.** Precedence is
  `INFERENCE_MAX_CONCURRENT_RUNS` > the admin setting > llama.cpp's `/props` `total_slots`
  (its `--parallel`, which is literally how many prefixes it keeps) > **1**. The floor is 1
  because over-estimating restores the thrashing invisibly — the symptom is "everything is
  slow", not an error. LM Studio reports nothing about slots anywhere, so it resolves to 1,
  which is the truth.
- **`acquireRunSlot` returns null on abort rather than throwing.** Both run starters call
  `runToolLoop` fire-and-forget, so a rejection would surface as an unhandled rejection
  instead of a cancelled turn. The one place that *does* throw is `yieldWhile`
  (`RunSlotAbortedError`), which `runToolLoop` catches by type — anything else keeps
  propagating rather than being flattened into a cancelled turn that hides a real fault.
- **`enter()` re-checks `signal.aborted` after its await and again after registering the
  listener.** An abort that fires during `resolveMaxConcurrent()` has already run its
  listeners, so a waiter registered afterwards never hears it and sits in the queue forever —
  the run then never ends at all. Read through a function call, not the property directly:
  the type checker narrows it to false after the first check and cannot see that the await
  changes it.
- **Compaction queues like any other run**, including automatic compaction — a background job
  jumping the queue would stall somebody's chat.
- **`run.queued` carries one number, a 1-based place in line.** Re-emitted as the queue moves
  so a client counts down instead of showing a stale figure, folded into the snapshot so a
  reconnecting client sees the wait, and cleared by `iteration` — reaching an iteration *is*
  the run starting.
- **The mock's `take your time` prompt** (`MOCK_SLOW_MATCH`) is the only way to observe a
  queue end to end: every other mock response lands in milliseconds, so without it a test
  would be racing the harness against itself. Keyed on the prompt rather than an env var so
  it slows exactly the conversation that asked.
- **Test isolation:** `resetServerSettingsCache()` is process-global and vitest shares one
  worker across files. Clearing it mid-run made another suite's `updateSandboxSettings` see a
  changed value, sweep every live sandbox, and fail four unrelated container tests. Prefer an
  env pin read at call time.

### Reporting cache figures honestly

- **Only llama.cpp reports what it actually reused** (`timings.cache_n`). LM Studio reports
  nothing about caching anywhere — no field in `usage`, no `/tokenize`, no `/slots`, no
  `/props` (all probed and absent), and its native `stats` block carries only TTFT and the
  generation rate. So `usage_records.cached_tokens` is **nullable, and null means "the
  backend does not report this"** — storing that as 0 is what pinned the stats screen at a
  permanent 0% hit rate. Never reintroduce a `?? 0` on that path.
- **`prompt_tps` must never be derived as `prompt_tokens / ttft`.** That is not a rate of
  anything once any of the prompt was cached: a fully-cached 30k-token prompt returns its
  first token in ~400 ms, and the old fallback duly rendered "Prompt speed: 47,742 tok/s".
  It comes from `timings.prompt_per_second` or it is null, and the client shows the prompt's
  size against `ttft_ms` instead.
- **`usage_records.reusable_tokens` is our own measurement, and it is what the aggregates
  use.** `inference/prompt-reuse.ts` fingerprints each request (model, tools hash, one hash
  per message) and reports how much of this prompt was a token-identical prefix of the
  previous request for the same conversation. When the previous request's whole message list
  is a prefix of this one — every ordinary turn, every tool iteration — the answer *is* that
  request's measured `prompt_tokens`, so the figure is exact but for the 3-5 tokens of
  generation prompt the template appends. **A prefix that breaks earlier reports 0 rather
  than an estimate**: guessing at a token split we cannot measure is the exact failure this
  module exists to avoid, and in practice the break is at the first message after the system
  prompt (a history re-anchor), where the true value really is near zero.
- **Reusable is not cached, and the UI must not say it is.** It proves what we *offered*; the
  backend may have evicted the slot for another conversation, restarted, or reloaded the
  model. `promptReuse()` in `apps/mobile/lib/usage.ts` carries the provenance, and the labels
  differ deliberately: "Prompt cached" (backend ground truth) versus "Prompt reused" (ours).
  It floors rather than rounds, so 99.58% never reads as a perfect 100%.
- **The aggregates deliberately use `reusable_tokens`, not `cached_tokens`** — it is the only
  one present on every backend, so it is the only one comparable across models and
  deployments. Denominators are `SUM(input_tokens) FILTER (WHERE reusable_tokens IS NOT
  NULL)`, so a turn with no figure (a conversation's first, or one after a restart) cannot
  dilute the rate, and an empty window yields **null — rendered "—", never "0%"**.
- Traces are in-memory and bounded (LRU, 500 conversations). A server restart costs one turn
  reporting "no previous request", which is the conservative direction: the separately-hosted
  backend may well still hold the prefix, but we cannot prove it, so we claim nothing.

### Conversation sharing and roles

- **One ordered role, resolved in one place.** `viewer < editor < owner`
  (`streams/authz.ts`). `resolveAccess` resolves **owner → explicit share → admin**, and
  `assertConversationAccess(userId, convId, minimum)` is the WS chokepoint. Ownership lives on
  `conversations.ownerId` and is deliberately *not* a row in `conversation_shares` — two
  sources of truth for the same fact eventually disagree, and "owner" is therefore not a
  grantable role (a share payload asking for it degrades to viewer rather than escalating).
- **Admin resolves to `viewer`, never higher**, with `viaAdmin: true` on the grant. An admin
  can see any conversation; seeing is not acting. An admin who needs to participate shares it
  to themselves, and `conversation_shares.createdBy` records that they did. A real share
  always beats the admin fallback, so a genuinely-granted admin editor isn't demoted by their
  own admin status.
- **Not-found, not-shared, and shared-too-low all raise the same `NotFoundError`.** Never
  branch on which it was — the route tests assert the responses are byte-identical.
- **`stop` and `approve` authorize on the conversation, not the run's starter.**
  `run.userId === userId` used to be both the lookup and the authorization; that breaks as
  soon as a conversation has editors besides its owner, and runs deliberately outlive the
  socket that began them. `findRunByApprovalCallId` now only *locates* — `mayActOnRun` in the
  WS handlers is what authorizes. Both paths still no-op silently on refusal.
- **Revoking takes effect on the revoked user's next command**, not instantly: their live
  socket keeps the stream it is already tapped into until it re-subscribes. Every command
  re-authorizes, so nothing new reaches them, but this is not an emergency kill switch.
- **REST goes through `hasRole`**, not inlined ownership predicates. Reading a thread needs
  viewer; model/MCP prefs and delete stay owner-only. **Sandbox routes stay owner-only** —
  terminal access is arbitrary code execution, not participation in a chat.
- **Attachment reads extend to "appears in a conversation you can see"**, scoped to
  conversations the caller can access — otherwise a shared thread renders its messages and
  404s every image in them. The jsonb predicate matches the reaper's (`block->>'kind' =
  'attachment'`); a future ref-carrying block kind has to teach both.
- **e2e login waits for either `composer.input` or `composer.readOnly`.** A viewer's composer
  is replaced by an explanation, so waiting on the input alone hangs for exactly the user the
  sharing spec signs in.

### File attachments

- **Uploaded bytes live on disk under `UPLOADS_DIR`; only metadata is in Postgres**
  (`attachments` table — `{id, owner_id, mime, size_bytes, filename, extract_status,
  extract_bytes, created_at}`). `UPLOADS_DIR` unset falls back to `<cwd>/uploads`, which in a
  checkout means `apps/server/uploads` — **inside the working tree, and gitignored for exactly
  that reason** (#65). Docker compose and the desktop supervisor both set it explicitly (the
  supervisor puts it under `dataDir` beside the Postgres data, never in the installed bundle,
  which an update would replace). A document's extracted text is cached beside the original as
  `<ref>.txt` — see extraction, below.
- **Client-supplied refs are validated at exactly one chokepoint**, `assertAttachmentsOwned`
  (`streams/authz.ts`), and it must run **before** any conversation/message write. It returns
  the mime **and filename** from the DB row — the client's copies are advisory and are
  discarded — de-duplicates repeated refs (the same ref four times is one attachment, not a 4×
  prompt), and renders unknown and not-yours as the same `NotFoundError`. `name` is omitted
  entirely (not sent as `""`) for a row predating documents.
- **`isValidRef` takes `unknown` and type-guards, deliberately.** `RegExp.test` stringifies,
  so a `string`-typed parameter is not a guard: `test(["<uuid>"])` coerces the single-element
  array back to the uuid and returns true. Anything arriving off a socket is a claim, not a
  fact — `validateSendAttachments` type-checks elements for the same reason.
- **Nothing is served with a caller-influenced content type**, and disposition now splits by
  class. Upload allowlists a mime (`IMAGE_MIMES`/`TEXT_MIMES`/`DOCUMENT_MIMES`, or an
  extension fallback via `resolveAttachmentMime` for browsers that report `""`), then
  `verifyStoredBytes` confirms it against the actual bytes — magic bytes for images/PDF
  (`sniffMime`), a streamed fatal-mode UTF-8 decode with no NUL byte for text — and the serve
  route adds `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` regardless of
  class. **Only images get `Content-Disposition: inline`; everything else is forced to
  `attachment`.** This split is load-bearing, not cosmetic: `text/html` and `text/xml` are
  extractable text mimes, and this endpoint is same-origin with the web app, so serving either
  `inline` would be same-origin stored XSS the day someone reaches for it. **SVG stays absent
  from every mime list for the same reason.**
- **Filenames are sanitized once, at upload** (`sanitizeFilename` — basename only, control
  characters stripped, length-capped) and read back from the DB row everywhere downstream: the
  model's prompt, the UI chip, and the `Content-Disposition` header. The client's copy is never
  trusted for any of the three.
- **Parsing runs inside a sandbox, never in the server process.** Text formats
  (`TEXT_MIMES`) are just UTF-8 bytes, decoded in-process — no parser, so they work with
  `SANDBOX_MODE=off`. Everything in `DOCUMENT_MIMES` (PDF, DOCX/XLSX/PPTX, ODT, RTF, EPUB)
  needs a real parser over a file the server did not author; `files/extract.ts` runs it in a
  pooled per-user sandbox — argv-safe `pdftotext` for PDF, the `loxaic-extract` script baked
  into the image (`infra/docker/sandbox/extract.py`) for the rest — and the upload route
  **rejects document mimes outright when no sandbox is configured**, with a 415 naming why.
  Extraction reads and never executes: no macro, embedded script, or PDF JavaScript runs, and
  the container has no network to reach regardless.
- **Every document format except PDF and RTF is a zip container, so `extract.py` runs a
  decompression-bomb guard before opening one** — entry count, total declared uncompressed
  size, and per-entry compression ratio, all read from the central directory so nothing is
  inflated to reject it. The container's memory limit would eventually stop a bomb anyway, but
  as an OOM kill after burning the whole timeout; this fails in milliseconds with a reason.
  **Deliberately not markitdown**, which was the original plan: it takes `magika` (and so
  onnxruntime, numpy, pandas) as a *base* dependency — measured at 326 MB / 30 packages versus
  63 MB / 20 for the individual libraries — and ships no extras for ODT, RTF, or EPUB, so it
  would have cost 5× the image for fewer formats.
- **The sandbox copy of an upload is named for its format** (`<uuid>.xlsx`, not `<uuid>.in`).
  Several of these libraries dispatch on the *filename*, not the content: openpyxl flatly
  refuses a file that doesn't end in a spreadsheet extension, so a valid .xlsx silently
  extracted to `failed` until this was fixed. The extension comes from our own mime table,
  never from the user's filename.
- **A sandbox extractor writes to a file, and the result is read back in chunks** — never
  straight off stdout. `exec` caps what it returns at `MAX_OUTPUT_BYTES` (256 KB), well below
  what a long document legitimately extracts to, so reading stdout truncated mid-document *and*
  spliced the exec layer's own `[output truncated]` notice into the text cached as the
  document's. Chunks are base64'd because `exec` hands back an already-decoded string, and a
  chunk boundary landing mid-UTF-8-sequence would corrupt that character on every large file.
- **Documents need a *container*, and host mode does not count.** The upload gate is
  `mode === "container" && available`, not "some provider is configured": host mode has none of
  the container's protections — no `NetworkMode: none`, no uid separation, and the host provider
  ignores the resource limits entirely — so parsing an untrusted PDF there is parsing it on the
  server. Without a container the upload is **rejected** (415, `code: "sandbox_required"`) rather
  than stored as a file nothing can read, and the client renders that as a modal explaining why.
  Text formats are unaffected and still work with no sandbox at all. Extraction scratch files go
  under **`handle.root`**, never an absolute `/tmp` path: on the host provider that would be the
  real, shared host `/tmp`, briefly exposing one user's document bytes to anything else on the
  machine.
- **The extraction pool is a second set of live sandboxes**, independent of the conversation
  ones in `agent/sandbox-manager.ts`. `applySandboxSettings` has to stop *both* — before
  `resetEngineCache()`, per the ordering rule below — or an engine change strands pooled
  containers where the boot sweep can never find them, and a host→container switch leaks
  per-user directories still holding uploaded documents.
- **Extraction is cached at a different, larger ceiling than what reaches the prompt.**
  `MAX_CACHED_EXTRACTION_BYTES` (4 MB) bounds the `<ref>.txt` sidecar written at upload time;
  `MAX_EXTRACTED_BYTES` (256 KB) is the separate, smaller cap `attachmentContentParts` truncates
  to before a document's text enters a prompt. Collapsing these into one constant was a real
  bug here: caching at the smaller number would leave nothing for sandbox paging (below) to
  ever page through.
- **Document text enters the prompt wrapped in `<attached-file>` provenance markers**
  (`storage.ts`'s `wrapDocument`, modelled on `mcp/sanitize.ts`'s `wrapResult`) — a literal
  closing marker inside the body is neutralized with a zero-width space so the content can't
  escape its own wrapper, and a sibling system-prompt addendum tells the model the content is
  untrusted. A user's own upload still gets this treatment: they may not have written it.
- **Two independent prompt budgets, never shared.** `MAX_HISTORY_IMAGE_BYTES`
  bounds images by raw bytes (their prompt cost is backend-specific patch embeddings, which is
  why `context.ts` refuses to tally them at all). `MAX_HISTORY_DOCUMENT_TOKENS` bounds documents
  by estimated tokens (they *are* tallied, via `textOfContent`) and is **derived from**, not
  independent of, the token-cost of one document at `MAX_EXTRACTED_BYTES` — it was once a flat
  number smaller than that single-document cost, meaning a user's very first attachment could
  exceed the whole budget and vanish from the turn that sent it. `selectAffordableAttachments`
  also caps a document's *measured* size at `MAX_EXTRACTED_BYTES` before estimating, since
  that's the ceiling on what actually reaches the prompt regardless of how large the cache is.
- **Each budget is split into a current-turn reserve and a history pool spent oldest-first, and
  an older turn's verdict must never depend on a newer one.** The walk used to be newest-first,
  which meant a large new attachment could price out one that had fit for many turns — silently
  rewriting a message the model had already been shown, and so throwing away the backend's
  cached prefix from that message onward, exactly like a sliding history window. Oldest-first
  makes each turn's verdict a function of the turns up to it and nothing later, so it is
  permanent once made. **This costs recency:** in a saturated thread the *middle* attachments
  are dropped, not the oldest. That is not an oversight — bounded budget, recency-preferring
  retention and prefix stability cannot all hold at once (recency means a new arrival evicts an
  old one, which is the rewrite), and "decide on arrival, never revisit" is unbounded because
  every attachment ever sent would stay forever. `CURRENT_TURN_IMAGE_BYTES` /
  `CURRENT_TURN_DOCUMENT_TOKENS` are what keep the just-sent attachment guaranteed, so the
  property the old walk order provided is now explicit rather than emergent. The one remaining
  change point is a turn's own move from current to history, which is a single message at the
  very end of the prompt and cannot cascade.
- **A truncated document can be paged through the sandbox, but only if one is already live.**
  When a document overflows `MAX_EXTRACTED_BYTES` and the conversation already has an active
  sandbox, `engine.ts`'s `writeOverflowToSandbox` writes the *full* cached text to
  `<sandbox>/attachments/<ref-prefix>-<name>.txt` and the truncation note names the path. The
  gate is "is a sandbox already active in this process" — `hasActiveSandbox`/
  `attachActiveSandbox` in `sandbox-manager.ts` — **never** "which surface", because chat and
  agent share one tool loop and either can have a sandbox; it must never *create* one, since an
  overflowing document is not sufficient reason to spin up a container. Uses `writeFileBinary`,
  not `writeFile` — the container provider's `writeFile` passes its payload as a bash argv
  element, capped by `ARG_MAX`, which a multi-megabyte document routinely exceeds.
- **`fs_read` pages by line via `offset`/`limit`, executed inside the sandbox, not read-then-sliced
  in JS.** The container provider's `readFile` is `cat` through `execInContainer`, itself capped
  at `MAX_OUTPUT_BYTES` (256 KB) — reading a large file fully before slicing in JS would hit that
  cap first and silently fail to page past it. Implemented as one `awk` pass that prints the
  requested range (numbered) to stdout and the total line count to stderr from its `END` block,
  so only the small requested slice needs to cross the output cap.
- **The sandbox image tag is a hash of `sandbox.Dockerfile`, not a fixed name.**
  `ensureImage()` only builds when the image is *absent*, so a fixed tag would mean a Dockerfile
  change (e.g. adding `poppler-utils` for `pdftotext`) never reaches a deployment that already
  built once — every PDF would then fail with a bare, undiagnosable exit 127. Confirmed this
  exact failure mode directly before the content-hash fix went in.
- **The orphan sweep (`files/reaper.ts`) is the only reclaim path there is** — no DELETE
  route, no cascade from message deletion. It collects uploads no message references after a
  grace period — the picked-then-abandoned upload, whose row already records who uploaded it
  even though nothing references the bytes. The default grace matches `STREAM_TTL_SECONDS`'
  own 24h. It also removes a document's `<ref>.txt` sidecar alongside
  the original — **the sweep's SQL keys on `block->>'kind' = 'attachment'`, so a future new
  block kind (rather than discriminating on mime within this one) would silently stop
  protecting those files from deletion.**
- **`?token=` on `/v1/files/:ref` is a full session token in a URL.** It exists because
  `<img>` can't set headers (same precedent as `/ws/chat?token=`), and the header is
  preferred when present. Fastify's default logger would write it to stdout on every
  thumbnail, so `logging.ts`'s `redactUrl` is installed as the `req` serializer — **any new
  route taking a credential in the query string must use a parameter name that module
  already knows.** Redaction covers the log only — the token is also live in the DOM as an
  `<img>` src for as long as a thread with images is open (#63).

### MCP servers

- The tool loop resolves tools through a per-run `Toolset` (`apps/server/src/mcp/registry.ts`),
  not the static union: builtins from `packages/agent` plus the user's enabled MCP servers
  (`mcp_servers` table), namespaced `slug__tool` (no builtin contains `__`, so they can't shadow).
- **Everything an MCP server produces is untrusted.** Descriptions/schemas are capped and
  control-stripped (`mcp/sanitize.ts`), results are byte-capped and wrapped in
  `<mcp-tool-result …>` provenance markers with escape attempts neutralized, and a system-prompt
  addendum tells the model to never follow instructions found inside. Model-produced arguments
  are ajv-validated against the declared schema before anything reaches the server.
- MCP tools ask for approval in **every** mode — auto included — until the user allowlists the
  specific tool; planning mode only offers tools the user marked read-only (server
  `readOnlyHint` annotations are display-only, never trusted). Tool-change detection
  (`mcp/change-detection.ts`) revokes allowlists when a tool's description/schema hash changes.
- Credentials are AES-256-GCM-encrypted at rest (`mcp/secrets.ts`, key from
  `MCP_ENCRYPTION_KEY`, fallback `BETTER_AUTH_SECRET`) and `redact()`-ed out of every error
  path. stdio children get a minimal env (`PATH`/`HOME` + row env + secrets), never
  `process.env`. HTTP transports re-run the SSRF guard per request unless the user confirmed
  `allowPrivateNetwork` in the GUI.
- Connections are cached per `userId:serverId` with an idle reaper (`mcp/client-manager.ts`,
  mirrors sandbox-manager); a dead/hung server fails only its own tool calls, never the run.
- Brave Search ships as a built-in catalog entry (`mcp/catalog.ts`) pinned to the official
  `@brave/brave-search-mcp-server` — spawned from the installed package's bin, never `npx`.
  The GUI lives at `/mcp` (mobile/web); per-conversation server switches are in the agent
  Inspector (`conversations.mcpOverrides`).
- Testing: `test-fixtures/mock-mcp-server.ts` is a deliberately hostile stdio fixture;
  `MOCK_INFERENCE=true` triggers `mockmcp__*` tool calls only when the registry actually
  offered them (see `MOCK_TOOL_TRIGGERS`); `src/mcp/__tests__/` covers units + a full-loop e2e.

### Agent workspaces

- **`conversations.workspace` (jsonb, `Workspace` in `packages/types`) says where an agent
  conversation's files live: `scratch` (stored as null — indistinguishable from every
  pre-workspace row), `github` (a clone on a fresh branch), or `local` (the user's own
  machine; a later stage, rejected until then). Set once by `POST /v1/conversations
  {kind:"agent", workspace}` and **never patched** — there is no PATCH path, deliberately.
- **The system prompt is a pure function of the workspace and the sandbox mode**
  (`agent/workspace.ts`'s `describeWorkspace`). Nothing live may go in it — not whether a PR has
  been opened, not whether the sandbox is paused — because the prompt is the front of every
  request's prefix and any variation between turns costs a full re-evaluation. `prompt-
  prefix.test.ts` has a github-workspace case that asserts two turns produce a byte-identical
  system message. The container path is quoted literally because it is fixed; the host path is
  described rather than named because it is only known once the sandbox exists.
- **The old prompt lied.** It told every conversation "the repository checked out at
  /home/loxaic/repo" when nothing was ever checked out. Scratch now says so.
- **`cloneUrl` and the default branch come from GitHub, never the client.** `parseWorkspaceInput`
  looks the repo up with the *owner's* token (so a repo they cannot see is a 400 at creation,
  not a clone failure on the first tool call), takes `clone_url` from the answer, and ignores any
  `pr` the client sends. A client that could name the clone URL could point the checkout
  anywhere.
- **Clone credentials belong to the conversation owner, never the sender.** Sandboxes are
  created lazily on first tool use, which may be a shared editor's; the row's `ownerId` is the
  owner's for the same reason (`sandbox-manager.ts`'s `createConfigFor`).
- **A GitHub token meets git in exactly one place: `sandbox/git.ts`.** It rides in
  `ExecOptions.env` for one command, read by a `credential.helper` passed with `-c` — never in
  argv, never in the clone URL (which git writes into `.git/config`, where the model can `cat`
  it and `web_fetch` it out), never in a file, never logged. `git.test.ts` greps the whole
  `.git` directory for it after a clone. The previous code embedded it in the URL.
- **Full clone, not `--depth=1`.** Shallow made `git log`, `blame` and `diff <base>` — the first
  things a model reaches for — empty or wrong. Paid once per conversation; the checkout is kept
  (stop-and-resume).
- **GitHub workspaces need sandbox networking**, which containers lack unless an admin enabled
  it. The chooser reads `GET /v1/config` and refuses GitHub *with the reason and the fix* rather
  than hiding it; a coding agent that cannot `npm install` is not one. `SANDBOX_EXTRA_HOSTS`
  (`host:ip`, comma-separated → `HostConfig.ExtraHosts`) exists so a networked sandbox can
  reach a service on the host by name on Linux/Podman.
- **Client: create-then-send when a workspace was chosen; the implicit path stays.** A plain
  send with no conversation still opens a scratch one on the server, for clients that predate
  the chooser. `titleIfUnnamed` names a pre-created conversation from its first message, gated
  on the message count so a thread a user renamed to literally "New conversation" is never
  overwritten.
- **e2e:** `apps/e2e/scripts/git-server.ts` runs `git daemon` over the fixture repos and the
  mock GitHub API hands out its `git://host.docker.internal:<port>/…` URLs as `clone_url`, so
  the spec exercises the server's real workspace path with nothing stubbed. Specs that clone
  turn `allowNetwork` on through the admin API and reset it after — the env pin would make
  `resetSandboxSettings()` 409.

### GitHub connection

- One personal access token per user (`github_connections`, `userId` primary key like
  `user_prefs` — a user has at most one). A PAT, not OAuth: no app registration, no callback
  URL, and it works identically for a self-hosted deployment nobody outside it can reach.
- `apps/server/src/github/client.ts` is a thin plain-`fetch` wrapper — no octokit — and reads
  `GITHUB_API_URL` (default `https://api.github.com`) **at call time**, the same test/operator
  seam every other backend URL in this codebase uses. `apps/e2e/scripts/mock-github.ts` points
  it at a fixture server so no e2e spec ever reaches real GitHub.
- Encrypted at rest with the **same aes-256-gcm scheme** `mcp/secrets.ts` uses (`github/
  connection.ts`, its own module rather than importing that one — it stores one string, not a
  `Record<string,string>`), keyed off the same `MCP_ENCRYPTION_KEY` (fallback
  `BETTER_AUTH_SECRET`). `getOwnerToken()` is the only decrypt site outside tests.
- **Disconnecting hard-deletes the row**, matching MCP server credentials for the same reason:
  stored credentials must not outlive the user's intent to remove them.
- Fine-grained PATs return no `X-OAuth-Scopes` header at all — stored as `null`, which must
  read as "unknown," never as "no access." A classic PAT's `repo` scope is reported and shown.
- Every route redacts the token out of error messages **twice**: once inside `github/client.ts`
  (a network error or a non-2xx body might echo it back) and again in `routes/github.ts` before
  the message reaches the response, since defense at one layer failing silently is exactly how
  a token ends up in a log or a client error toast.
- `PUT /v1/github/connection` validates the token against GitHub (`getViewer`) before storing
  anything — a bad token fails at connect time, not on the first clone three steps later (a
  later stage).

### Git actions from the Inspector

- `routes/git.ts` (`/v1/conversations/:id/git/{status,commit,push,pr}`) is deliberately the
  only way to push or open a PR. `agent/workspace.ts`'s system-prompt fragment tells the model
  to commit as it goes but never to push or open a pull request — those are the user's own
  actions, taken from the Inspector's Git panel, not the model's.
- **Owner-only, every route**, matching the sandbox terminal and REST routes: pushing to the
  user's own GitHub as them, with their token, is not something a shared editor should be able
  to trigger. **409 while a run is active** (`getRunByConversation`), so a commit/push/PR click
  never races the agent's own tool calls in the same checkout.
- Reuses the conversation's already-cloned sandbox (`findSandboxRow` + `attachRunningSandbox`)
  rather than cloning again — `GET status` in particular must have no side effect just because
  the Inspector was opened, so a conversation the agent hasn't touched yet reports
  `cloned: false` from the workspace's own repo/branch fields alone.
- **Commit identity is resolved at commit time from the live GitHub connection**, not the
  identity `git.ts` wrote into the clone's config — a connection added or changed after the
  clone must still be able to commit under the current name/email.
- **Opening a PR is idempotent by our own memory**: once `workspace.pr` is set
  (`setWorkspacePr`), every later call returns the stored PR without asking GitHub again,
  rather than risking a duplicate PR on a retried click.
- Push errors are redacted a second time in `routes/git.ts` itself (`redact()`, a local
  module-private helper — it does not import the sandbox git module's own), on top of
  whatever `sandbox/git.ts` already scrubbed, for the same defense-in-depth reason as the
  GitHub connection routes above: a token must not reach the client even if one layer's
  redaction misses it.
- **A test file that mutates real DB-wide sandbox state must scope its cleanup to its own
  rows.** `git.test.ts` originally ran an unscoped `db.delete(sandboxes)` in its `afterEach`,
  which wiped every other suite's sandbox rows out from under them whenever the full server
  suite ran in parallel — it now scopes by its own `ownerId`, matching every other sandbox
  test file's convention. The same class of bug existed the other direction, already latent
  in Stage 1: `reapAbandonedSandboxes()` queries the `sandboxes` table directly (unlike
  `stopIdleSandboxes`, which only ever touches this *process's* own in-memory `active` map —
  **`stopAllSandboxes` is not in that company**: after walking the map it also sweeps every row
  whose status is `running`, so calling it from one suite's cleanup stops the sandbox another
  suite is asserting on, which is exactly what the terminal test's first draft did. Scoped test
  cleanup is `destroyConversationSandboxes(id)`), so two host-mode suites in different worker
  processes are
  visible to each other there even though neither can see the other's in-memory state. Adding
  `git.test.ts` as a second host-mode suite exposed it: `lifecycle.test.ts`'s deliberately
  tiny reap windows destroyed a sandbox `git.test.ts` was mid-request in. `reapAbandonedSandboxes`
  now takes an optional third `ownerId` argument for exactly this — a test aims a destructive
  global sweep at only its own rows the same way the existing `kind` argument already narrows
  it to one provider; production's own reaper interval still calls it with neither.
- **The Inspector's content can now overflow a short viewport, and it must scroll rather than
  compress.** Before this stage the panel's total content always fit; adding the Git section's
  commit/push/PR controls was enough to push it past a typical viewport height. gluestack's
  base classes put `min-h-0` on every `Box`/`VStack`, which is exactly what removes the
  browser's default flex protection against shrinking a flex item below its content size — so
  without a scroll container, sections silently compressed and overlapped instead of
  overflowing, which is invisible in a snapshot of static props (nothing pushes it past the
  fold) and only appears once the panel's *total* content is tall enough. `Inspector`'s wide
  and narrow layouts both wrap `InspectorBody` in a plain React Native `ScrollView` now
  (`style={{flex:1, minHeight:0}}`) instead of a bare `Box`.

### Local workspaces (the desktop's executor)

- **A `local` workspace runs on the user's own machine, never on the server.** The desktop
  app spawns `dist/executor.js` (`apps/server/src/executor/main.ts`, a second tsup entry of
  the server package), which dials `/ws/executor?token=` and registers itself under the user
  (`executor/registry.ts`, process-local like the run registry). The sandbox provider for it
  (`sandbox/executor-provider.ts`, `kind: "executor"`) is chosen by the conversation's
  workspace in `getConversationSandbox` — **never** by `SANDBOX_MODE`, an admin setting, or a
  request field. `SandboxMode` deliberately does not include it, so `POST /v1/sandboxes`
  cannot mint one and `invalidatedKinds()` can never return it. Local workspaces ignore the
  server's whole sandbox posture: `mode: off`, `allowNetwork`, `hostingBlockedReason()`.
  Executor rows are excluded from the per-user running cap for the same reason — they hold
  no server resources.
- **Trust runs one way.** The executor authenticates to the server (session token, ban
  re-checked every 60s in `ws/executor.ts`), but does **not** trust the server: a host may be
  someone else's machine, and it can send any `call` it likes. `executor/service.ts` re-checks
  every `ref` and every path in every call against the roots the user chose, *by `realpath`* —
  the server's own `resolvePath` is lexical, and a repo can contain a symlink out to `/`. A
  not-yet-existing file is judged by its nearest existing ancestor's real path. Removing a
  folder in the desktop revokes it on the next call, not when the conversation ends.
- **Paths reach the executor only from that machine's native dialog.** `loxaic:pickDirectory`
  takes no argument; `loxaic:executor.removeRoot` only narrows; the roots file
  (`<dataDir>/executor-roots.json`, 0600) is written by nothing else. The renderer cannot name
  a path, and neither can a server the renderer is talking to. `LOXAIC_E2E_PICK_DIR` stands in
  for the dialog under test, read from the app's own environment with a loud one-time warning.
- **The token goes down the executor's stdin, first line, and nowhere else** — not env
  (`ps -E`), not argv (shell history), never persisted, never logged (the socket URL carries
  it and is never printed). `supervisor/executor.js` builds the child env from scratch, and
  `executor.test.js` proves the token is absent from it. On a 4001 the executor **exits**
  rather than retrying a token that will be refused again; the desktop starts a fresh one when
  it has a fresh session. `useLocalExecutorSync` lives in the root layout, above the auth gate,
  because AppShell unmounts the instant the token clears and would never send the null.
- **Offline is a failed tool call with a reason, never a hang.** `callExecutor` decides
  offline up front (a machine that is not connected does not become connected by waiting)
  and every call has a deadline; `exec`'s is the command's own timeout plus a margin, so the
  executor's timeout — a real exit code with captured output — fires first. The provider's
  `attach()` *throws* when the machine is offline so `createEntry`'s existing-row path
  surfaces the message instead of recording the directory as destroyed; `exists()` throws for
  the same reason (`markDeadRowsDestroyed`: "cannot ask" is never "destroyed"); `stop()` and
  `destroy()` never reach the executor's filesystem at all — the directory is the user's own.
- **The executor's module graph must not reach the database, settings, the server entry,
  fastify, or dockerode** — it runs on a laptop with none of them, and a laptop process that
  can open the server's database is a laptop process with the server's secrets in it.
  `executor/__tests__/isolation.test.ts` walks the import graph statically (`import type`
  edges excluded) and fails on any of them. `provider.ts` is only ever `import type`d there.
- **The executor's id is the desktop's `instanceId`** (one identity per machine, shared with the
  `hosts` table), falling back to `<dataDir>/executor.json` only for a launch that env/flags
  pointed somewhere and that never wrote a config. `executorName` in a workspace comes from the
  live executor at creation, never the client — it goes into the system prompt.
  `describeWorkspace` for `local` ignores the server's mode entirely (a fact about the server
  is not a fact about the user's machine), which `workspace.test.ts` asserts.
- **Closing a paused `ws` socket never completes.** `ws/executor.ts`'s early rejections
  `resume()` before `close()`: the close handshake needs the peer's answering frame *read*,
  and a paused socket reads nothing, so the client sat in CLOSING for its full 30s timeout —
  found by the WS test timing out on the very first case. The other handlers' reject paths
  pause-then-close too (ws/chat.ts, ws/agent.ts, ws/sandbox.ts); a browser client eventually
  gives up, which is why it never showed.
- **Every Loxaic server on this machine shares the dev Postgres, and each one's boot sweep and
  reaper act on *all* sandbox rows** — so a `pnpm dev` server (`tsx watch`, which restarts on
  any `apps/server/src` edit), an e2e harness server on :4055, and the server vitest suite must
  never overlap. A restart's `stopStrayRunning` pauses every row it does not hold in memory,
  vitest's own `docker rm -f` of every `loxaic.sandbox` container kills a live e2e sandbox, and
  the symptoms are indirect: `hardening` 409 "container is not running", `lifecycle` "expected
  running got stopped", a whole Electron run stalling for minutes on unrelated specs. One full
  Electron run of this stage failed exactly that way and was green on re-run; do not edit a
  watched server file while a harness run is in flight, and run the suites strictly one at a
  time.
- **Two e2e process facts.** Values every process must agree on — the pick dir, the app's
  data dir — travel as env vars minted with `??=` in `scripts/electron-env.ts`, because a
  module-level `mkdtempSync` runs once *per process* (launcher, worker, and the app each get
  their own — see the Stage 5 note on WebdriverIO's process model). And the Electron suite now
  passes `--loxaic-data-dir` in **every** mode: the executor writes picked folders into the
  data dir, and without a throwaway one a test run appended temp paths to the developer's real
  Loxaic config.
- **A label whose width comes from data can cover the control beside it.** React Native
  defaults every view to `flexShrink: 0`, so `WorkspacePill` — which renders the workspace's
  path — grew past its share of the row and sat on top of the mode selector, making "Manual"
  unclickable. It reached `main` in the local-executor stage and only failed a run later, when
  this machine's hostname happened to be eight characters longer: the overlap was always there,
  and the *click point* crossed the boundary. The fix is both halves — the pill shrinks
  (`min-w-0 shrink`) and truncates while the mode selector is `shrink-0`, and the pill shows the
  folder's *name* with the full path left to the Inspector. Anywhere a data-derived string sits
  next to a control, both are needed: truncation alone still lets it win the space, and
  `shrink-0` on the neighbour alone still lets it overflow the row.
- Not yet: container isolation for a local folder (refused with a reason by both the chooser and
  `parseWorkspaceInput`), Windows executors (`agent/executor.ts`'s `resolvePath` is POSIX, as the
  host provider always was).

### Container isolation for a local workspace

- **The executor can run the agent in a container on the user's own machine**, with only their
  chosen folder bind-mounted at `/home/loxaic/repo` — the same image the server uses, so the
  agent's view is an ordinary workspace. Chosen at chat start alongside Direct, immutable
  after, and offered only when that machine reports a container engine
  (`capabilities.container`, probed per connection so starting Docker later needs a reconnect
  rather than a restart).
- **`container-provider.ts` was split into policy and mechanics** to make this possible without
  giving a laptop process the server's database. `sandbox/container-engine.ts` holds everything
  mechanical — engine discovery, the image, `createSandboxContainer`, the handle — and reads no
  settings; `container-provider.ts` is the settings-aware `SandboxProvider` on top of it. The
  executor imports only the engine. This is not tidiness: `settings.ts` imports `@loxaic/db`,
  tsup inlines every `@loxaic/*` package, so the old shape would have put the database driver
  inside the shipped `dist/executor.js`. `executor/__tests__/isolation.test.ts` is what holds
  the line — put `getSandboxSettings` back into the engine and it fails.
- **Two checks gate attaching to a local container, and they answer different questions.** The
  `loxaic.executor` label stops a server from naming *any* container id on the machine — a
  database, a production service — and getting an `exec` in it. The `loxaic.localFolder` label
  is re-checked against the roots *as they are now*, so un-approving a folder revokes the
  container mounted on it rather than leaving a live door into it.
- **Paths inside a container are not host paths**, so the executor's realpath confinement
  applies to direct refs only (`confined` in service.ts). Inside a container the container *is*
  the boundary: the server's own `resolvePath` already keeps paths under `/home/loxaic`, and a
  path there resolves in the image, not on the laptop.
- **The network is on**, unlike the server's default. There it is off because a sandbox runs
  model-directed commands on someone else's machine and egress is an exfiltration path. Here
  the user has already agreed to run those commands on their own machine, and the alternative
  they would otherwise pick — Direct — has their whole network *and* their whole filesystem.
  Denying it would make the safer choice the less useful one.
- **Linux runs the container as the desktop user's uid:gid** so files written into the mount
  keep their owner; Docker Desktop maps ownership itself on macOS and Windows, where forcing a
  uid would only break it. Overriding the user costs the image's home directory, hence
  `HOME=/tmp` — not the mounted folder, which would scatter tool dotfiles through someone's
  project. **Implemented but unverified**: this machine is macOS, so the uid path has never
  actually run.
- **`create` gets a 10-minute timeout** (`CREATE_TIMEOUT_MS`), because the first
  container-isolated workspace on a machine builds the image. Every other call keeps the 15s
  default. A machine that has genuinely gone away still fails immediately — `callExecutor`
  refuses up front when nothing is connected — so this only bounds one that is answering slowly.
- **`stop` pauses the container and `destroy` removes it; neither touches the folder.** For a
  direct workspace both remain no-ops. The folder is the user's and predates us, which is the
  same rule the host provider learned the hard way.
- The desktop passes `SANDBOX_BUILD_CONTEXT` to the executor as well as the server: a packaged
  install has no repo to build the image from, and `build-server.mjs` stages a copy.
- **A local container carries `loxaic.executor`, and the server's orphan sweep must skip it.**
  Both kinds carry `loxaic.sandbox`, but an executor's container is claimed by no row in the
  server's database — so the sweep, whose whole job is destroying containers no row claims,
  deleted them. Not a corner case: the engine is shared the moment someone runs a Solo or Host
  instance on the machine they also use as their own executor. Caught because the container
  test failed only in a full suite run, alongside `container-lifecycle.test.ts`'s own sweep.
- **A container terminal is a real PTY, a direct one is pipes**, and the server derives which
  from the ref (`isContainerRef`) rather than asking — `openTerminal` returns before the far
  side has answered anything, and `terminal.ready` is sent at that moment. Same reasoning as
  the layout above.
- **Three packaged-only defects surfaced here, all pre-existing and all invisible until
  something asked a *packaged* app to build the image** — which nothing did until the executor
  gained container isolation (the e2e's packaged app is otherwise a client of a repo-run
  server). `build-server.mjs` shipped `sandbox.Dockerfile` without the `sandbox/extract.py` it
  `COPY`s; `sandboxImage()` collapsed its whole digest to `:base` when that directory was
  missing, so every packaged install shared one tag no edit could change; and `ensureImage()`
  treated a failed build as success, because the daemon reports a failed *step* as an ordinary
  progress entry with `errorDetail` rather than as dockerode's `err`. The last one is why this
  presented as an undiagnosable "No such image" from `createContainer` instead of the real
  reason.

### The terminal panel

- **`handle.workdir` is the default working directory, for real now (#62).** `exec` and
  `openTerminal` both land there in **every** provider when the caller names no directory. It
  was documented as that and wasn't: the container provider ran execs in the *root* while the
  host provider used the workdir, so `POST /v1/sandboxes/:id/exec` and the terminal landed
  somewhere different depending on the deployment's sandbox mode. It had already cost a real
  debugging session — a build command hard-coded to `cd …/repo` failed under host mode and was
  reported as a failing build (#55). **This is a behaviour change to the REST exec endpoint and
  the terminal for container deployments**: they used to land in `/home/loxaic`, now
  `/home/loxaic/repo`. The agent loop is unaffected (`executor.ts` always passed `workdir`
  explicitly), which is why it went unnoticed for so long.
- **The image creates `/home/loxaic/repo`.** Docker refuses an exec whose `WorkingDir` is
  missing, so once every exec defaults to the workdir, the *first* one — the clone that fills
  it, or the mkdir standing in for it — would fail without this. Creating it in the image is
  what makes the default unconditional rather than true-after-some-other-call. Changing the
  Dockerfile changes the content-hash tag, so this rebuilt itself exactly once, as designed.
- **No `node-pty`, and that is not a shortcut.** A PTY on *our* side would be a native module,
  and the packaged desktop runs both the server and the executor under Electron's own Node with
  `npmRebuild: false` — a binding built for system Node does not load there. So: a **container**
  session gets a real PTY (Docker allocates it *inside* the container, costing us no
  dependency), and **host and executor** sessions are bash over plain pipes.
- **The client is told which it got** (`terminal.ready {tty, workdir}`) rather than left to
  infer it. A pipe session has no prompt, no echo and no colour, so an emulator pointed at one
  looks broken; the panel says so in a sentence and line-edits locally instead. Local echo
  happens **only** when `tty` is false — a real PTY echoes for itself, and doing both shows
  every keystroke twice.
- **Input is raw in both directions.** The protocol used to append `"\n"` to every
  `terminal.input`, which silently turned each frame into a submitted line: that corrupts arrow
  keys, Ctrl-C, and anything typed a character at a time. `sandbox-ws.test.ts` splits one
  command across two frames, which is the only way to state that from outside.
- **`terminal.error` rides as a message, not a close reason.** A WebSocket close reason is
  capped at 123 bytes and a machine name can be 64 of them; the code (`4503` for an offline
  machine) is for the client, the sentence is for the person. An offline *executor* is
  distinguished from a gone workspace by asking the registry, so "your machine is offline" is
  never rendered as "not found".
- **Executor terminals stream over the executor's existing socket**, keyed by a `terminalId`,
  beside the request/response `call` path — a shell is a conversation, not a question. Opening
  one requires an approved directory, re-checked at open time. Where the shell goes *afterwards*
  is not bounded and does not need to be: `exec` already runs arbitrary commands on that machine,
  which is exactly what "Direct — commands run as you, with no sandbox" says in the chooser. The
  roots decide where work happens, not what a shell the owner is typing into may reach. A lost
  server connection closes every shell — a server that has gone away must not leave bash
  processes running on someone's laptop.
- **The panel holds a socket only while it is open**, and never *creates* a workspace: it opens
  into the one the tool loop already made (a paused one is resumed, which is what someone
  opening a terminal after lunch wants). Opening a terminal is not a reason to start a container.
- **Client: xterm on web/Electron, a text view on native.** `@xterm/xterm` has no React or
  React Native peer at all, so it cannot pull in a second React island (the `nativewind` hazard
  above); its CSS import emits its own small bundle in the Expo web export. The **DOM renderer
  is the default and the canvas/WebGL addons are deliberately not loaded**, so what is on screen
  is real DOM text — selectable, readable by a screen reader, and assertable by a test. Both
  panels carry a line input as well (`agent.terminal.input`): it is the only way in on a touch
  screen or a pipe session, and it is what the e2e drives, since a hidden textarea inside an
  emulator is not something to select on.
- **`sandboxImageReady()` checks the current *tag*, not the name.** Tags are a content hash, so
  right after a Dockerfile change the old image is still present while the one the suite needs
  has never been built — precisely when a name-only check would wave it into the multi-minute
  build the helper exists to avoid. Editing the Dockerfile for #62 is the first time that came up.
- **`pwd` reports the physical path.** macOS puts temp directories under a `/var` →
  `/private/var` symlink, so a host-provider test comparing `pwd` against `handle.workdir`
  is asserting on that symlink rather than on anything it meant to. Compare against a
  `realpathSync`, and keep the logical path for what `terminal.ready` reports — they are
  genuinely different answers.

### Electron

- **Instance mode lives in `<dataDir>/config.json`** (`supervisor/config.js`), read by both
  `main.js` and `headless.js` — they already share `defaultDataDir()`, so a machine set up
  through the GUI restarts headless unchanged. **Absence of that file is the only first-run
  signal there is**: no config means the window opens on onboarding and *no stack starts*.
  Anything that creates a data dir without a config (the self-contained e2e harness, a
  packaging script) must seed one or it will land on onboarding.
- **Env and flags still outrank the stored mode.** `--remote` / `LOXAIC_REMOTE_URL` /
  `TSNET_TARGET` / the `EXPO_PUBLIC_*` probes / a dev server on `:4000` are all "this launch
  was told exactly where to point", and they are checked before config.json. The e2e suites
  and every scripted workflow depend on that ordering — don't reverse it.
- **Three modes.** `solo` (this machine only, loopback, any `SANDBOX_MODE`), `host` (serves
  others, **container sandbox required**), `client` (no local stack). Solo is forced to
  loopback in `buildConfig` regardless of what the caller asks for — a solo instance
  listening on the LAN would be a host that never registered as one.
- **`instanceId` is stable across mode changes.** It is this machine's primary key in the
  `hosts` table, so regenerating it on a Solo→Host switch registers the same machine twice.
  Detach deliberately drops it — re-joining is a fresh registration, and a stale id would let
  the machine claim a host row in a cluster it has left.
- **`BETTER_AUTH_URL` is derived from the advertised URL, never pinned to loopback.**
  better-auth builds its callback URLs and cookie domain from it, so a host serving LAN
  clients while claiming `localhost` rejects every one of them. `TRUSTED_ORIGINS` and
  `ADMIN_EMAILS` pass through for the same reason: on a host they stop being deployment
  trivia and decide who can connect and who administers it.
- **Database credentials never go in config.json** — it is read by the renderer and safe to
  log. An external database's password lives in `secrets.json` (0600) beside the auth secret,
  and the supervisor injects it into the URL at spawn time.
- **The IPC contract is the app's only one** (`loxaic:getState/setMode/probeEngine/
  probeHost/testDb/detach`, the executor's `loxaic:executor.setSession/getState/removeRoot`
  and `loxaic:pickDirectory`, plus pushed `loxaic:stackState` and `loxaic:executorState`).
  Every channel is a fixed name and none takes a path or command from the renderer —
  `pickDirectory` opens the native dialog and `removeRoot` only accepts a path already on
  the list. The `stackState` listener is
  wrapped in `preload.cjs` so the renderer never receives Electron's `IpcRendererEvent`,
  which carries a live `sender` handle back into the main process.
- **A mode switch stops the old stack before starting the new one.** Both bind the same port,
  and the embedded Postgres data directory has exactly one legitimate owner.
- Never `loadFile()`/`file://` for the packaged build — expo-router's client-side routing
  needs the History API and every asset path is absolute (`/_expo/...`), both of which
  break under `file://`. Use `electron-serve`'s `app://` scheme (already wired in
  `apps/desktop/src/main.js`).
- There's no server at the renderer's origin (`app://` in prod, `localhost:8081` in dev),
  so unlike the mobile/web builds Electron can't assume same-origin. The main process
  resolves the real API URL and hands it to the renderer via a `contextBridge` preload
  script (`window.loxaic.apiBaseUrl`) — see `apps/mobile/lib/endpoint.ts`.
- **`"asar": false`** in `apps/desktop/package.json`'s electron-builder config, deliberately.
  Electron patches `child_process.execFile` to transparently read out of `app.asar`, but not
  `spawn` — and `embedded-postgres` `spawn`s `initdb`/`postgres` from paths its own package
  exports (no custom-binary-dir option), while its postinstall also creates symlinks that
  asar-packing would silently drop. The app's own source is tiny (a handful of files), so
  nothing meaningful is lost by shipping unpacked.
- **`LOXAIC_LISTENING <port>`** is a stdout handshake line the bundled server prints once
  `app.listen()` resolves (`apps/server/src/index.ts`) — the desktop supervisor
  (`apps/desktop/src/supervisor/server.js`) greps for it via `readline` instead of polling
  `/health`, mirroring the `tsnet-proxy` sidecar's own `LISTENING <addr>` handshake. Don't
  remove or reformat that `console.log` without updating the supervisor.
- **Release build vs `pnpm dev` never collide on one host, by construction**: the
  self-contained app defaults to port `4100` (`LOXAIC_PORT`) with an embedded Postgres on
  an ephemeral localhost port, data under the platform user-data dir; the dev stack keeps
  `4000`/`5432`/compose volumes. The packaged app never reads the repo's `.env` — its child
  env is built entirely by the supervisor. See `docs/DEPLOY.md`'s ports/data-dir table.

### The mock scenario engine, and a real lamport-collision bug it found

- **`apps/server/src/inference/mock-scenarios.ts` drives multi-step tool calls in one turn**,
  which `MOCK_TOOL_TRIGGERS` (one call per turn, by design) cannot. `MOCK_SCENARIOS_FILE` (a JSON
  array of `{match, steps: [{tool, args}], finalText}`) is read at call time and cached by path;
  `scenarioDecisionFor(prompt, toolNames, stepIndex)` matches `match` against the prompt and
  returns the step at `stepIndex` — the count of tool messages the current turn already holds,
  computed once in `mockStream` and handed in rather than recomputed, so the two can never
  disagree about which step an iteration is on. A step **bypasses** the single-call rule
  entirely (that bypass is the reason a scenario exists) but still only fires when its tool is
  actually offered, matching the ordinary trigger rule — a scenario written against a disabled
  tool falls through to generic mock behavior instead of calling a tool nothing asked for. Once
  every step has run, `finalText` replaces the generic `"[Mock] Done. The tool returned: …"`
  wrap-up.
- **Finding this needed a real prompt-prefix bug fixed first.** The first scenario canary (two
  `todo_write` steps in one turn) failed `prompt-prefix.test.ts` — not because of the scenario
  engine, but because `runToolLoop` gave each iteration's assistant and tool-result message
  `lamport: Date.now()` independently. Two inserts from the *same* run landing in the same
  millisecond — routine for a tool with no real work to do, like `todo_write` or a scripted
  scenario step — collide, and `loadHistory`'s `ORDER BY lamport, createdAt` breaks the tie
  arbitrarily rather than by insertion order, occasionally handing the next turn's replay the
  same two messages swapped. No prior test caught this because nothing before had exercised two
  real tool round-trips in one turn with negligible latency between them — the single-call rule
  made that impossible outside a scenario. Fixed by `monotonicLamport(previous, now)` in
  `engine.ts`: `Math.max(now, previous + 1)`, threaded through a per-run counter so two inserts
  from the same run can never tie. Deliberately scoped to just those two insert sites — it says
  nothing about `chatRun.ts`/`agentRun.ts`'s own `Date.now()` lamports or the cross-device LWW
  semantics `packages/sync`'s `resolveLWW` relies on, which compare lamports from genuinely
  different, slower-paced actors.
- **The mock lane's realistic specs (`agent-bugfix.spec.ts`, `agent-new-project.spec.ts`) run in
  auto mode** so the scenario's write tools (`bash`, `fs_edit`, `fs_write`) never block on an
  approval tap — a scenario is defined by needing several tool calls to run unattended in one
  turn. They do **not** turn `SANDBOX_ALLOW_NETWORK` on globally in `standup.ts`, even though
  `agent-bugfix.spec.ts` needs it to clone: doing so would 409 every other spec's own
  `patchSandboxSettings`/`resetSandboxSettings` calls (env-pinned settings are read-only) and
  would break `agent-github-workspace.spec.ts`'s and the sandbox specs' network-off/degraded
  assertions. It stays the established per-spec toggle-in-`before`/reset-in-`after` pattern
  `agent-git-actions.spec.ts` already used.
- **`standup.ts`'s "never reuse a running server" refusal now covers the mock lane too**, not
  just `E2E_REAL_MODEL=1`. A health check cannot prove a reused server was wired with *this*
  run's `GITHUB_API_URL`, `MOCK_SCENARIOS_FILE`, or sandbox network/extra-hosts settings — it can
  only tell mock from real. `E2E_NO_STANDUP=1`'s early return (bypassing `ensureServer()`
  entirely) is unaffected and stays the documented way to point a run at a server on purpose.
- **The real-model lane's `E2E_SANDBOX_SEED_DIR` hook is gone** — `apps/server/src/sandbox/
  seed.ts` and its call site in `sandbox-manager.ts` were deleted. `real-model-build.spec.ts` now
  clones `fixtures/seeded-app/` through the same GitHub-workspace path the mock lane's specs use
  (repo id 3 in `mock-github.ts`'s catalog; `git-server.ts`'s fixture map gained a `seeded-app`
  entry) instead of a server-wide flag that pre-populated *every* sandbox any user created —
  latent, but only ever harmless because this suite never ran two things at once.
- **A real-model spec must check its pass bar *after* `waitForRunDone`, never by polling the
  target command and returning the instant it exits 0.** `real-model-bugfix.spec.ts` hit this
  directly: polling `node --test` and declaring success on the first passing run raced the
  model's own next step (`git commit`) — an external poller sharing the sandbox can observe the
  tests passing after the model's own test run but before its commit, so the check would pass a
  turn the model hadn't actually finished. This is a harness bug, not a finding about the model;
  every real-model spec now waits for the whole turn to end first and checks its exec-API assertions once.
- **New testIDs**: `agent.inspector.panel` (the wide `Box` and narrow `ActionsheetContent` that
  wrap `InspectorBody` — there was previously no way to wait for the panel itself, only its
  toggle button), `agent.inspector.changedFiles.count` (the "Changed Files (N)" heading — was a
  bare `Text` with no testID), and `chat.toolCall.<callId>` / `chat.toolCall.result` on
  `ToolCallCard` (root box keyed by the tool call's own `callId`; the diff/plain-result
  `ScrollView`, whichever renders).
- **A stale `apps/mobile/dist` web export is invisible until you look for it.** `ensureServer()`
  reuses a healthy server and `ensureWebExport()` reuses an existing export unless
  `E2E_FRESH_WEB=1` — so a spec asserting on a testID just added to `apps/mobile` can fail with
  "still not displayed" while a screenshot taken at the same failure shows the feature rendering
  *correctly*, because the served bundle predates the change. The symptom (`isDisplayed()` false,
  `data-testid` absent from the DOM, feature visibly working in a screenshot) means "rebuild the
  export," not "debug the component."

### Stopping a run

- **A stop is only as good as the places that check the signal.** `stream.stop` calls
  `run.abort.abort()` and nothing else; every part of the loop that can block has to notice.
  Two did not, and between them made "the stop button does nothing" the *ordinary* experience
  (#113): `waitForApproval` settled only on approve/deny or the five-minute
  `APPROVAL_TIMEOUT_MS`, so a stop at a permission prompt — manual mode, the default — parked
  the run for up to five minutes; and the per-call loop never re-checked, so a stop during a
  batch still ran every remaining call. A real session issued **five calls in one assistant
  message** and took 6m39s over them.
- **Tool calls in one message run in series, so abort is checked per call, not per iteration.**
  A skipped call still emits and persists a `tool_result` saying it was stopped — an
  assistant `tool_call` with no partner is the orphan case `loadHistory` has to strip, and
  most backends reject it outright.
- **Aborting at an approval unwinds through `slot.yieldWhile`, not through the skip path.**
  The approval hands the inference slot back; re-entering the queue for an aborted run throws
  `RunSlotAbortedError`, which ends the turn before any tool executes — so that run keeps its
  calls with *no* results at all, which is the orphan case again and is why the stripping
  matters. Do not "fix" it by persisting partial results there; the run is over.
- **What is still not cancellable is an in-flight `exec`.** Killing a running `bash` inside a
  container means teaching all three providers to cancel, which this did not do. The bound is
  therefore one tool call (`bash` is capped at 60s), not a whole batch, and not five minutes.
- **`stopping` is a client-side run state with no server counterpart.** The run really is
  still running until its stream ends; the state exists because pressing Stop changed nothing
  on screen, so a correct-but-not-instant stop looked broken. Keyed by conversation id (not a
  boolean) so switching threads and back still shows it, and cleared by `clearStream` — the
  stream ending is the only honest end, covering a stop that landed, a run that finished on
  its own first, and an error. `handleStop` with no tracked stream now says so instead of
  returning silently, which was indistinguishable from a dead button.
- **The mock's slow path honours the abort signal**, because `liveStream` passes it to `fetch`
  and a mock that slept through a stop would make the mock lane the one place where stopping
  mid-response does nothing — exactly the bug under test.
- **A mock scenario step may carry several `calls` in one assistant message.** Nothing else in
  the suite can produce a batch, and the per-call abort check is untestable without one. Every
  call in a step must be offered or the step does not fire — a half-fired batch is one the
  fixture never described.
- **Testing this needs a genuinely slow tool, so the batch case is Docker-gated** (`bash` with
  `sleep`, `it.skipIf(!dockerReady)`). It is also keyed on the sandbox row appearing rather
  than a wall-clock sleep: a fixed 2s wait passed alone and failed in a full suite run, where
  Docker is contended. It asserts *nothing behind the stop ran* rather than an exact count of
  skipped calls, because whether the stop lands before or during the first call is a real race
  and both outcomes are correct.

## Conventions

- pnpm workspaces + Turborepo; packages scoped `@loxaic/*`; TypeScript strict.
- Minimal changes; match existing file style; don't add deps without a reason.
- Ports (dev): server 4000, inference 4002, ntfy 4003, Postgres 5432, Expo web 8081.
  Self-contained desktop app (a separate deployment, coexists with dev on one host): server
  4100 (`LOXAIC_PORT`), Postgres on an ephemeral localhost port — see `docs/DEPLOY.md`.
- **Semantic gluestack tokens only** for UI colors (`text-foreground`, `bg-primary`, etc.)
  — never numbered Tailwind colors (`gray-500`) or raw hex in className. `react-native-svg`
  can't resolve CSS custom properties, so SVG fills/strokes are the one exception: literal
  hex is correct there (see `ContextRing`, `TokensChart`).

## Theme system

- **Preference hook:** `apps/mobile/hooks/useTheme.ts` — `useThemePreference()` returns
  `[pref, setPref]`, `pref: 'light' | 'dark' | 'system'`. Persistence key: `loxaic-theme`.
  Feed the value into `GluestackUIProvider`'s `mode` prop.
- **Tokens:** Tailwind v4 CSS-first config in `apps/mobile/global.css` (`@theme inline`,
  `@variant light`/`@variant dark`) — no separate design-tokens package. Dark is the
  design default. UniWind applies the active variant at runtime via `Uniwind.setTheme()`.
- The original static prototype under `design/` is a historical reference for the palette
  and layout, not something anything imports or builds against anymore.
