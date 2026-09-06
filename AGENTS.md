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
  `apps/server/src/agent/sandbox-manager.ts`. An idle reaper stops them after 30 minutes.
  A sandbox row (`sandboxes` table) records which provider it belongs to; a mode switch
  mid-deployment makes old rows unusable rather than silently reattaching to the wrong kind.
  A crash between `provider.create` and the row insert leaves a container no row claims, so
  it is only findable by its `loxaic.sandbox` label; `sweepOrphanSandboxes()` does that
  sweep at boot (container provider only — host sandboxes are plain directories), alongside
  the stream log's own orphan recovery.
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
  probeHost/testDb/detach`, plus a pushed `loxaic:stackState`). Every channel is a fixed
  name and none takes a path or command from the renderer. The `stackState` listener is
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
