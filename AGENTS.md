# AGENTS.md

**This file is the source of truth** for architecture, conventions, and gotchas.

## Project in one line

Self-hosted, multi-user AI platform — an open-source alternative to hosted assistants and
coding agents such as Claude and Claude Code: llama.cpp
inference, a real agent tool-calling loop with sandboxed execution, one universal Expo
frontend (iOS/Android/Web/Electron), reachable remotely over Tailscale (or your own
reverse proxy).

## Layout

- `apps/server` — Fastify API + WS (chat + agent tool loop) + routines scheduler + agent sandbox providers (`src/sandbox/`)
  + the managed llama.cpp runtime and HuggingFace downloads (`src/llama/`)
- `apps/mobile` — the one frontend (Expo + expo-router + gluestack-ui v5), targets iOS/Android/Web
- `apps/desktop` — the deployment artifact: an Electron GUI, a `--headless` entry (`src/headless.js`), and a
  service supervisor (`src/supervisor/`) that brings up an embedded Postgres + the bundled server so the app
  is self-contained with no Docker/Postgres install required; also embeds a Tailscale sidecar
- `packages/agent` — tool definitions, permission-mode logic (shared by server + client); the wire event
  union (`StreamEventKind`) lives in `packages/types` instead
- `packages/api-client` — typed REST + WS client used by `apps/mobile`
- `packages/db` — Drizzle schema + re-exported query operators
- `packages/sync` — fork/conflict detection for the offline sync protocol
- `packages/types` — shared types (`ContentBlock`, `Result`, etc.) and the stream wire protocol
  (`src/stream-protocol.ts`)
- `packages/config-ts` — shared tsconfig bases
- `infra/` — Dockerfiles, the `tsnet-proxy` Go module (Electron's embedded Tailscale sidecar), Tailscale Serve config
- `design/` — the original static HTML/CSS prototype; historical reference only, not built or imported by anything

There is no separate web app and no separate UI package — `apps/mobile`'s Expo web
export **is** the web app, served same-origin by `apps/server` (see docs/DEPLOY.md, "Website —
served by the Loxaic server").

## Commands

```bash
pnpm install
pnpm dev                          # turbo dev, unfiltered: server (4000) AND the desktop app — see below
pnpm dev --filter=@loxaic/server  # just the API server, which is usually what you want
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

**`pnpm dev` is not server-only.** `turbo dev` is unfiltered and runs every package declaring a
`dev` script — which is two of them: `apps/server` (`tsx watch`, port 4000) and `apps/desktop`
(`electron .`, bringing up its own embedded stack on 4100). Mobile is absent because it has no
`dev` script at all, not because turbo excludes it, so `pnpm --filter @loxaic/mobile start` (or
`web`) remains a separate command. The desktop app loads its renderer from Metro on 8081 and
**fails with `ERR_CONNECTION_REFUSED` without ever retrying** when Metro is not already up,
leaving a blank window that waiting does not fix — so start Metro first, or use
`pnpm dev --filter=@loxaic/server` when the API server is all you want. Running the unfiltered
form beside an existing `pnpm --filter @loxaic/desktop dev` gives you two desktop instances
contending for 4100, which is easy to do by accident and confusing to diagnose.

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

## Testing: every PR, unit and end to end

**Every pull request carries unit tests and end-to-end tests for what it changes, wherever
either is possible.** Nothing may depend on a person remembering to try it by hand: a check
done once, manually, protects nothing after the PR merges, and the next change undoes it
silently. Writing the tests is the implementer's job (human or AI) — the harness already
exists, so this is normally a spec file, a helper and a few `testID`s, not new infrastructure.

- **Unit tests pin the rules**: every decision a module makes, including the edge cases,
  in the package's own vitest suite. Pull the logic into something pure (a reducer, a
  function of its inputs) when that is what makes it testable — `connectionMonitorCore.ts`
  and `apps/desktop/src/power.js` are the pattern.
- **End-to-end tests cover every scenario a user can get into, on every platform where it
  exists** — not only the happy path, and not only the platform that was convenient. Work out
  the situations first (the server down, slow, or coming back; the phone locked, switched away
  from, or opened from cold; the laptop asleep; a dialog open when it happens), then write a
  case for each, both ways: the one where nothing should be said, and the one where something
  should. A platform-only situation gets a platform-only spec: `src/specs/native/` for iOS and
  Android (locking, backgrounding, cold starts), `src/specs/electron/` for the desktop (sleep,
  the main process), `src/specs/browser/` for web.
- **Reach the real thing.** Drive the OS event the user would cause (`mobile: lock`, the
  real `powerMonitor` through the Electron service's bridge) and take the server away for real
  (`helpers/server.ts` freezes the run's server process). A stub that imitates the trigger
  tests the stub.
- **Prove a new test can fail**: run it once against the code before the fix, or with the fix
  reverted, and see it go red. A test that passes either way is not coverage.
- **"Where possible" is a high bar.** If a scenario genuinely cannot be automated (real
  hardware, a paid account), the PR says which one, why, and how it was checked instead — never
  silently. "It was slow to set up" and "the lane is flaky" are reasons to fix the harness,
  not to skip the test.
- **Every feature PR also carries screenshots** showing the behaviour working, captured by
  the specs (below).

- **Tests** live in `apps/e2e/src/specs/`. Select by `testID` using the helpers in
  `src/helpers/` — never by CSS class, text position, or list index (the message list is
  inverted and virtualised, so position is not stable). New interactive elements need a
  `testID` following the convention in Gotchas above.
- **Screenshots** are captured with `shot('name')` at the moments that actually evidence the
  feature — the state that would look wrong if it regressed, not just the happy end state.
  Failures are captured automatically.
- **Screenshots are never committed.** `apps/e2e/artifacts/` is gitignored; embed the PNGs in
  the PR description instead, straight from that directory.
- If a change genuinely isn't user-visible, say so in the PR rather than skipping the section —
  it still needs its unit tests.

## Pull requests

**Every PR description ends with a section called "What you need to do".** It is a numbered
checklist of the actions only the repository owner can take, in the order they have to
happen. Nothing anywhere else in the description is a request — that section is the entire
ask, and if it is empty it says so: "Nothing. Merge when CI is green."

Each item is one line and answers three things: **the exact command or click**, **what should
happen when it works**, and **why it is needed**. Name the file or URL. No item may be
"review this" or "consider whether" — a decision belongs there only when it has named
options and a recommendation.

Say what will fail if an item is skipped, when skipping it fails silently. Most of these
steps are credentials, and a missing one usually surfaces days later as "the release went out
and nobody got it".

Keep the rest of the description short: what changed, what was verified, what was not. The
reasoning goes in this file and in code comments, where it is read again; a PR description is
read once.

**Answer a review finding on its own thread, not only in a top-level comment.** The thread is
what gets resolved, and an inline finding answered somewhere else leaves the reviewer holding
an open thread with no visible response. Reply on every thread — including the ones you are
declining, with the reason — and leave resolving them to whoever opened them. A top-level
comment is for the summary across findings, and is never a substitute for the per-thread
replies.

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
  "fingerprint"` means a native or dependency change — an SDK bump included — starts a fresh
  EAS Update runtime, and an update published for it reaches no existing binary (see
  "Releases and over-the-air updates" below). Upgrade with `npx expo install expo@^NN --fix` run
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
  height. `McpServerModal.tsx` carried only the `max-h-[85%]` half until #167, and the missing
  half cost more there than an off-screen row: the Add form renders two fields the Edit form does
  not (Slug, Transport), which pushed the encrypted **Secrets** box past the fold with nothing
  able to scroll to it — leaving the plaintext **Environment** box as the only field still
  reachable for a credential, and a real GitHub PAT was stored in the clear that way. Nothing
  about the component tree changes, only whether the total content height crosses the fold, so no
  snapshot of static props can catch it — and neither can `isDisplayed()`/`waitForVisible`, which
  WebDriver reports true for a below-the-fold element, so a visibility assertion passes with the
  bug and without it. `mcp-servers.spec.ts` therefore asserts *reachability*: an ancestor whose
  computed `overflow-y` is `auto`/`scroll` with `scrollHeight > clientHeight`, then a
  bounding-rect check (not `scrollTop`, which still moves on an `overflow: hidden` element and
  would prove nothing). `scrollEnabled` is a caller override on `<ModalBody>` (the creator
  spreads `{...props}` after its own hardcoded default, so passing the prop wins) — **any modal
  expected to grow past a handful of rows needs both**, not just the height cap.

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
  `auth.api.getSession` directly does not — **which is why `GET /api/auth/session`, served
  outside the middleware so a user who must change their password can still learn who they
  are, checks `isBanned` itself** and answers 401 `account_suspended`. It is the route a client
  asks when its socket is refused (4001) and at every launch; skipping the ban there told a
  banned client all was well, and it reconnected forever under a banner blaming the server.
- **`must_change_password` is enforced in the same two places, for the same reason** — see
  "Passwords" below.
- **Postgres/postgres.js returns `SUM()`/`AVG()` over `integer` columns as strings**
  (bigint/numeric precision preservation). Cast to `::float8` in SQL, not `::int` (avoids a
  32-bit overflow ceiling on lifetime token sums). Columns typed `real` parse natively.
- Migrations auto-run on server startup (`apps/server/src/db/migrate.ts`). Migration folder:
  `packages/db/drizzle/`. Run `pnpm --filter @loxaic/db db:generate` after schema changes.
- **A read without `orderBy` has no order — tests included.** Postgres returns heap order, and
  that is only insertion order until something disturbs the heap. A message row is inserted as
  `streaming` and then UPDATEd with its content, and an update writes a new row version wherever
  there is room. Under vitest's parallel workers another suite's `afterAll` deletes its rows
  mid-run, so the room is often *in front of* this conversation's rows. `step-checkin`'s "keep
  going" case read a conversation unordered and took `.at(-1)` as the final answer; about one
  full-suite run in seven, the final row came back first, while the test never failed alone.
  Reproduced by freeing heap space while a run was parked at its check-in, and fixed by ordering
  on `lamport, created_at`, the key the engine replays with. Anything positional (`.at(-1)`,
  `[0]`, "the last assistant row") needs an `orderBy`; `.find` by content does not.
- **Messages form a tree on paper and a list in practice.** Every row carries `parent_id` and
  the engine keeps `conversations.active_leaf_id` on the newest row, but nothing walks the
  tree: `loadHistory` replays rows in `(lamport, created_at)` order regardless of `parent_id`,
  `deleted_at` or the leaf, and the `forks` array `GET /v1/conversations/:id/messages` returns
  is read by no client. That holds only because the per-conversation run lock never lets one
  message get two children. Anything that creates a real in-thread branch must first make
  `loadHistory` walk parent links back from `active_leaf_id`, or both branches are
  interleaved into one prompt.

### Passwords

- **There is no mail transport, and a reset does not need one.** A forgotten password is reset by
  an admin (Admin → Users, `POST /v1/admin/users/:id/reset-password`) or by whoever runs the
  server (`dist/reset-password.js`, reached as `pnpm --filter @loxaic/server reset-password`,
  `docker compose exec server node dist/reset-password.js`, or the desktop's
  `--headless --reset-password`). better-auth's `requestPasswordReset` is unused: it hard-fails
  without `sendResetPassword`. The CLI is the only way back in for an admin who has forgotten their
  own, which is why it exists at all.
- **A reset sets `user.must_change_password`, and `auth/middleware.ts` refuses a flagged user
  everywhere** — `verifyToken` answers 403 `{ code: "password_change_required" }` and
  `resolveSessionFromToken` returns null, so sockets refuse too. What stays reachable is reachable
  *by construction*, not by an allowlist: `routes/auth.ts` (sign-in, session, token, sign-out,
  change-password) calls `auth.api.*` directly and never touches the middleware. A flagged user can
  therefore sign in, learn who they are, change their password and sign out, which is exactly what
  the client's top-level `/change-password` screen needs; the `(app)` layout redirects there
  because everything inside the shell would 403. Adding an `/api/auth/*` route that should *not*
  be reachable by a flagged user means authenticating it through the middleware.
- **The flag reaches clients through better-auth's `user.additionalFields`**, declared in
  `auth/index.ts`, so it is on the sign-in/sign-up response and `getSession().user` with no
  route of ours involved. `input: false` keeps a sign-up body from setting it.
- **A reset is only complete once the temporary password stops working, so change-password refuses
  `newPassword === currentPassword`** (`PASSWORD_UNCHANGED`, checked before the current password is
  verified). better-auth does not compare them, and without this the forced change could be
  satisfied by typing the temporary password twice, leaving the credential an admin read off a
  screen live. Found in review.
- **Revoking sessions did not close an open sandbox terminal.** `ws/sandbox.ts` authenticated once
  at open; a shell opened before a reset or a ban kept arbitrary execution in the workspace for as
  long as the socket lived, while three copy strings promised "signed out everywhere". It now
  re-checks the session on input (at most once per 5 s — a keystroke is a frame, and a lookup is a
  query, so not per frame as `ws/chat.ts` does) and every 60 s while idle, as `ws/executor.ts`
  does. A lookup that *fails* keeps the shell; only a session that resolves to nobody, or to
  someone else, drops it. Pre-existing; this feature is what made it load-bearing.
- **`auth/ban.ts`'s `isBanned` is the one ban predicate.** The admin user list once reported
  `banned === true`, badging "Suspended" accounts whose ban had expired and who signed in fine;
  it now selects `banExpires` and asks the same function the middleware does. Pure and separate
  from `middleware.ts` because route tests mock that module whole.
- **`POST /api/auth/change-password` always passes `revokeOtherSessions: true`, and that revokes
  the caller's own session too.** better-auth deletes every session and mints one replacement,
  returned as `token`. `session.tsx`'s `changePassword` stores it; a client that does not is
  signed out by its own password change, which looks exactly like a bug in the change.
- **`auth/password-reset.ts` is shared by the admin route and the CLI**, and the CLI bundles it,
  so it must never import fastify, the server entry, or `auth/index.ts` (the better-auth instance
  reads `BETTER_AUTH_SECRET` and the whole auth config at import). `cli/__tests__/isolation.test.ts`
  walks the import graph to hold that. It hashes with `better-auth/crypto`'s `hashPassword`, which
  is what better-auth's `ctx.context.password.hash` defaults to — true only while
  `emailAndPassword.password.hash` stays unset; customise it and the CLI's hashes stop verifying.
  `password-reset.test.ts` signs in with a temporary password to catch that drift. The CLI ends
  with `process.exitCode`, never `process.exit()`: stdout is asynchronous on a pipe, which both
  `pnpm --filter` and `docker compose exec -T` are, and `exit()` drops the unwritten line — the
  only copy of a temporary password whose reset has already committed.
- **The desktop's `--reset-password` opens the database through `supervisor/index.js`'s
  `openDatabase`**, the same function `startStack` uses, so it lands in the same database the
  server would. `startPostgres` adopts a running cluster from `postmaster.pid` (its `stop` is then
  a no-op), which is what makes it safe beside a running app. A Postgres `42703` from the CLI means
  the column does not exist yet: the server has to have started once on this version.
- **The admin user list is capped (200), newest first, searchable, and reports `total`.** Oldest
  first under a cap hid exactly the newest accounts, which are the ones most likely to need a
  reset; the dev database's 2,000-odd test users made that visible at once.
- **Booting a throwaway server install beside the dev stack destroys the dev stack's paused
  container sandboxes.** A fresh database claims no containers, so its boot orphan sweep removes
  every `loxaic.sandbox` container on the shared engine (the gap noted under "The orphan sweep only
  considers containers created before this process started"). Verifying the headless reset that way
  swept ten e2e leftovers. Stop, or accept losing, the other install's paused workspaces first.

### Inference

- **Set `MOCK_INFERENCE=true`** for dev without llama.cpp. Mock mode drives the full agent
  tool loop too — it emits a real (fake) tool call when the prompt mentions one, so the
  approval/deny/auto/planning paths are all testable without a GGUF.
- Real inference is the managed llama.cpp runtime ("Local models" below): the server installs
  and runs it, and an admin downloads models from HuggingFace in the app. There is no backend
  URL any more — `INFERENCE_BASE_URL` is converted once into an added provider at boot. Other
  backends are added providers. See `docs/RUNTIME.md` for what gets chosen on which machine.
- **Model requests go through `inference/transport.ts`, never the global `fetch`.** Node's
  built-in fetch is undici with a 300 s `headersTimeout` and `bodyTimeout`, and llama.cpp and
  LM Studio send **no response headers for a streaming completion until prompt processing has
  finished** — so any prompt that took over five minutes to evaluate was cut off by our own
  client. A beta turn on a 39k-token prompt died that way, the backend logging "Client
  disconnected" exactly 300 s after the request arrived and the server logging nothing. The
  transport uses an undici `Agent` and `fetch` **from the same npm `undici`**: an npm Agent
  handed to Node's bundled fetch is unreliable across undici majors, and the packaged app runs
  Electron 33's Node 20 (undici 6) while dev runs Node 24 (undici 7). Quick probes (`/props`,
  `/v1/models`) stay on the global fetch with their own short timeouts.
- **Both timeouts are `INFERENCE_TIMEOUT_CEILING_MS` (1 h), not 0.** Disabling them traded the
  cut-off for an unbounded stall: a backend that wedges after accepting the connection keeps
  the run, and its inference slot, forever — at concurrency 1 that queues every other
  conversation, and an automatic compaction has nobody to press Stop. Never lower it toward
  the old 300 s; `transport.test.ts` reads the real dispatcher's options to hold both lines.
  With the timeouts that long, **the stream reader is cancelled, not just released**, in
  `liveStream`'s `finally`: a read-from undici body is not cancelled on garbage collection, so
  an early exit (a mid-stream SSE error, a throw in the consumer) left the socket open and the
  backend generating for nobody.
- Network failures are rewritten into a sentence ("Could not reach the model server…") instead
  of "fetch failed". **The fallback names the error code only**: undici's own message carries
  the backend's `host:port`, and this sentence reaches every client on the conversation,
  shared viewers included. undici's timeouts run on ~1 s-resolution timers, so a test using a
  short one needs a delay of seconds, not milliseconds.

### Streaming (the stream log)

- **Clients never get a bare pipe.** Every chat, agent and compaction run writes its events to
  a sequenced stream log — `streams/broker.ts` over a `StreamLogDriver` — and a client reads
  it with `stream.subscribe {conversation_id, cursors}`: one folded `stream.sync` snapshot per
  run, then live `stream.event`s. A dropped socket therefore loses nothing; the client
  resubscribes. The wire types are `packages/types/src/stream-protocol.ts`.
- **`STREAM_BACKEND=memory` (default) or `redis`.** Redis with an unreachable Redis **fails
  boot** — there is no silent fallback to memory, since that would drop the durability resume
  depends on. Redis *stores*; it does not deliver: live fan-out is an in-process
  EventEmitter, which is the single-process assumption behind horizontal scaling. The desktop
  supervisor always runs `memory`, so a desktop crash loses in-flight output.
- **Retention is `STREAM_TTL_SECONDS` (default 86400).** Redis keys carry it as an idle TTL
  refreshed on each append; memory sweeps only *finished* streams idle past it, every 60 s.
  The TTL is a backstop — orphan recovery (`recovery.ts`) is the real cleanup: rows still
  `streaming` after a restart are finished as `error` (Redis rewrites only messages still
  `streaming`; in memory mode the 10-minute stale sweep is the whole story).
- **Deltas are coalesced (`STREAM_COALESCE_MS`, default 25); nothing else is.** Only
  `text.delta` and `thinking.delta` are buffered, and any other event flushes first, so order
  is preserved. A record is appended to storage *before* it is sent live, so a subscriber only
  ever sees stored events. `seq` is our own contiguous counter inside the record, never a
  Redis entry id.
- **Cursors decide whether to send, not what to read.** A subscribe always reads the run from
  seq 0 and folds a full snapshot; the cursor only skips a run the client already has
  (`lastSeq <= cursor`). Only the conversation's last three runs are considered, and a
  finished run is snapshotted once per socket — repeating a long finished run's snapshot on
  every subscribe saturated sockets and dropped the live events that mattered.
- **The handoff is tap-then-read** (`ws/delivery.ts`): the live tap attaches before the
  catch-up read and buffers what arrives meanwhile, and the subscription slot is reserved
  synchronously so two racing subscribes cannot double-deliver. Past 512 KB of unsent socket
  buffer, events are dropped and the client's gap detection resubscribes. `watchers.ts`
  announces new runs per conversation, which is how a second device learns of a run it did not
  start.
- **A caught-up cursor skips the snapshot of an active run, never its tap** (#231). The cursor
  says what this *client* has, not what this *socket* has, and a reconnect is a new socket.
  Skipping the whole run left a phone that came back from the background deaf to a run parked
  on an approval: a parked run emits nothing, so the cursor is always exactly caught up then,
  and the approval reached the server while its result, the next message and the next
  approval never reached the screen. That tap is attached **without re-reading the run**
  (`tapOnly`: read after the cursor, no fold), since it happens on every app switch and a long
  parked run's log is thousands of records. **A run that finished while the client was caught
  up is the other half** (found in review): `producer.end` writes no record, so the cursor still
  equals `lastSeq`, and the live `stream.end` died with the replaced socket — the client showed
  a finished run as streaming, Stop enabled, until a reload. The run a client's cursor names
  gets one snapshot per socket even when caught up (`forceSync`); a snapshot, not a
  `stream.end`, because the chat hook's `stream.end` clears the conversation whatever run it
  names, while both hooks check a snapshot's stream id. `delivery-reconnect.test.ts` and
  `approval-reconnect.spec.ts` hold it. The same moment is when a tap on Allow lands on a
  socket still closing, so **Approve and Deny close their dialog only once `trySend` says the
  answer went out** — as Stop and the check-in already did (#113).
### Reaching the server (the connection monitor)

- **One answer to "can the server be reached", for the whole app**, decided by
  `apps/mobile/lib/connectionMonitor.ts` (controller) over `connectionMonitorCore.ts` (a pure,
  unit-tested reducer) and published through `lib/connection.ts`. It used to be written by
  whichever screen was open: expo-router's `Slot` mounts only the focused screen, so the state went
  stale on every screen without a socket (all of settings) and read "online" on the agent screen
  while its socket was still connecting. The banner lived on three screens. Nothing asked the
  server itself, so a hung one — accepting connections, answering nothing, which is also what
  `kill -STOP` produces — was never noticed at all.
- **Three kinds of evidence, one authority.** Every REST request goes through api-client's
  `serverFetch`, which reports `answered` / `suspect` / `stalled` to an observer; each screen's
  socket reports `connecting` / `open` / `closed` (`trackSocket`); and a `GET /health` probe is the
  only thing that can call the server down. **A failed request never sets the state by itself**:
  our own server answers 502 when GitHub or HuggingFace is down and 503 from `/v1/cluster` during
  boot, and a rejected upload can be a file that failed to encode. `isUnreachableError` now means
  exactly "no answer" (`ServerUnreachableError`); it used to count a 404 wrapped in `McpApiError`
  as down.
- **Probes**: one in flight, 4 s timeout, backoff 1, 2, 4, 8 s then every 10 s, three failures in a
  row → `offline`, a heartbeat every 25 s while online and foregrounded. A failed probe beats a
  socket that says "open" (Chrome's offline mode and a stopped server both leave one open), and the
  monitor then has the hooks replace it. A socket closed with 4001 is a session problem, not the
  server's: `checkSession` re-asks, and a dead session signs out.
- **Grace periods depend on the cause**: 300 ms after a resume, 1.5 s for a socket a screen has just
  opened (a first connect over a tailnet relay routinely exceeds 300 ms, and a banner on every
  navigation would teach people to ignore it). Input waits for the whole window (`resuming`), but
  nothing is *said* (`showsDisconnected`). A resume with no socket tracked stays `online` and only
  probes, so a settings screen does not grey out on every app switch. An `epoch` bumped on each
  resume makes a probe armed before it irrelevant: iOS freezes JS in the background, so its
  timeout fires the instant the app returns and would read as a failure.
- **Only a return from `background` is a resume** (`appStateEvent`). `inactive` suspends nothing —
  Control Center, a call banner — and locking an iPhone reports `inactive → active → inactive →
  background` within a second and a half; counting that instant of `active` replaced every socket as
  the app went to sleep. Seen on the simulator with a log on the listener, not reasoned out.
- **On the desktop, the Mac sleeping, waking, locking and unlocking are the same two moments**,
  forwarded from Electron's `powerMonitor` (`apps/desktop/src/power.js`, pushed as `loxaic:power`).
  The page's visibility does not reliably change when a Mac sleeps with the window open, and nothing
  pings a socket from either end, so a laptop woke holding sockets that still said "open" to a server
  that had restarted or dropped them while it slept — the first send into one was lost, the #231
  failure on another platform. A wake counts only while the window is showing; a hidden window's
  own return does the resume, and `appStateEvent` makes the second of the two a no-op.
- **The socket hooks no longer listen to AppState** — the monitor owns the one listener and asks for
  replacement through `onReconnectRequest`, as it does on Retry, on a failed probe against an
  "open" socket, and when the server comes back (so the wait is not the hook's own backoff). The
  terminal socket is not tracked: its 4503 means the *machine* is offline, not the server.
- **One banner** (`ConnectionBanner`, `shell.offlineBanner`, Retry once offline) rendered by
  `AppShell` above the sidebar and every screen. Every Modal and Actionsheet renders through
  gluestack's portal, above the shell, so the banner sits under their backdrop — anything with
  server-backed buttons inside one carries a `DisconnectedNote`. The sidebar's status line reads
  the settled state (it does not flicker through a grace period) and the line under the user's
  name is the host the app is really talking to (`hostOf`, `useServerEndpoint`), never "local
  server" for a build's default address.
- **The gating rule**: every control that needs the server reads `useServerReachable()` and is
  disabled when it is false, on every screen; a handler that could race the change also checks
  `isOffline()`/`requireServer`; a failed request says `describeRequestError`, never the raw
  "Failed to fetch". **What stays enabled is what works without the server or is the way back to
  it**: the server address and its Test, Disconnect (both confirmations are `local` on
  `WarningConfirmModal`), theme, updates, tailnet settings, sign out, navigation, and reading what is
  loaded. A loader that could not ask keeps "could not ask" distinct from "none" — the GitHub setup
  form, "This routine is gone" and "No workspace yet" were all shown offline for things that
  existed — and asks again when the server is back.
- **Agent sends honour `trySend`**: `handleSend` returns whether the message went out and rolls
  back its optimistic bubble (or `pending-*` run) when it did not, the mode selector moves only if
  the server heard it, and a plan decision is **sent first and acted on after** — it used to close
  the panel and switch the model before sending, so a decision that never left looked made.
- **A launch waits at most 5 s to learn who is signed in** (`LAUNCH_SESSION_TIMEOUT_MS` in
  `lib/session.tsx`). A hung server accepts the connection and answers nothing, and the splash
  used to wait out the platform's own network timeout — a minute on iOS. Past the deadline the
  launch carries on as for an unreachable server: token kept, user unknown, and the user is
  fetched whenever the monitor says `online` and it is still unknown. Not on "recovered after
  failing": a server that was merely slow at launch never fails a probe, and the user would have
  stayed unknown (isAdmin false) until a restart. Found by the native cold-start e2e case.
- **e2e**: `server-unreachable.spec.ts` cuts the server from inside the page (stubbed `fetch` for
  `/v1|/api|/health`, sockets pointed at a dead port) and checks the banner on chat, agent and a
  settings screen with their controls disabled, then recovery; `approval-reconnect.spec.ts` holds a
  new socket's `open` back to make a reconnect slow, and watches the DOM with a `MutationObserver`
  for a flash — on localhost a reconnect takes a few milliseconds, so a polling check passed with a
  zero grace period. `native/connection-lifecycle.spec.ts` (iOS and Android) locks the device,
  switches away, cold-starts, and sits on a screen, each with the server up and frozen
  (`helpers/server.ts`, `SIGSTOP` on the run's server); `electron/sleep-wake.spec.ts` emits the
  real `powerMonitor` events in the main process. **Minimising an Electron window cannot be
  tested on macOS**: Chromium's occlusion tracker is the only route from it to the page's
  visibility, it races every other window on the screen, and the lane turns it off
  (`--disable-backgrounding-occluded-windows`) because it also made unrelated specs time out.

### Thread history is paged (#213)

- **`GET /v1/conversations/:id/messages` returns the newest page, and `?before=` the page older
  than it** (`conversations/history-page.ts`, shared with the admin transcript). Both routes used
  to take the *oldest* rows (`ORDER BY created_at LIMIT n`), so a thread past 200 rows reloaded
  without the replies anyone came back for. Pages are cut in the engine's replay order,
  `(lamport, created_at, id)` — `created_at` alone put two same-millisecond rows in either order.
- **A page starts on a user message**, so it holds whole turns: the limit is a floor, and the page
  grows back to the turn's start. That is what keeps a `tool_call` and its `tool` rows on one page
  (the client joins them by call id and cannot join across pages), and why the newest page always
  holds the whole last turn. A turn past `PAGE_CEILING` (1,000 rows) is cut at the ceiling, moved
  forward past any `tool` rows at its old edge so a call still never loses its results.
- **The cursor is a row id, resolved in SQL.** `created_at` has microsecond precision in Postgres
  and millisecond precision in a JS `Date`; a timestamp round-tripped through the client compares
  wrong. A cursor from another conversation, or not a uuid, is a 400.
- **A snapshot can describe a run older than anything loaded**, and appending it put that run
  *below* the newest reply — seen on iOS, where a reconnect snapshots the conversation's last three
  runs. `message.start` (and so every snapshot message) now carries the row's `lamport`;
  `applySnapshotToMsgs` places a missing message by it, and leaves out one older than the loaded
  page when there is history left to scroll to (it arrives in order from the older page). No
  `lamport` — an older server — appends, as before. A finished run cannot be skipped on absence
  alone: it may equally be a *newer* run this device missed while disconnected.
- **react-native-web reports drags for touch only.** A wheel, a trackpad, a scrollbar drag and
  the keyboard all fire no `onScrollBeginDrag`, so `MessageList` believed a desktop reader was
  always at the newest message and snapped back on every content-size change — a streamed token,
  or an older page arriving at the top, which made scroll-back impossible. On native only a drag's
  scroll events count (the list's own scrolls must not latch stickiness off); **on the web every
  scroll event counts**, because the list's own scrolls only ever go to offset 0, which reads back
  as "at the newest message" anyway. The first fix counted a window after each *wheel* event and
  so fixed the wheel alone — found in review. `thread-history.spec.ts` scrolls the agent case with
  **real wheel input** and the chat case by setting the scroll position with neither wheel nor
  touch (what a scrollbar or the keyboard looks like to the page); the latter fails on the
  wheel-only version. Neither uses `scrollIntoView`, which puts its target on screen whatever the
  list does next and so passed while a real reader could not get past the first page.
- **The newest page is always applied** (`withNewestPage` in `lib/historyPages.ts`): merged in
  front of a live run that filled the thread first, rather than skipped. Skipping it made the
  page's cursor wrong — paging back from a page never shown skipped every row in between — and
  deciding whether to record the cursor from a ref only moved the problem, since a ref and a
  state update can see different threads (found in review). Applying the page every time also
  means a thread opened while a run is live shows its history, not only the run.
- **A late admin transcript response changes nothing.** `openDetail` checks the selected row after
  its await; without that, a slow conversation's response installed its transcript *and cursor*
  under another selected row, and "Load older" sent that cursor against the wrong conversation for
  a 400.
- **Follow-newest re-arms on the newest message's id, not the count** — prepending a page changes
  the count too.
- The offline cache (`lib/message-cache.ts`) keeps only the newest 100 messages per thread, so
  older pages are never written to it.

### Tool loop (Chat and Agent both)

- **Chat and Agent share one tool loop** — `apps/server/src/streams/runs/engine.ts`'s
  `runToolLoop`, parameterized by surface and base prompt. The two starters
  (`chatRun.ts`, `agentRun.ts`) only differ in conversation setup and which system prompt
  they pass in; `agentRun.ts` additionally exposes planning/manual/auto modes. **Chat has no
  mode selector** — it always runs manual-mode approval semantics (write builtins and
  non-allowlisted MCP tools ask; read-only builtins run free).
- **The three agent modes, exactly** (`toolsetRequiresApproval` in `mcp/registry.ts`):
  `planning` does not offer write tools at all and adds a planning system prompt; `manual`
  asks for write builtins and non-allowlisted MCP tools; `auto` asks for no builtin — but an
  MCP tool still asks until the user allowlists it. There is no denylist.
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
  execution and bypass `mode: "off"` entirely. Derive the kind from `getSandboxMode()`. Its
  `conversation_id` is likewise a claim — the tool loop adopts whichever row names a
  conversation — so it requires **owner** role on that conversation (404 otherwise), and
  `createEntry`'s recovery lookup is scoped to the conversation owner's rows as the second lock.
  Before both, any signed-in user could plant a sandbox they owned under someone else's
  conversation and have that person's agent (and, via `routes/git.ts`, their PAT) run inside it.
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
- **Only `SandboxGoneError` may become `destroyed`.** `SandboxHandle.start()` is the manager's
  "paused or gone?" discriminator, and `sandbox/errors.ts` is the one answer it may give for
  "gone": a container 404, a host directory that is missing, an executor's un-approved or
  removed sandbox (carried across the wire as `code: "gone"`). Every other failure — the engine
  unreachable, the machine offline, a timeout — propagates as itself and the row stays exactly
  as it was. `resume()` used to swallow everything, so an engine hiccup marked a paused
  workspace destroyed and the boot sweep then deleted the container still holding the work.
  `resume-failure.test.ts` mocks a provider to prove the split.
- **Waking a paused sandbox is a cap transition.** The per-user cap counts *running* rows, so
  resuming is the thing that spends one; both resume paths (`createEntry`, `attachRunningSandbox`)
  reserve against it, or the cap was defeatable by cycling (pause N, create N, resume N).
  `attachRunningSandbox` also registers the woken sandbox in `active` — otherwise a workspace
  resumed through the terminal or the files API was invisible to the idle timer for the life
  of the process — and the boot sweep reconciles a `running` row whose container merely exists
  to `stopped`, rather than leaving it counted at the cap forever after a reboot.
- **A sandbox row records the network it was created with** (`limits.network`, written by
  `createEntryReserved` and `POST /v1/sandboxes` from `networkFor(kind)`). A container's
  `NetworkMode` is fixed for its life and a paused one resumes with it, so the agent screen's
  no-network banner reads the *row*, not the server-wide setting — which only says what the
  next sandbox gets. Keyed on the setting, the banner vanished the moment an admin turned
  networking on, from exactly the workspace it still applied to.
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
- **Nor may a test call a global sweep unscoped.** `sweepOrphanSandboxes()` pauses every
  `running` row this process does not hold in memory, and destroys every container no row claims
  — the extraction pool's included, which have no row by design. `container-lifecycle` called it
  bare under vitest's parallel workers, and the symptoms landed in *other* files, one different
  each run: `hardening` 409 "container is not running", `lifecycle` `stopped` where `destroyed`
  was expected, `extract-office` `failed`. How often depended only on which files happened to
  overlap it, so a change that merely shifted test durations tripled the rate. It takes a scope
  now (`ownerId`: rows by owner, containers by `loxaic.user` label), like `reapAbandonedSandboxes`.
- **The orphan sweep only considers containers created before this process started**
  (`createdBefore`, defaulting to module load). "It is the only process alive at boot" was never
  true: the boot call sits inside the `listen` callback, unawaited, and reaches the container
  listing only after walking every row — seconds, with requests already being served. An upload
  in that window made an extraction-pool container, which is rowless by design and therefore
  exactly what the sweep destroys, so the extraction died mid-exec with nothing explaining it. A
  crash orphan is by definition older than this boot; anything younger is ours. Age, rather than
  folding the pool into the claimed set, because that would still leave the gap between a
  container existing and being registered. Compared on the engine's clock: behind ours, a young
  container can look old (the old behaviour); ahead, an orphan waits for a later boot. **Not
  covered:** a second process on the same engine whose rowless container predates this boot.
  **Compared in whole seconds, never milliseconds:** `Created` is seconds rounded *down*, so
  against a millisecond cutoff a container made half a second after it read as older — the one
  direction the rule exists to prevent. The first draft had exactly that, the real-container tests
  (which pin 0 and Infinity) passed, and only running the default against a real engine showed a
  just-created container being swept. `list-sandbox-containers.test.ts` holds it with a fake engine.
- **A scoped sweep stops hiding other tests' leaks.** `container-lifecycle` resumed its paused
  sandbox and never destroyed it — one running container leaked per run, for as long as the test
  has existed, invisibly, because the *next* run's unscoped sweep collected it as a rowless
  container. After changing what a global janitor covers, run `docker ps -a --filter
  label=loxaic.sandbox` after a suite and expect nothing of the suite's left.
- **The `loxaic.user` label names the conversation's owner, the same id as the row's `ownerId`.**
  It used to name whoever triggered the first tool call, so on a shared conversation a sweep
  scoped to the editor listed the container by label, found no row of theirs claiming it, and
  destroyed a workspace a row still claimed — more destroyed, not less, so it did not fail safe.
  Test-only reachable, since only a test passes a scope, but it was the first time the label was
  load-bearing. `__forgetActiveSandboxForTest` exists because an entry in the in-memory map is a
  claim: without evicting it the test passed with the bug in place.
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

### Inference providers

- **The built-in provider is not a row.** It is the local llama.cpp router ("Local models"
  below), synthesized at call time by `inference/providers.ts`'s `defaultProvider()` — id
  `default`, slug null — from wherever that router is listening right now. Everything else is
  an admin-added row in `inference_providers`, and every route that touches that table is
  behind `requireAdmin`: one key pays for every user's requests.
- **A model reference is one opaque string everywhere**, and the built-in backend's models keep
  their bare upstream id. Every `conversations.model_pref`, `messages.model` and
  `usage_records.model` written before this still resolves, untouched. An added provider's are
  `slug::upstreamId` (`packages/types`' `parseModelRef`/`formatModelRef`); `::` because `/` and
  `:` both occur inside real ids (`openai/gpt-4o`, `qwen2.5:7b`). One string rather than a
  second `provider` field on the wire, because a native build predating this treats the id as
  opaque and keeps working, where it would drop an unknown field and have the server answer
  from the local model.
- **An unresolvable reference is a typed error, never a fallthrough.** llama.cpp ignores the
  `model` field entirely, so a deleted provider's reference sent to the built-in backend would
  be answered by whatever is loaded with nothing anywhere saying the request had gone
  somewhere else. `assertModelUsable` runs in all three run starters beside
  `assertAttachmentsOwned`, before any conversation or message row is written — which is also
  what makes the per-provider **model allowlist** a spending limit rather than a presentation
  detail in the picker.
- **The slug is immutable and the name is not.** The name is free text, renameable, and is the
  group heading every user sees — two rows may share a preset (two OpenRouter keys, three
  llama.cpp hosts), which is what makes it load-bearing. The slug is derived from it once, at
  creation, and `PATCH` refuses to change it: it is stored in every message that used one of
  that provider's models. Deleting a provider and recreating it under the same name rebinds
  those references.
- **`baseUrl` is the API base *including* its version segment.** "Origin plus `/v1`" cannot
  express OpenRouter, whose API lives at `https://openrouter.ai/api/v1`. A bare origin gets
  `/v1` appended (llama.cpp, LM Studio, vLLM, Ollama); an already-versioned path is left as
  typed. `nativeRoot` strips a trailing `/v1` and is where the LM Studio-native and `/props`
  probes go — **only for a provider with no preset**, since asking a hosted API for them spends
  a full timeout on a 404 every refresh.
- **Deliberately no SSRF guard.** A llama.cpp host on the LAN (say 192.168.1.50) is the core use case, this
  is admin-only deployment configuration, and
  the address never reaches a non-admin. Only http/https, and credentials in the URL are
  refused — they would sit in the clear in `base_url` beside an encrypted column that exists to
  stop exactly that. Custom headers refuse `authorization` (it would silently defeat that
  column), the hop-by-hop set, and any CR/LF; keyed fetches use `redirect: "error"`.
- **`authorization` is not the only header that is a credential.** `x-api-key` is how Anthropic
  authenticates natively and `api-key` is Azure OpenAI's, so an admin has a plausible reason to
  put a live key in the headers box — where it is stored in the clear and returned to every
  admin by the list route. `redactSecrets` already treated header values as secrets; the write
  path now agrees, refusing those names (`CREDENTIAL_HEADERS`) with a message pointing at the
  API key field. Found in review, not by any test.
- **A stored key has three client states, and "remove" needs its own control.** The key field
  is never seeded (no route returns a key), so empty has to mean "keep" — which left no path to
  removal at all, and re-pointing a keyed provider's `baseUrl` kept sending the old bearer to
  the new host. The edit form has an explicit Remove control (`apiKey: null`), warns when the
  address of a keyed provider changes, and derives its plain-http warning from the *stored* key
  as well as the field — judged on the field alone it was silent exactly when a real key was
  about to travel in the clear.
- **`created_by` is `ON DELETE SET NULL`.** The default `no action` made any admin who had ever
  added a provider undeletable; `cascade` would remove deployment-wide configuration, and
  orphan every conversation naming its slug, because its author left. Attribution is the only
  thing that should go.
- **The key is decrypted with the *cached* scrypt derive** (`inference/provider-secrets.ts`,
  modelled on `github/connection.ts`, not `mcp/secrets.ts`). It is on the path of every
  inference request, and an uncached scrypt costs ~16 MB and tens of milliseconds
  **synchronously** — it would stall the event loop, and so every other user's stream, once per
  turn.
- **Upstream error text is scrubbed before it becomes an Error, not after.** Whatever
  `streamCompletion` throws is persisted on the message row and re-served to everyone on the
  conversation, shared viewers included, and a rejected request routinely quotes the credential
  it rejected ("Incorrect API key provided: sk-…"). A 401/403 from an added provider is
  **replaced** with our own sentence rather than appended to, so no part of the vendor's
  wording survives. `lastError` on the row is scrubbed the same way.
- **Provider rows are read through a short async TTL cache, not a boot-loaded sync one.**
  Nothing here has a sync contract the way `getSandboxMode()` does, a cluster shares one
  database (so a boot snapshot would leave one instance serving a provider another had
  deleted), and lookups by slug give test isolation for free. Resolved **per request, not per
  run**, which is what makes deleting a provider to stop its spend take effect on a run already
  in flight.
- **One scheduler queue per provider.** What the queue protects is one backend's cached prefix
  and one backend's capacity, and there is now more than one backend — a chat on a hosted
  provider must not wait behind a local run's tool work, for a backend with no prefix cache and
  plenty of headroom. "Added" never means "cloud": a second llama.cpp host has exactly the
  single-prefix problem the first one has. `providerId` defaults to `"default"` on
  `acquireRunSlot`/`resolveMaxConcurrent`/`schedulerState`, so every pre-existing call site
  stands. Precedence for an added provider is the row's `maxConcurrentRuns` first — the
  deployment-wide `INFERENCE_MAX_CONCURRENT_RUNS` describes the deployment's own backend, not
  someone else's API — then an authed `/props`, then the floor of 1. **A provider that cannot
  be resolved gets the floor and is not probed**: `probeTotalSlots(undefined)` means "the
  built-in backend", so probing sized a deleted or undecryptable provider's queue from local
  llama.cpp's `--parallel` and cached it for a minute — the invisible direction the floor
  exists to prevent. `scheduler.test.ts` holds it with a probe target that really does answer 8.
- **The run path never fans out.** `getModelInfo(ref)`/`resolveWindow(ref)` touch only the
  ref's own provider; only `GET /v1/models` asks them all, in parallel, with a failure
  contributing an empty list. Searching every provider from `engine.ts` would put one
  unreachable LAN provider's timeout in front of every tool iteration of an unrelated run,
  while that run holds an inference slot that may be the whole deployment.
  `invalidateBackendModels(providerId?)` is per provider for the same reason: a JIT load on one
  backend says nothing about another's catalogue, and dropping a hosted provider's
  several-hundred-entry list costs a round trip to rebuild.
- **An added provider's unknown context window is `null`, not the 8192 fallback.** OpenAI's
  `/v1/models` reports no context length at all, so the default would have every GPT
  conversation auto-compacting at about 7k tokens — a billed call and a full prompt
  re-evaluation, over and over, on a model whose real window is twenty times that. `windowFor`
  refuses to hand a `context_source: "default"` figure to the threshold; `context_tokens` stays
  a number for display only. Parsed where a provider does say: `context_length` (OpenRouter),
  `max_model_len` (vLLM), `max_input_tokens` (Anthropic), `meta.n_ctx_train` (llama.cpp).
- **`format: "gguf"` requires the backend to have said so.** Only a backend that answered
  `/props` has identified itself as llama.cpp. Keying it on "has no preset" instead put a GGUF
  badge on Claude and GPT the first time a hand-entered provider was pointed at a hosted API —
  found by driving the real UI, not by any test.
- **A failed Test reports the endpoint the admin configured, never the probe's.** The LM Studio
  probe is an opportunistic guess at `/api/v0/models`, a path nobody entered, and it fails on
  every backend that is not LM Studio — so reporting its 401 sent an admin who had configured
  `…/v1` looking for a URL that is not theirs. Same origin: found in the browser.
- **A hosted model reports `loaded: true`.** It is. Reporting otherwise would emit
  `model.loading` on every turn and re-resolve the window after each one, describing a JIT load
  that does not exist. The built-in backend's models are returned **first**, and the client's
  `defaultModel` prefers them, because every hosted model is "loaded" and
  `find(m => m.loaded)` would otherwise start a new chat on a paid model whenever the local
  backend had nothing loaded.
- **`MOCK_INFERENCE` applies only to the built-in provider.** An added one stays live, which is
  what lets the mock e2e lane exercise the whole provider path — bearer included — with nothing
  stubbed (`apps/e2e/scripts/mock-provider.ts`, whose 401 quotes the key it rejected exactly as
  OpenAI's does, because that is what the redaction has to survive).
- **A non-null allowlist doubles as a manual model list** when a provider's own `/models` call
  fails — which is the shape of any vendor whose listing endpoint needs different auth than its
  completions endpoint. An **empty** array is treated as unset: the UI writes null for "all
  models", and nobody means "no models at all" by it.
- **Test isolation:** provider rows are deployment-wide and vitest shares one database, so a
  suite creates rows under a unique name, asserts "contains" rather than an exact set, and
  deletes by its own `createdBy`/base URL — never an unscoped delete, which would take another
  suite's rows out from under it. A dead base URL is `http://127.0.0.1:1` (instant
  ECONNREFUSED), never a blackhole address.

### Local models (the managed llama.cpp router)

- **The built-in provider is a llama.cpp router this server runs** (`apps/server/src/llama/`):
  one `llama-server` started without `-m`, which spawns a child per loaded model and picks it by
  the request's `model` field. `LLAMA_MODE` is `managed` (default: install and supervise it),
  `attach` (Compose: talk to the `inference` sidecar at `LLAMA_ROUTER_URL`, sharing the models
  volume at the **same path**, because the preset names files absolutely) or `off`. Measured
  against b11149 in a spike before any of this was written; the facts below are from that.
- **A model is usable only when `status = ready AND enabled`**, and that is enforced at send
  time in `resolveLocalRef` (`inference/providers.ts`), not by the picker. A bare reference that
  is not such a row is `local_model_unavailable`; the `"default"` sentinel becomes the first
  servable model rather than reaching the router, which answers an unknown name with a 400.
  **Tests that used any bare model name now need one** — `llama/__tests__/servable-model.ts`
  inserts an enabled row under a host id of the suite's own; do not loosen the rule instead.
  Under `MOCK_INFERENCE` any bare reference still resolves, as it always has.
- **The listing is our rows, never the router's.** `llama/listing.ts` builds `ModelInfo` from
  `local_models` and asks the router only for live state (`GET /models`, and `/props?model=` —
  the router 400s `/props` without `model`). `/props` reports `n_ctx` **per slot** already
  (8192 over 4 non-unified slots reads 2048); `perRequestWindow` only predicts that before a load.
- **The router knows a model by its id with "@" for ":"** (`routerModelName` in
  `llama/preset.ts`), and every call that names a model to it — the preset section, the chat
  request's `model`, `/props?model=`, `/models/unload` — goes through that; `/models` answers are
  read back with `modelIdFromRouterName`. b11149 reads a section name with a ":" as a HuggingFace
  `repo:quant` reference and serves it under a *rewritten* name (quant uppercased, a leading
  `UD-` dropped), so a downloaded `unsloth/…:UD-Q5_K_XL` was listed as `…:Q5_K_XL` and every chat
  with it answered "model … not found" — on the beta, with the file, the settings and the row all
  correct. The rewrite also merges names (`q4_k_m` and `Q4_K_M` became one model), which "@"
  cannot, since no id contains one. The id stays the reference everywhere else, so nothing stored
  changes. `fake-llama-server.mjs` imitates the rewrite and the mock HuggingFace offers an Unsloth
  `UD-` quant: the fake used to keep every name and every mock quant was already canonical, which
  is exactly how this shipped.
- **The preset file is the only place admin input becomes process arguments, and one bad key
  stops the router from starting at all** (`option 'mlock' not recognized in preset`, fatal at
  boot; a live reload answers 500 and keeps the old list). So `load-settings.ts` is a whitelist
  of typed, range-checked settings rendered by us, re-validated at render time, and a row that
  no longer validates falls back to defaults rather than reaching the file. `mlock`/`no-mmap`
  are **not** preset keys (`load-mode` is); `kv-offload` is a bool. Adding a setting means
  confirming its key against a real router first.
- **`GET /models?reload=1` re-reads the preset live**: new sections appear, removed ones go, and
  a *changed or removed* section that is loaded is **unloaded** — mid-generation, if a run is
  using it. `syncPreset` therefore defers the reload while a built-in run holds a slot and one of
  the touched models is loaded, and the PATCH answers `appliesOnNextLoad`. Unchanged loaded
  models survive a reload.
- **The router is started with a random `LLAMA_API_KEY` in its environment** (not argv, so not
  `ps`), bound to loopback, with an env built from scratch. Without a key it answers any page in
  the user's browser: llama.cpp's own log says "CORS allows all origins". The key rides as the
  built-in provider's `apiKey`. **Attach mode gets the same**: the server mints `router.key`
  (0600) into `LLAMA_DIR`, `infra/docker/llama-router.sh` waits for it and starts the sidecar with
  it, and Compose publishes 4002 on loopback only — the first review found the sidecar open on
  `0.0.0.0` with no key, with `/models/unload` and `?reload=1` reachable from any browser tab.
- **The runtime is a pinned build, verified before it is unpacked** (`runtime-manifest.ts`,
  generated by `apps/server/scripts/update-llama-runtime.mjs <tag>` from GitHub's asset
  digests). Never "latest": it is a binary the server executes. Extraction uses the system `tar`
  (bsdtar reads zip on macOS/Windows). Older builds are pruned only after the new one answered
  its health check. A first install waits for an admin to open the screen or queue a download;
  an upgrade of an existing install fetches itself at boot.
- **The CPU is never chosen automatically.** `auto` resolves to Metal/CUDA/Vulkan or to nothing
  (`needs-gpu`), and a GPU build whose `--list-devices` finds no GPU is an *error*, not a
  fallback — llama.cpp would otherwise quietly run everything on the CPU. CPU is an admin's
  explicit choice, refused by the API without `cpuAcknowledged: true`, warned about twice over in
  the UI (a GPU present gets the stronger warning), and flagged on the runtime card while active.
  In `attach` mode the sidecar's entrypoint (`infra/docker/llama-router.sh`) writes its
  `--list-devices` output into the shared volume so the same warning reaches Compose.
- **The default device set is the GPUs with at least 4 GB *free*** when the router starts (so
  before any of our own models load). Total memory was the first rule, and it handled a 30 GB
  V620 beside a 2 GB GT 1030 — then the beta box turned out to have *two* V620s with LM Studio
  holding 26 GB of one, and both are 30 GB cards. Splitting a model onto the busy one fails to
  load. Fit labels use the same free figure. The admin can choose devices explicitly.
- **`local_models` is keyed by `(host_id, id)`** and every query is scoped to this instance's
  `LOXAIC_INSTANCE_ID` (`""` when unset): files are on one machine's disk. That scoping is also
  what isolates test suites from each other. **Two servers with no instance id on one database
  share host `""`**, and each one's download queue picks up the other's queued rows — so never
  run `pnpm dev` beside an e2e lane (already the rule; this is one more reason).
- **An orphaned router holds the GPU.** The exit hook kills it on a clean exit or crash but not on
  SIGKILL (the desktop supervisor's last resort), so the router's pid is written to
  `LLAMA_DIR/router.pid` and a stale one is reaped at the next start — only if `ps` shows our
  preset path on its command line, since a pid is reused.
- **Downloads verify HuggingFace's LFS sha256 before the rename — unconditionally.** A GGUF with
  no LFS oid is not offered at all (`groupQuants` drops it) and refused again in `run()`: the
  first version skipped the check when the oid was missing, which made "a file at its final path
  is verified" false. The path carries the **revision** (`<repo>/<sha12>/<file>`), so a file from an
  older commit is never adopted as the current one, and a size mismatch on an adopted file
  re-downloads it. Two rows sharing a file (a vision projector) serialise on `inflightTargets`
  rather than writing one `.part` twice. `.part` files resume with `Range` (a 200 to a range
  request restarts from zero rather than appending), a transfer that sends nothing for 60 s is
  aborted, and one that sends *more* than its declared size is cut off in the stream, before it
  writes past the disk margin reserved for it. Pinned to the commit sha read with the file list.
  The GGUF header is read after download (`llama/gguf.ts`) for the layer count and trained
  context, which HuggingFace's API does not report; the tokenizer arrays are skipped, not read,
  and both an array's element count and every skip are bounded (by `MAX_ARRAY` and the file's
  size) — the parser runs on the event loop, on a file that came from a stranger's repo.
- **A vision projector is "mmproj" as a word anywhere in the file name** (`isProjectorFile` in
  `llama/hf.ts`), never only a leading one: `Ternary-Bonsai-2-27B-mmproj-BF16.gguf` was offered
  as a quant named "BF16", downloaded as the model, and could only fail to load. Some repos also
  ship quant types standard llama.cpp cannot load at all — prism-ml's `PQ2_0`/`PTQ1_0` need
  PrismML's fork — which the listing does not flag.
- **Fit labels are computed server-side and only there** (`llama/fit.ts`), so search results,
  quants, installed rows and the settings sheet agree. `unknown` is never shown as "will fit".
  A search result has no file list, so its label is for a ~4-bit quant (0.6 bytes a parameter).
- **Test seams, all inert without `LOXAIC_LLAMA_SERVER_BIN`:** that variable runs
  `apps/server/test-fixtures/fake-llama-server.mjs` (the router API, recording what each load was
  given to `LOXAIC_FAKE_ROUTER_LOG`); `LOXAIC_FAKE_HARDWARE` replaces detection — `gpu`, `none`,
  or a **file** holding one of them, read at every detection, which is how one e2e server shows
  both machines (the spec rewrites it and presses Restart; the fake's `--list-devices` reads the
  same file); `LOXAIC_FAKE_DEVICES` is what the fake lists. `HF_ENDPOINT`, `LLAMA_RELEASES_URL`
  and `LLAMA_DOWNLOAD_STALL_MS` are read at call time. The e2e lane wires all of them
  (`scripts/mock-hf.ts`), so no GPU is needed.
- **Under `MOCK_INFERENCE`, an enabled local model with a router running goes to the router**
  (`servedByLocalRouter` in `inference/provider.ts`); everything else is still the mock. Without
  that exception nothing in the e2e lane would ever send a request through the router, and the
  chat path — the key, the stream, the settings a model was loaded with — would be covered by no
  test at all. With no router running (every unit suite) the mock answers, as it always did.
- **`llama-router.sh` is exercised for real** by `attach-router.test.ts`, starting from a volume
  that already has a preset but no key — the case its key wait exists for, and the only ordering
  in which the test can tell. (The server writes the key before the preset, so a test starting
  from an empty directory passed with the wait deleted.)
- **Detecting no GPU clears the previous device list.** Restart re-detects, and without the clear
  a machine that lost its GPU kept offering it under "GPUs to use" and named it in the CPU
  warning. The no-GPU e2e case found it.
- **The e2e spec signs in once** (`adminApi` caches the token). Signing in per call hit
  better-auth's sign-in rate limit after a failing run's own sign-ins; the cleanup's refused
  sign-in was swallowed and left an *enabled* model row, files gone, in the shared database. The
  cleanup now also runs first and throws rather than logging.
- **The client polls** (`hooks/useLocalModels.ts`): every second while anything installs or
  downloads, every fifteen otherwise. The settings sheet is given a snapshot of the row, not the
  polled one — a poll hands back a new object each second and would reset the draft. The
  optimistic enable switch bumps the poll sequence, or a poll already in flight lands with the
  pre-tap answer and flips it back.
- **HuggingFace bodies are read to a cap under a deadline that covers the body** (`hfFetchText`),
  never `res.text()`: a model card or a file tree is a stranger's file of any size, and the abort
  timer that only guarded the headers left the body read unbounded on the event loop.
- **`syncPreset` is serialised and the preset's temp file is named per call.** It is reachable
  from an admin's write and from the runtime starting at once, and a temp name per *process* let
  two writes splice — fatal to the router at its next boot.
- **Restart re-detects the hardware** (`st.hardware` is cleared on `restart: true`), because the
  no-loader error tells the admin to install it "and restart the runtime", which with a cached
  detection rendered the identical error back.
- **A download finishing replaces the row's status node** (in-progress line → finished pill,
  same testID). `waitForTextIn` holds one element reference and never sees the new one; the spec
  re-queries (`waitForFreshText`).

### The picker's "recently used"

- **Recorded on a send, not on a tap.** What belongs at the top is what the user ran; a model
  they opened and thought better of is not that. Written by `recordModelUse` from the two run
  starters, keyed to the **sender** rather than the conversation's owner, since on a shared
  conversation the person choosing is the person typing. Never for compaction — an automatic
  one is nobody's choice — and never for the literal `"default"`, which is the sentinel
  `ws/chat.ts` sends when a client names no model.
- **Stored in `user_prefs.recent_models`, not derived from `usage_records`**, which has no
  index on `user_id` — that would be a sequential scan of the fastest-growing table every time
  the picker opens.
- **One SQL statement, so two racing sends cannot both read the same list** and write back two
  different move-to-fronts. Skipped entirely via a per-process last-ref map when the model has
  not changed, which is every turn of an ordinary conversation, so the ordinary case costs no
  write. **Awaited** rather than fired and forgotten: a `user_prefs` row appearing after the
  request that caused it is a foreign key waiting to be violated by a user deletion.
- **`user_prefs` cascades on user delete** (matching `github_connections`). Now that every run
  records a model, every active user has a row — without the cascade, deleting a user would be
  blocked until something thought to delete a table it never touched.
- **Read-only through `GET /v1/prefs`; `PATCH` refuses the key by name** rather than ignoring
  it, so a client cannot believe it reordered the list. Absent on an older server means "this
  server does not track it", never "nothing has been used".
- **The section is hidden while searching.** A model matching both it and its own provider's
  group would render twice, and every duplicate is another row to read past. Recents are
  otherwise rendered *in addition to* their group, so a group stays a complete list of what
  that provider serves — hence `models.recent.<id>` and `models.row.<id>` as separate testIDs.
- **A new conversation opens on the last-used model — and only a new one.** The gate in
  `lib/selectModel.ts` is "no conversation exists yet", not "this conversation has no
  `model_pref`". Those are different sets: a thread from before `model_pref` was written, or
  made by another client, has an id and no pref, and "last used anywhere" silently pointed
  that old local-model thread at a paid provider the first time its owner tried one in a
  different chat. A conversation that exists falls through to the built-in default. Gating on
  the id is safe for the thread being started too: on both surfaces a conversation acquires
  its id *as part of* its first send, which records the model on it, so the composer does not
  flip when the conversation stops being new. Pure and unit-tested because it is one branch
  away from billing someone; recents must also still be offered (`isKnown`).
- **The allowlist editor discards a stale model list.** `loadModels` awaits a *remote* provider,
  so opening a slow provider, closing it, and opening another let the first's catalogue land
  in the second's editor — and saving ticked boxes wrote one provider's ids as another's
  allowlist, a server-enforced spending limit made of ids that resolve against neither. Every
  state write, the spinner included, is guarded by a request counter; closing the modal
  retires the in-flight request too.
- **`ModelModal` needed `max-h-[85%]` *and* `ModalBody scrollEnabled`**, neither of which it
  had. The vendored `ModalBody` hardcodes `scrollEnabled={false}` before its prop spread and
  `ModalContent` has no height cap, so a list past the fold extended past the viewport with
  nothing able to reach it. Grouping by provider is exactly what makes this list long; one
  provider's models are also capped at 50 rows behind a "N more — search" line, because the
  list is a plain `.map` (a virtualized FlatList cannot nest in a ScrollView) and OpenRouter
  lists several hundred.

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
- **Usage goes out per request, as `message.usage`, the moment the request finishes** (#193).
  The context meter reads the newest message carrying usage, and usage used to ride only on
  a turn's *final* `message.end` — while a tool-calling message's `message.end` is deferred
  until its tools have run, which in manual mode means until someone answers the approval.
  So the meter was empty (or stale) for as long as the turn lasted. A separate event rather
  than an earlier `message.end`, because that deferral is deliberate; the deferred
  `message.end` repeats the same figure for a client predating the event, and `foldSnapshot`
  folds it so a reconnect mid-approval sees it too. All three copies come from one builder
  (`turnUsageFor` in `engine.ts`), matching the per-iteration row `recordUsage` already wrote,
  so the live figure and a reload's agree. The JIT window re-read therefore happens right
  after the request that loaded the model, not at turn end: every figure from that point
  reports against it.
- **Unreadable is not unaffordable.** `selectAffordableAttachments` admits an image whose bytes
  are missing (costing no budget) rather than skipping it, so it reaches
  `attachmentContentParts`' `[image unavailable]` branch instead of being described — to the
  model *and* now to the user — as over a budget it has nothing to do with. The document branch
  always drew this distinction; the image branch did not, which meant the prompt itself was
  already saying the wrong thing whenever bytes outlived their row.

### The agent step check-in

- **`user_prefs.max_iterations` (default 100, clamped 1-500) is a *cadence*, not a ceiling.**
  It used to be a ceiling: the loop stopped dead at 20 and ended the stream with
  `error: "Stopped after N tool iterations without a final answer."` — a sentence that rode
  only on `stream.end.error`, which **neither client hook has ever read** and which nothing
  persisted. What a user saw was a run going red with no reason given, and nothing at all
  after a reload (#157). Twenty was also far too few: a planning run reading its way around
  this repository spends it in a couple of minutes on a local model, and being cut off there
  is not a safety property, just an interruption.
- **So the loop pauses and asks** — `steps.checkin` → *Keep going* / *Answer now* / *Stop* —
  handing its inference slot back through `slot.yieldWhile` exactly as a tool approval does.
  `waitForStepsDecision` is a near-copy of `waitForApproval` deliberately: a check-in is the
  same kind of pause (a run parked on a person) and the two should fail in the same ways.
  Keyed by `stream_id` on the run handle rather than a map, since a run has at most one
  check-in outstanding and stream ids are ours — unlike the model-supplied `call_id` an
  approval has to tolerate colliding.
- **The window is absolute, not a fresh count.** "Keep going" sets `budgetEnd = iteration +
  maxIterations`, so the header reads `7/100` then `104/200`. A per-window count would make
  "how far in am I?" unanswerable.
- **Unanswered follows a ladder, per user** (`timeouts.ts`'s `unattendedDecision`, #196).
  The first `user_prefs.checkin_auto_continues` (0-3, default 2) unanswered check-ins *in a
  row* keep going; the next one answers now. A person answering any check-in resets the
  streak; a run that fell out of the registry (`gone`) always answers. There is **no "stop"
  rung and none is needed**: answer-now sends `tool_choice: "none"` and the next iteration ends
  the run whether or not the model obeys, so the worst an abandoned run can do is
  `autoContinues × maxIterations` more steps, then one answer. That bound is what the settings
  copy states, and it is the real cost: each auto-continue is another full window of
  slot-holding work with nobody watching, whereas the *wait* itself is free (a parked run has
  handed its slot back). A loop check-in is the cheap case — "continue" resets the detector.
  `step-checkin.test.ts` walks the ladder and asserts no fourth check-in.
- **The auto-continue notice is client-only, never a message.** A persisted row would enter the
  next prompt (breaking the prefix) and the history anchor's `COUNT(*)`. It rides as
  `steps.decision {by: "timeout", n, unattended, auto_continues}` and is folded onto the last
  assistant message as `checkin_decision`, so it survives a reconnect but not the stream log's
  TTL — after that it is simply absent, which reads as "we were not told", never as "nothing
  happened".
- **The "answer now" notice says who, from `authorUserId`, on all three paths** (REST row,
  `message.start.author_user_id`, snapshot). It used to say "You asked…" for every nudge,
  including a timeout's — the same lie AGENTS.md records being fixed for approvals ("an
  unanswered approval is not a denial"). `lib/checkinNotice.ts` owns the wording: an id means
  that person (you, or someone sharing the thread), **null means nobody** (timed out), and
  *absent* (an older server's live event) gets the one sentence that claims neither. Keep the
  three distinct end to end: `foldSnapshot` copies `author_user_id` only when the key is
  present, and `applyEventToMsgs` likewise.
- **Loop detection asks early**, which is the case the old ceiling was really standing in for.
  `loop-detector.ts` keys each **iteration** (not each call) by a hash of its calls' names and
  **arguments**, and fires on the same key three times running or a 2-3 key cycle twice back to
  back. Per *call* would fire after two iterations on `[read a, read b]` twice — an ordinary
  re-read after an edit did not apply. Args and never results, because `grep`/`glob` truncate
  at 500 lines with no stable file order, so identical work can produce different output.
  "Keep going" **resets** the detector rather than muting it: a run that really is stuck asks
  again after fresh repeats instead of burning the window.
- **"Answer now" sends `tool_choice: "none"` and keeps the tools in the request.** llama.cpp
  renders the schemas into the prompt, so dropping them would rewrite the prefix and cost a
  full re-evaluation on exactly the request meant to wrap up cheaply. Verified against the
  a LAN LM Studio backend — same prompt and tools, `auto` calls the tool, `none` does not —
  and against a real run, whose final turn reported 100% prompt reuse. A backend that ignores
  it is still handled: each call it makes anyway is answered with `ANSWER_NOW_NOT_RUN`, because
  an assistant `tool_call` with no partner is the orphan the next turn's replay cannot load.
- **The instruction is persisted as a `user` row** (`CHECKIN_ANSWER_NUDGE`, fixed text, never
  interpolated), not injected into the live prompt only: the next turn has to reproduce it byte
  for byte or the prefix breaks. Not a `system` row — `loadHistory` replays user rows already,
  several chat templates reject a system message that is not first, and `authorUserId` records
  who pressed the button (null on timeout). The client renders that exact text as a subdued
  notice rather than a user bubble, since nobody typed it.
- **A finished stream's snapshot carries no pending question.** Stopping a run parked at a
  check-in emits no `steps.decision` — nobody decided — so nothing in the record log ever
  clears it, and `foldSnapshot` is pure over records and cannot see the terminal status
  (`producer.end` writes no record). The next resync therefore put the banner back on a run
  that had already ended, offering two buttons that could do nothing. `delivery.ts` strips both
  `pending_checkin` and `pending_approval` from a non-active snapshot, which is the one place
  the snapshot and the status are both in hand. Approvals escaped the same trap only by
  accident, because their abort path records a `tool.result` the fold clears on. **Found by
  driving a real run in a browser, not by any unit test.**
- **Clamped on read as well as validated on write.** The route rejects out-of-range values
  rather than silently clamping (a client that asked for 5000 should be told it did not get
  5000), and `clampMaxIterations` clamps anyway, because the column is plain data and a value
  that arrived by some other route must not be able to remove the brake. A failed lookup falls
  back to the default, never to "unlimited".
- **Migration `0021` moves rows still at the old default 20 to 100**, because a default only
  applies to rows written after it and 20 now means something different — a check-in every
  couple of minutes, which is worse than the behaviour being replaced. Anyone who chose 20
  deliberately is indistinguishable here and loses their setting; that is the cheaper mistake,
  since it is one visible control they can put back.
- **The banner is a banner, not a dialog** (`components/chat/StepCheckInBanner.tsx`, both
  surfaces). Answering means reading what the agent already did, so the transcript has to stay
  visible and scrollable behind it — a modal would cover the one thing the decision depends on.
  It is written in the agent's own voice for the same reason the decision is the user's.
  It, the approval dialog and the agent's permission bar all carry a `DeadlineCountdown`
  saying what happens if nobody answers, and when — the outcome was a surprise before, and a
  surprise that looked like the user's own choice.
- **The wait settings have their own screen** (`app/(app)/checkins.tsx`, reached from
  `settings.nav.checkins`), not rows in the settings modal: that modal has run past its fold
  twice, and these only make sense read together. `AgentStepLimit` moved there too. Each
  control hides itself when the server omits its field, and `checkin-settings.spec.ts`
  asserts the lowest row is *reachable*, not merely displayed.
- **That screen has one copy of the prefs (`hooks/usePrefs.ts`), and every control on it is
  controlled.** `AgentStepLimit` used to fetch and save for itself, so the row below it — which
  quotes the step limit back as the cost of an auto-continue — went on saying "100 more steps"
  after the limit had been moved to 200, four lines away. A failed save reverts **only the fields
  it patched** (`lib/prefsRollback.ts`): restoring the whole pre-save snapshot also undid a later
  save that had succeeded, leaving the screen disagreeing with the server. `busy` is a count of
  saves in flight, not a flag, so the first to settle does not re-enable everything.
- **`ToolApprovalDialog` was the fifth modal to need `ModalBody scrollEnabled`** (after
  SettingsModal, McpServerModal, RoutineModal, ModelModal) — it had only the `max-h-[85%]` half,
  and the countdown is the last row in the body, so it was the first thing pushed below a fold
  nothing could reach. `approval-deadline.spec.ts` asserts reachability, stepping the window
  down until the dialog really overflows. **Adding a row to any modal body means checking both
  halves are there.** All five found in review or by hand, never by a test that existed.
- **A snapshot's `server_now` is passed through as it arrived, never defaulted to `Date.now()`.**
  Absent, `localDeadline` re-bases the wait from now, which only errs long. Substituting `now`
  takes the *corrected* branch with zero correction — the server's `expires_at` read straight off
  the device clock, so a fast phone shows less time than the server is honouring. Unreachable
  today (`delivery.ts` always stamps it), but the comment once claimed the opposite of the code.

### Plan review (planning mode's panel, #199)

- **A plan is a `propose_plan` call, and a successful one ends the turn.** The tool
  (`PLAN_TOOL` in `packages/agent`) is kept out of `TOOLS` and appended by
  `resolveBuiltinTools(mode)` in planning mode only, so chat, routines and the working modes are
  never offered it and `isToolName` keeps it off the "Allow always" list. It runs in-process — a
  planning run that only plans never creates a sandbox — and the engine ends the turn after the
  tool row, before the check-in block, through `endTurnComplete(toolMsgId, true)` (the flag
  skips the second `message.end`) and `break`, so auto-compaction still runs. An empty plan is
  `ok: false` with a reason and the loop continues; a call after a successful plan in the same
  message is recorded not run (`HANDOVER_ALREADY_SUBMITTED`), so no approval can appear after a
  plan has been handed over.
- **Planning ends every turn in a plan or questions, whatever was asked.** `ask_questions`
  (`QUESTIONS_TOOL`, planning only, same in-process shape) is the other hand-off, and both are in
  `HANDOVER_TOOL_NAMES` — a successful call to either ends the turn. The questions are validated
  (`questionsProblem`: 1–4 questions, 2–4 options each) so a malformed call is `ok: false` and the
  model retries; "Other" is the client's, never the model's. The prompt asks for one of the two on
  every turn, including a request that is not a coding task.
- **A planning turn that ends in prose is nudged once.** The engine ends the prose message,
  persists `PLAN_REQUIRED_NUDGE` as a user row (`authorUserId: null`, like the check-in nudge —
  a persisted row so the next turn replays it byte for byte), and asks again with
  `tool_choice: "required"`. A second prose answer ends the turn and is shown as it is. Never on
  an answer-now turn, which asked for words. `required` is sent on that one request only — the
  flag is cleared as the request goes out, because a nudged request may call a read tool
  instead of handing over, and a flag left set forced a tool on every request after it, so the
  model could never answer in words and worked on, holding the slot, until the step check-in
  (found in review; `planning-handover.test.ts` has the detour case). Every ordinary request is
  unchanged; checked against LM Studio (it called `propose_plan` when
  asked for words), and llama.cpp, vLLM and OpenAI document it. The client renders the row as a
  notice (`chat.message.planNudge`), not a bubble nobody typed.
- **Answers are one message, sent in planning** (`formatAnswers`: `QUESTIONS_ANSWERED_PREFIX`,
  then each question with its chosen labels and any "Other" text). A question set is `answered`
  once any user row follows it. A rejected plan is answered with questions about what to do
  instead, never with another plan — and `PLAN_REJECTED_MESSAGE` itself asks for them. It used to
  say "wait for my next message", which contradicts the prompt: a model that obeys it answers in
  prose, which costs every rejection the nudge and a second request. The mock hid that by
  special-casing the rejection text; it now reads the rejection's own words ("Ask me…") like any
  other prompt, so the wording is what the test checks.
- **A panel's draft is keyed to its call id, never reset by an effect.** The panels stay mounted
  with a null item while closed, so an effect on the call id fired on every close and threw away
  half-answered questions or a half-typed suggestion. State that carries the call id it belongs
  to survives closing and reopening the same item, and reads as empty on the first frame of a
  different one. Statuses come from one pass over the thread (`reviewStatuses`) — they are
  recomputed on every streamed token.
- **The turn ends rather than blocking, deliberately.** A run parked on the plan would hold the
  conversation's run lock (no sending while reading), lose the plan with the in-memory registry
  on a restart (its `tool_call` would have no result, and `loadHistory` strips it), need a
  timeout no plan review fits, and still need a new run for Accept — a run's mode, system prompt
  and toolset are fixed for its life, and switching them mid-run breaks the prefix invariant
  `prompt-prefix.test.ts` holds.
- **Every decision is an ordinary message.** Accept sends `PLAN_ACCEPTED_MESSAGE` in the Default
  mode from Settings (Manual when that is Planning) — named on the button — or in whichever mode
  its dropdown picks, on the model chosen in the panel. The dropdown is a list *inside the sheet*,
  not a floating `Menu`: a second native overlay over the sheet is what stranded it on iOS; a
  suggestion is the typed text, and Reject `PLAN_REJECTED_MESSAGE`, both in planning. The texts
  are fixed (`packages/types`) because the client reads a plan's status back from the reply
  after it (`lib/plan.ts`), which is what makes the status survive a reload and agree across
  devices with nothing stored. Reject costs one short model reply: without one, the next message
  would put two user rows in a row, which some chat templates refuse.
- **Only `ok === true` counts as a plan** on the client — a refused, stopped, answer-now-skipped
  or unknown-tool call has `ok: false`, and one with no result yet has been shown to no one.
- **Switching mode costs one full prompt re-evaluation.** Planning and the working modes differ
  in system prompt and tool list, so Accept's first request re-evaluates the prompt. That was
  already true of pressing the mode selector; the plan panel just does it for you.
- **The panel opens by itself for the newest plan or question set while it is pending**
  (`useReview`), for someone who can decide, with nothing running — once per item per session.
  Closing it, or sending a suggestion, leaves `PlanReviewBar` above the toolbar until the plan is
  accepted or rejected or the questions answered; the ⋮ item reads "View plan" or "View
  questions", following the newest. Viewers get the bar, never a sheet over the thread. Both
  panels share `ReviewSheet`, which holds the sizing and keyboard lessons below — a second copy
  would have to learn them again.
- **The mock plans in planning whatever is asked** (`planningFinish` in `inference/provider.ts`):
  a trigger's tool runs first and the turn then ends in `propose_plan` instead of "[Mock] Done";
  "ask me"/"questions" asks `MOCK_QUESTIONS` (which is also how a rejection gets its questions);
  answers and the nudge go straight to a plan;
  "answer in prose" answers in prose until `tool_choice` is `required`, which is how the nudge is
  tested end to end.
- **The model picker is a sibling of the panel, never stacked on it**: choosing swaps the sheet
  for `ModelModal` and back, the rule `RoutineModal` set. The model list opens `SHEET_EXIT_MS`
  *after* the sheet starts closing — iOS will not present a second modal while the first is still
  being dismissed, and left the sheet on screen behind the list. A model chosen for a plan is keyed
  to that plan's call id, so it never carries onto the next one, and it becomes the conversation's
  model only when Accept is pressed.
- **The sheet's height is set on its content, never by a class on `ActionsheetContent`.** On
  native the vendored sheet appends `height: snapPoints ? … : undefined` *after* the caller's
  styles, and `undefined` wins the flatten, so an `h-[92%]` class was erased on iOS and Android:
  the sheet sized to the plan and pushed the whole footer off the screen — while web, which keeps
  the class, passed its e2e. `snapPoints` is no fix either: it reads the window height once, at
  module load, so a resized browser keeps the old one. `ReviewSheet` sizes an inner view from
  `useWindowDimensions()` and the safe-area insets instead. **Found only on the simulator.**
- **The keyboard is padded for by hand.** The sheet's overlay is out of reach of the screen's
  `KeyboardAvoidingView`, and one inside the sheet mis-measures it (the sheet is placed by a
  transform), leaving the suggestion box under the keyboard on Android. `useKeyboardHeight`
  pads the content instead — less the bottom inset on iOS, whose keyboard height includes it, and
  whole on Android, whose does not. **Found only on the emulator**; the simulator uses the Mac's
  keyboard, so the iOS side of this is unverified by eye.
- **Markdown list markers are sized per list** (`markerWidth` in `components/markdown/blocks.tsx`).
  A fixed `w-5` fitted "9." and not "10.": on native the dot wrapped onto its own line, on web it
  ran into the text. Plans are numbered lists, which is how it surfaced; chat had it too.
- **Answer-now in planning mode still produces prose**: `tool_choice: "none"` forbids the tool,
  and the nudge stands aside for it.
- **`aria-selected`, not `accessibilityState`, on the mode chips.** react-native-web did not turn
  the latter into an attribute through the gluestack `Pressable`, so the e2e — which checks that
  Accept from the dropdown really switched to Auto — could not see it while the screen plainly
  showed Auto.
- **A client without this update shows a plan as a plain tool card**, and the model no longer
  restates the plan as prose — the over-the-air update is what brings the panel.

### Automatic compaction

- **The server compacts on its own** once a finished turn's `prompt + completion` crosses
  `AUTO_COMPACT_THRESHOLD` (default 0.85) of the model's window, provided the replay holds at
  least `AUTO_COMPACT_MIN_MESSAGES` (8) and the user hasn't turned it off. Policy lives in
  `streams/runs/auto-compact.ts`; `/compact` is the same machinery with `auto: false`, no
  threshold, and no pref check — asking for it is a decision.
- **Compaction deletes nothing.** It inserts a `summary`-authored row, and `loadHistory`
  replays only rows after the newest completed one — what is *sent* shrinks, what is *shown*
  does not. A compaction with nothing new since the last summary (`already_compacted`) or
  under two messages (`too_short`) still lands a card but makes no model call. Savings use the
  last usage record's prompt + completion as "before"; if either side had to be estimated,
  `before_estimated` is set and the card shows `~`.
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
- **The slot covers tool execution too**, and that is a stated trade-off: a run holds it across
  every sandboxed `bash` up to `max_iterations`, giving it back only while a human is asked —
  an approval, or a step check-in. At concurrency 1 one long auto-mode run holds a shared
  deployment for the length of its tool work with the backend idle. Yielding around tool calls would not recover that for free — a
  run admitted in the gap evicts the prefix, and the yielding run re-evaluates its whole
  prompt on return. Per-user fairness and a cap on hold time are follow-ups.
- **Any event that is not `run.queued` clears the queue position** — in `foldSnapshot` and in
  both client hooks. `iteration` used to be the only clear-point, and a compaction run never
  emits one, so a client catching up mid-summary saw "Queued · #1" with the summary streaming
  underneath. Chat also reads `snapshot.queued`, since `run.queued` is only re-emitted when the
  queue *moves*. And `PATCH /v1/admin/settings/inference` calls `kickScheduler()` after the
  write: `pump()` otherwise runs only on a release, so a raised limit took effect whenever the
  run holding the slot happened to finish.
- **A compaction stopped while queued still persists a terminal status**: its summary row was
  inserted as `streaming` before the queue wait, so the null-slot early return throws into the
  catch that writes the status and emits `message.end`, rather than ending the stream around
  an empty bubble stuck mid-stream on every later load.
- **Compaction queues like any other run**, including automatic compaction — a background job
  jumping the queue would stall somebody's chat.
- **`run.queued` carries one number, a 1-based place in line.** Re-emitted as the queue moves
  so a client counts down instead of showing a stale figure, folded into the snapshot so a
  reconnecting client sees the wait, and cleared by `iteration` — reaching an iteration *is*
  the run starting. `steps.decision` is emitted from *inside* `yieldWhile`, before the answered
  run re-enters the queue, so the log reads `checkin → decision → run.queued → iteration` and a
  second device never sees a stale check-in beside a queue position.
- **The mock's `take your time` prompt** (`MOCK_SLOW_MATCH`) is the only way to observe a
  queue end to end: every other mock response lands in milliseconds, so without it a test
  would be racing the harness against itself. Keyed on the prompt rather than an env var so
  it slows exactly the conversation that asked.
- **Test isolation:** `resetServerSettingsCache()` is process-global and vitest shares one
  worker across files. Clearing it mid-run made another suite's `updateSandboxSettings` see a
  changed value, sweep every live sandbox, and fail four unrelated container tests. Prefer an
  env pin read at call time.

### Reporting cache figures honestly

- **`usage_records` has one row per completion** — each tool-loop iteration — with `run_id`
  set to the stream id, written right after `message.usage` is emitted. The insert is
  best-effort and never fails the turn: a reply the model finished is not undone because its
  usage row could not be written. Compaction writes its own row.
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
- **`prompt.stats` is the one carve-out from "never divide by TTFT", and only because it is an
  ETA, not a speed** (#196). Before each request the engine announces the prompt's estimated
  size (the previous request's *measured* size plus an estimate of what was appended, when the
  prefix is a strict extension), its reusable tokens, and an ETA from
  `inference/prefill-rate.ts` — an in-memory median of recent samples per model. A sample is
  llama.cpp's own `prompt_per_second`, or `(prompt_tokens − reusable) / ttft` **only** on an
  exact strict-extension measurement with ≥ 256 evaluated tokens and no model load. It is never
  stored, never shown as a rate, and never feeds `prompt_tps`; if the backend evicted the
  prefix the sample reads slow and the ETA errs long, which is the safe side. Emit-only — it
  changes no prompt bytes — and folded into the snapshot until the message's first output, so
  someone reconnecting mid-prefill still sees it. **The line shows through a model load**
  (`showPromptStats` takes no `loadingModel`): the server measures size and reuse for that
  request and withholds only the ETA, and nothing is emitted between `prompt.stats` and the first
  token — the event that ends "Loading model…" is the same one that clears the stats — so a
  `!loadingModel` gate made it unreachable for exactly the runs that wait longest. The mock never
  reports a model as unloaded, so no spec can see that path. `reusable_tokens: 0` is shown as "0%": the
  rule is never to turn null into 0, not never to show 0.
- **Measured progress rides the completion request itself, not a `/slots` poll** (#197). llama.cpp's
  server, asked with `return_progress: true`, sends `prompt_progress {total, cache, processed,
  time_ms}` on content-less chunks of the *same* SSE stream — a 0% report when the slot starts, then
  one per decoded batch. So there is no second request that could delay or fail the run, and no
  slot to match to our request under `--parallel` > 1 (the question the issue raised; `/slots`
  also lacks per-request progress, and `--no-slots` can remove it). The engine re-emits
  `prompt.stats` with a `progress` object merged in; both folds already replace on `prompt.stats`,
  so a reconnecting client gets the latest report and an older client ignores the field.
  **`progress` is absent, never null-filled**, when the backend reported nothing.
- **Ask only a backend that identified itself** (`modelRunInfo`'s `nativeRuntime`: it reported an
  allocated window via llama.cpp's `/props` or LM Studio's native listing). Not "has no preset" — a
  hand-entered provider pointed at a hosted API has none either, and OpenAI answers an unknown
  request field with a 400, which would fail every turn. `liveStream` refuses the field for any
  preset as a second lock. It is a body field, not a message, so the prompt prefix is untouched.
- **Throttled to one re-emit a second** (`promptProgressEmitter`), the first report and the *first*
  to reach 100% always sent. Every non-delta event forces a stream-log flush and is kept for
  `STREAM_TTL_SECONDS`, and a small `n_batch` reports many times a second. The 100% exemption is
  **latched**: a backend that finishes the prompt and then stalls before its first token keeps
  reporting `processed == total`, and exempting each of those removed the bound exactly when a
  request can run to the hour-long ceiling. Found in review, as were the two below.
- **Completion is its own case on the client, and mid-flight tests cannot see it.** Two segments
  floored independently (33% + 66%) left a finished prompt's bar at 99%, so at completion the
  evaluated segment takes the remainder. And `remaining_ms` is **null once nothing is left**, not
  0 — `formatEta` clamps up to "1 s", so a 0 read "100% evaluated · about 1 s left" for however
  long the first token took. The client also guards `> 0`, for a server that predates the fix.
- **The measured line drops `~` and "(estimate)"** and says "cached" — the backend's reuse, known
  before prefill — never "reusable", which is ours. "% evaluated" is of the *uncached* part
  (llama.cpp's own timed progress), so a big cache hit does not make the bar look nearly done.
  `remaining_ms` divides only evaluated tokens and is null below `MIN_EVALUATED_TOKENS`; it is a
  countdown, and never feeds `prompt_tps` or `prefill-rate.ts`. A progress report also ends
  "Loading model…" (`loadingAfter`) — only a loaded model can be evaluating a prompt.
- **LM Studio cannot report it over HTTP; do not re-probe.** Checked against a LAN LM Studio
  (2026-09-21): `return_progress` is silently ignored, `/slots` and `/props` do not exist, and `/api/v1/chat`
  — which does stream `prompt_processing.progress` — takes only `input` plus MCP integrations: no
  message history, no caller-defined tools, so it cannot carry a run. The only route is moving the
  completion call itself onto `@lmstudio/sdk`'s WebSocket, which is its own issue. Until then LM
  Studio keeps the estimate. The mock's `report your progress` prompt (`MOCK_PROGRESS_MATCH`) plays
  llama.cpp's reports out, and only when the engine asked for them.

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

### Deleting a conversation

- **`conversations/delete.ts` is the only thing that knows what deleting means**, and what it
  means is a deployment-wide setting: **erase** (the default) or **keep for an audit**. The
  route authorizes and calls it; nothing else writes `deletedAt`. Owner-only, and the
  deliberate identical `200 {ok:true}` for everyone else — an admin resolves to viewer, so an
  admin cannot delete someone's conversation either, only erase one already deleted.
- **The ordering in `purgeConversation` is load-bearing and is not the intuitive one.** The
  conversation row goes **first**, in the same transaction as its messages: every
  authorization path ends at `resolveAccess`, which refuses a row that is not there, so the
  instant it commits nothing new can start a run, send, or read. Deleting the messages first
  would leave a window in which an empty conversation still exists and a live socket can write
  into it. **Only then** is the run aborted — anything it writes from here is an orphan by
  construction, which the **second pass** after `waitForRunEnd` collects. That second pass is
  what makes the wait an optimisation rather than a correctness requirement; a run wedged in a
  tool call never reaches `unregisterRun`, and the cleanup still has to happen.
- **A timed-out unwind wait gets a second, longer wait — the first erase is not the last.**
  `waitForRunEnd` giving up is exactly the wedged-run case, and it is the one where rows land
  *after* the purge pass. Nothing else ever looks for messages whose conversation is gone, so
  those rows would hold the content of a conversation the user was told was erased, **and keep
  its uploads forever**: `files/reaper.ts` only collects an attachment no message references, so
  one orphan row pins the bytes past every grace period. Both waits are read from the
  environment at call time (`DELETE_RUN_UNWIND_TIMEOUT_MS`), because a test cannot otherwise
  reach the branch without spending thirty real seconds.
- **Usage records are kept and detached** (`conversation_id`/`message_id` nulled), never
  deleted. The tokens were spent, and the Stats screen's lifetime totals are made of them;
  what must not survive is a row naming a conversation that no longer exists, which would sit
  in "recent conversations" as an id nothing can resolve. **Only `conversation_shares` has a
  foreign key to `conversations`** — messages, usage records and sandboxes have none — which
  is exactly why this function exists rather than a bare DELETE.
- **Uploads need nothing here**: `files/reaper.ts` keys on messages that no longer exist, so
  erasing the messages *is* the reclaim. Under the old soft delete they were never reclaimed
  at all, because the message rows survived forever.
- **Sandbox rows are deleted only when their container is confirmed `destroyed`.** A row whose
  destroy failed is the only record that a container exists; deleting it strands that container
  where the abandoned reaper can never find it.
- **The stream log holds the transcript too** — every delta of every run, for
  `STREAM_TTL_SECONDS` — so erasing the messages and leaving those keeps the content readable
  by a resync for another day. Best-effort: not every process that reaches this code has a
  broker (route tests mount routes without one), hence `hasStreamBroker()`.
- **Retention fails *on*, and the sweep stands down.** `getConversationSettings()` resolves
  `keepDeleted` to true when the settings row could not be read — the opposite direction from
  the sandbox mode's fail-closed, deliberately: there an unreadable row must not re-enable
  execution, here the irreversible outcome is the *permissive* one. Both branches of
  `sweepRetainedConversations` delete (off means "erase everything retained"), so guessing the
  policy is the one guess that cannot be taken back. An **env pin makes the policy known**
  without the database and outranks the failed read, the same way `SANDBOX_MODE` does.
- **`conversationPurgeAt` is derived on read, never stored** — an admin shortening the window
  moves every retained conversation with it, and a stored date would leave the admin screen
  promising one the sweep will not honour. Same rule as `sandboxReapAt`.
- **A hold survives a policy change.** It is an admin saying "not this one" mid-enquiry, and
  turning retention off is not an answer to that.
- **`resolveAccess` is never loosened for an admin.** A retained conversation stays unreachable
  on every ordinary path including every socket; the admin transcript
  (`GET /v1/admin/conversations/:id/messages`) is a separate, admin-gated, read-only door. Its
  attachments are **named, not served** — `/v1/files/:ref` keeps its own `c.deleted_at IS NULL`
  condition, and serving the bytes through a second door would quietly undo that.
- **Restoring brings the shares back and not the workspace.** The shares were never deleted
  (nothing cascaded — the row survived); the sandbox was destroyed at delete time, because
  nothing could reach the conversation to resume it and the audit view reads rows, not
  containers.
- **A successful settings write clears the read-failure flag.** Without that the flag outlives
  the failure for the life of the process: `retentionUnknown()` stays true, `keepDeleted`
  resolves to true whatever an admin writes, and the sweep stands down — so turning retention
  *off* returns 200, the switch snaps back, and the deployment quietly keeps every deleted
  conversation until a restart. The write itself is the proof the database is reachable and the
  row is what we just put in it. `updateSandboxSettings` does the same for `loadFailed`.
- **`retentionUnknown()` consults only its own flag, never the sandbox read's.** The two groups
  have separate reads and separate `try`s in `loadServerSettings`, so a sandbox failure while
  this row read fine leaves the policy perfectly well known; treating it as unknown would keep
  every deleted conversation over a failure in an unrelated row. A failure broad enough to
  affect both sets this flag itself.
- **The confirm dialog's wording comes from `/v1/config`**, because the answer differs by
  deployment. While the config is still loading it claims neither outcome — guessing either
  way is a promise about someone's data.
- **What it says about an agent's files is keyed on the workspace, not the surface.** A scratch
  or GitHub workspace is a server-side sandbox and is destroyed with the conversation; a
  **local** one is a folder on the user's own machine and is untouched — `executor/service.ts`'s
  destroy removes a container at most, "never the folder that was mounted into it", and for a
  direct workspace is not called at all. Keying on `area === 'agent'` made the destructive
  claim about every run, which is most alarming exactly where it is false: the one workspace
  holding work a user can really lose. `lib/deleteMessage.ts` is a pure module so both of the
  things this sentence varies on are unit-tested.

### Routines

- **A routine run is an ordinary chat run.** `executeRoutine` creates the conversation
  (`kind: "routine"`, `modelPref` set) and the `routine_runs` row in one transaction, then calls
  `startChatRun` — the queue, the tool loop, usage records, the stream log, chat's manual-mode
  approval semantics. It returns once the run has *started*; the row is still `running`. Before
  #179 it was a stub that inserted `[Routine "X" executed at …]` and never called a model, which
  is why the issue's "let me see the chat" had nothing worth seeing.
- **Unattended is the normal case, and the owner's wait settings are what make it safe.** A run
  uses its owner's prefs. A write tool nobody allowlisted waits out the owner's approval window
  per call and is reported as "nobody refused"; an unanswered step check-in walks the owner's
  ladder (keep going up to `checkin_auto_continues` times, then answer). Someone who opens the
  run's chat while it is going can approve live, which is most of why the chat is worth opening.
- **`recordUse: false` on `startChatRun` keeps a scheduled run out of the picker's recents.** A
  cron firing at 6am is nobody's choice of model, exactly as an automatic compaction is not.
- **The terminal status comes from `broker.onEnd`, never from "we dispatched it".** `onSettled`
  is wired before the loop starts (a run that fails in its first await would otherwise finalize
  with nobody listening) and fires once. It settles on the *stream log's* finalize rather than on
  `runToolLoop`'s promise, so the status is not held up by the automatic compaction that runs
  after the loop's `finally`. `finishRun` is `UPDATE … WHERE status='running' RETURNING`: a
  routine deleted mid-run has no row, and no row means no ntfy.
- **`runToolLoop`'s promise is handled now, for every caller.** `engine.ts` rethrows anything
  that is not `RunSlotAbortedError`, `chatRun.ts` called it as a bare `void`, and nothing
  anywhere handles `unhandledRejection` — so such a run left the stream "active" forever and a
  resync kept waiting on it. Latent while every run started from a socket; reachable the moment
  a cron could start one.
- **The routine's model is the only model its chats ever use, and there is no fallback.**
  `routines.model` holds one opaque reference. A run whose model is null or unresolvable is
  recorded `failed` with the reason written into its own chat (an assistant row `status: "error"`,
  the shape `engine.ts` already persists) — never answered by the built-in default and never by
  `recent_models[0]`. Every routine that predates the column is null, so a recents fallback would
  have started spending an admin's provider key on a cron the first morning after an upgrade, on
  a model nobody picked — the failure AGENTS already records for `selectModel`.
- **A send into a `kind: "routine"` conversation is served on the routine's model too**, whatever
  the client names (`routineModelFor` in `chatRun.ts`, reached only for that kind, so an ordinary
  chat send pays nothing). That is what lets the routine chat screen have no model picker; an
  older client naming a model cannot drift the conversation either. `AccessGrant.kind` exists to
  make the check free — the access lookup already reads the row.
- **Deleting a routine goes through `deleteConversation`, never `purgeConversation`.** Its chats
  can be continued by hand, which makes them ordinary conversations as far as an audit is
  concerned, so deleting the routine must not become a way around a deployment's retention
  policy. Order: conversations first, one at a time (a throw leaves the routine intact and the
  whole delete retryable), then one transaction deleting `routine_runs` `RETURNING` and the
  routine, then a second pass for a run that raced the first. DELETE now 404s for a routine that
  is not yours or does not exist, where it used to answer `{ok: true}` for both.
- **`unscheduleRoutine` runs *after* the routine row is gone, never before.** Unscheduling first
  looked tidier and left a hole: a throw in the conversation pass answers 500 with the routine
  intact — deliberately, the delete is retryable — but nothing re-adds a job outside POST, PATCH
  and boot, so the routine came back in the list looking enabled and never fired again until a
  restart. A tick landing in the gap is harmless both ways: before the transaction its run row is
  caught by `RETURNING`, after it `executeRoutine` finds no routine. `isRoutineScheduled()` exists
  because the schedule is otherwise invisible from outside, which is how this went unnoticed.
  Found in review, not by any test.
- **`POST /:id/run` answers 409 when no run was created**, never `200 {ok: true}`. The client is
  typed to read a 200 as a run, so it opened `conversationId: undefined` and blanked a screen of
  history with "hasn't run yet" — while nothing said the run had not started.
- **The delete dialog's count comes from `GET /:id/conversations/count`, not the listing.** The
  listing is a 50-row page, right for a history panel and wrong for a sentence about what a
  delete takes: a week-old hourly routine read "Its 50 chats go with it" and lost 168. And an
  *unknown* count is `null`, never 0 — coerced, it said "It has no chats yet." until the fetch
  landed, and permanently if it failed. `deleteRoutineMessage` has the same "we were not told"
  branch for the count as for retention.
- **An unresolvable model is "Model unavailable", and only a loaded model list may say so.**
  `labelFor` once fell through to the raw ref, so a deleted provider's routine showed
  `myprovider::llama-3` in a neutral badge — the warning suppressed in the one case where every
  run fails. But `isKnown` is false for everything until the list arrives, so the verdict is
  gated on `modelsLoaded` or every card flashes red on each visit.
- **`nextRunAt` is node-cron's own `getNextRun()`**, written on schedule, on each tick, and
  nulled on unschedule — asked of the live job rather than re-derived, so it cannot disagree
  with what will fire.
- **`eraseRows` owns the `routine_runs` cleanup**, because nothing else would: the column carries
  no foreign key to `conversations`, so erasing one of a routine's chats without this leaves a run
  row listed in the routine's history opening onto nothing.
- **`restoreConversation` flips an orphaned routine chat to `kind: "chat"`.** Only a routine lists
  its own conversations; restored as `routine` with no routine left, it would come back where no
  surface can reach it — restored in name only.
- **Every routine-scoped listing inner-joins `conversations` on `deletedAt IS NULL`**, so a chat
  the user deleted from inside the routine disappears from its history, the same way it does
  everywhere else.
- **`GET /v1/conversations` excludes `kind: "routine"` outright.** Both surface hooks already
  filtered client-side (#117), but that query is capped at 50 rows and an hourly routine now makes
  24 real conversations a day — left in, they would push a user's own chats out of their own list.
- **The boot reconcile is bounded by a module-load `BOOT_AT`.** A process that died mid-run leaves
  a row nothing would ever move; a "Run now" that lands while the scheduler is still starting must
  not be caught by the same sweep. **The scheduler is single-process** — cron fires on every
  instance, which was already true, and this reconcile would also fail another instance's live
  runs.
- **Client: the routine chat screen is `useChatSession` with a `scope`, not a third copy.** The
  hook is ~300 lines of socket, cursor, approval and check-in handling and `useAgentSession` is
  already one copy of it. A routine scope lists from `getRoutineConversations`, filters on kind
  `routine`, refuses the implicit create (a send with nothing open would open an ordinary *chat*
  conversation from the routines screen), and **reads and writes no offline cache** — those rows
  would take eviction slots from the user's own threads, and Chat's own list write prunes what it
  does not recognise.
- **`subscribeOnSelect` exists because a scheduled run starts on the server.** The hook otherwise
  subscribes only on socket open and on a seq gap, which is enough where every run starts from
  this client; a routine's does not, so opening its chat is the first this client hears of it.
  Sent *after* the history fetch settles: a snapshot landing first fills the thread, and the
  history fill only applies to an empty one, so the older messages would be dropped.
- **Never read a result back out of a `setState` updater.** `handleDelete` assigned `remaining`
  inside `setConversations(prev => …)` and read it on the next line. React runs an updater eagerly
  only when the fiber has nothing pending; with another update queued (a background stream event,
  the confirm dialog's own `setDeletingId(null)`) it is deferred to the render, and the variable
  is still its initialiser. "Open the next chat along" therefore picked nothing, intermittently,
  in exactly the scope it was written for. Decide from a ref before the update.
- **`AppShell` derives the active surface from the first path segment.** `/routines/<id>` is a
  real route (so browser and Android back mean "back to the routines list", and a reload keeps the
  routine); matching on the whole path left the sidebar with nothing highlighted.
- **`RoutineModal` needed `max-h-[85%]` *and* `ModalBody scrollEnabled`** — adding the Model row
  is exactly what pushes Save past the fold. Third time: see SettingsModal and McpServerModal,
  where it cost a credential. `ModelModal` renders as a *sibling* from the screen with the model
  lifted into it, never stacked on the routine form; nothing else in this app stacks modals.
- **e2e:** `goToSurface('routines')` waits on `routines.new`, not `composer.input` — the routines
  list has never rendered a composer, so the old helper timed out rather than landing.
  `openThreadList('routineChat')` anchors on `threadList.runNow`, since a routine's list has no
  new-chat button. iOS skips every Modal-overlay step and seeds through the API, same as
  `delete-conversation.spec.ts`.

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
  `allowPrivateNetwork` in the GUI — **the one exception is the GitHub server when an operator
  sets `GITHUB_MCP_URL`** (below): that address is trusted the way `GITHUB_API_URL` is, and no
  request can widen it (`PATCH` refuses `allowPrivateNetwork` on that row).
- Connections are cached per `userId:serverId` with an idle reaper (`mcp/client-manager.ts`,
  mirrors sandbox-manager); a dead/hung server fails only its own tool calls, never the run.
- **A failed connect is remembered for `CONNECT_FAILURE_TTL_MS` (30 s).** The registry connects
  every enabled server at the start of every turn, and a failure used to be cached nowhere — so a
  server nobody could reach cost `CONNECT_TIMEOUT_MS` on *every* turn. That was tolerable while
  every row was one the user added by hand; it is not for a row provisioned automatically. An
  edited row (new `updatedAt`) **bypasses** the cached failure — that is what makes Test always
  really try — while `dropEntry`/`closeServerClients` are what actually delete the entry, and the
  idle reaper sweeps whatever neither names, since a failure past its window is an `Error` and its
  stack retained for nothing.
- Brave Search ships as a built-in catalog entry (`mcp/catalog.ts`) pinned to the official
  `@brave/brave-search-mcp-server` — spawned from the installed package's bin, never `npx`.
  The GUI lives at `/mcp` (mobile/web); per-conversation server switches are in the agent
  Inspector (`conversations.mcpOverrides`).
- **GitHub is a second built-in, of a different kind: its credential is the GitHub connection.**
  `CatalogEntry` is a union — stdio entries carry `secretKeys` the user types; the http entry
  carries `credentials: "github-connection"` and stores nothing in the row. `PUT
  /v1/github/connection` provisions it and `DELETE` removes it (`mcp/github-server.ts`, the only
  code that creates or deletes that row); `client-manager.ts` reads the *row owner's* token through
  `getOwnerToken()` and sends it as `Authorization: Bearer` to GitHub's hosted server
  (`https://api.githubcopilot.com/mcp/`). One copy of the token, so rotating or revoking it in
  Settings → GitHub is the whole story. Users who connected before this existed get the row from
  `backfillGithubMcpServers()` at boot; tests must pass its `ownerId`, because an unscoped run
  from a test provisions every connection in the shared database (its first draft did, 206 rows).
- **Its address is resolved at connect time, never read from the row.** The row records the
  public endpoint for display; the real one comes from `resolveUrl()` each time. Every server on a
  machine shares one database, and the e2e harness boots with `GITHUB_MCP_URL` pointed at a mock —
  storing that would leave other people's GitHub tools aimed at a dead loopback port, with the
  SSRF guard lifted, after the harness exited.
- **Read-only GitHub tools start allowed, decided on first discovery.** `reconcileTools` takes a
  `defaultPolicyFor`, and `catalogDefaultPolicy(row)` answers allow+readOnly for names in
  `GITHUB_READONLY_TOOLS`. Not pre-seeded into `toolPolicies`: a stored policy the server does not
  list is marked `missing`, GitHub has renamed tools before (`get_issue_comments` → `issue_read`),
  and a stale pre-seeded name would sit in the Tools sheet as "missing" forever. The policy and
  the tool's hash are recorded together, so a schema change still revokes the grant.
- **The prompt has to say the tools exist.** `GITHUB_TOOLS_ADDENDUM` (`mcp/sanitize.ts`) is appended
  whenever a github tool is actually *offered* — not merely enabled, since planning mode hides the
  write ones and a failed connect contributes none. Without it the first real session did exactly
  what the sandbox invites: asked about issues, reached for `curl`, got nothing (a sandbox has no
  network), and told the user it could not see GitHub at all — with all 45 tools sitting unused in
  that same request. Knowing a tool is in the list is not the same as knowing to reach for it.
- **The linked row cannot be deleted while GitHub is connected** (409 naming the two things that
  do what the user wants: switch it off, or disconnect GitHub) — deleting it would only have it
  come back on the next reconnect. Once the connection is gone it is an ordinary row, so a crash
  between disconnect's two deletes never leaves one stuck. A hand-made server already using slug
  `github` is never renamed or taken over: connecting still succeeds and `mcp.ok: false` says why
  the tools are missing.
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
  Three bounds sit around it, because the checkout is one the model writes to freely: the
  helper list is **reset** first (`-c credential.helper=` — `-c` appends, and a `store` helper
  in the server account's own gitconfig would otherwise be handed the token by git's
  post-auth `approve` and write it to `~/.git-credentials`; `file://` clones never consult a
  helper, which is why the test could not see it); the helper answers **only for the host the
  token was issued for** (`$LOXAIC_GIT_HOST` from the clone URL, read from the `host=` line git
  writes to its stdin — `credential.useHttpPath` does *not* scope a custom helper); and hooks,
  fsmonitor and proxies are off for the credentialed command, which alone carries the token
  (the checkout/config steps after a clone get none). What this does **not** close is an
  actively adversarial process in the container — a shim `git` on PATH — which shares the
  exec's uid; the sturdier shape is pushing from the server against a bundle, a follow-up.
- **Full clone, not `--depth=1`.** Shallow made `git log`, `blame` and `diff <base>` — the first
  things a model reaches for — empty or wrong. Paid once per conversation; the checkout is kept
  (stop-and-resume).
- **GitHub workspaces need sandbox networking**, which containers lack unless an admin enabled
  it. The chooser reads `GET /v1/config` and refuses GitHub *with the reason and the fix* rather
  than hiding it; a coding agent that cannot `npm install` is not one. `SANDBOX_EXTRA_HOSTS`
  (`host:ip`, comma-separated → `HostConfig.ExtraHosts`) exists so a networked sandbox can
  reach a service on the host by name on Linux/Podman.
- **`REPO_RE` alone admits `..`**, and `repos/../user` normalises to `/user` in the API URL — a
  200 whose body is the viewer, once persisted as a workspace with an undefined repo. Traversal
  segments are refused, and the lookup's answer must describe a repository. The chooser resets
  its repo half on open too (or the previous conversation's repo came up pre-selected with the
  *same* generated branch name), and a container choice does not survive onto a machine
  without an engine.
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
- **A stored token that can no longer be decrypted is `GithubTokenUnreadableError`**, not a
  500: the key changed after the token was written (the outcome the module's own "set
  `MCP_ENCRYPTION_KEY`" warning invites). The repo and branch routes answer 409 "disconnect and
  reconnect"; workspace creation turns it into a 400 with the same words. Derived keys are
  cached per salt — `scryptSync` on every request that needed the token stalled the whole
  event loop, every other user's stream included. `listRepos`/`listBranches` follow
  `rel="next"` up to ten pages on the API's own origin; one page of 100 meant anyone with more
  repos than that could not pick the older ones.
- `PUT /v1/github/connection` validates the token against GitHub (`getViewer`) before storing
  anything — a bad token fails at connect time, not on the first clone three steps later (a
  later stage).
- **The token has a third consumer: the GitHub MCP server** (see "MCP servers"). It reaches that
  server only as a request header built in `mcp/client-manager.ts`, and is redacted from every
  error there via the connection entry's `redactions`. `getOwnerToken()` is still the only decrypt
  site. `GET`/`PUT /v1/github/connection` report `mcp: { ok, serverId, enabled } | { ok: false,
  error }`; a provisioning failure never fails the connect, because the token still clones.

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
- **`findSandboxRow` is scoped to the conversation owner's rows**, because every action here
  runs in whatever it returns — Push with the owner's PAT in its environment — and a row that
  merely *names* the conversation must not be enough (see the `POST /v1/sandboxes` owner
  check). **Push refuses (409) unless `git remote get-url origin` matches the workspace's
  `cloneUrl`**: `origin` lives in a `.git/config` the model writes to, and `set-url` is one
  bash call away. Status checks both exit codes — a failed `git status` is a 500, not a clean
  tree with Commit greyed out; a failed rev-list reports `ahead`/`behind` as `null`, which the
  panel shows as "?" and never treats as 0. Only a 422 whose body says "already exists" is
  the lost-PR 409; "No commits between base and head" reaches the user as GitHub's own words.
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
  **The roots bound the file verbs and where a command starts — not what `exec` runs.** A
  direct workspace runs the model's shell commands as the user, and `cat ~/.ssh/id_ed25519`
  is a shell command; that is what "Direct — commands run as you, with no sandbox" means, and
  why a local workspace on a server one does not trust with one's login session should be a
  *container* one. The header used to claim the roots stopped a hostile host reading the key.
  **An executor id belongs to the user who first registered it**: `registerExecutor` replaces
  a same-user connection (a restarted desktop) and refuses a cross-user claim with 4003 — the
  id is a UUID in a config file, not a secret, and a stranger who learned it could otherwise
  evict the machine and receive its owner's commands and terminal keystrokes.
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
- **Neither `numberOfLines` nor the `truncate` class truncates a gluestack `Text` on web —
  `lib/truncate.ts`'s `TRUNCATE_TEXT` is what does.** `numberOfLines` is inert because the web
  override renders a raw `<span>` and spreads props onto it. `truncate` is worse than inert
  because it half-works: `overflow: hidden` and `text-overflow: ellipsis` land, so the class
  looks applied, while its `white-space: nowrap` loses to the `whitespace-pre-wrap` that
  `components/ui/text/styles.tsx` puts in the web base class of *every* Text. UniWind resolves
  both to **inline styles**, so no stylesheet rule matches the element at all and no class
  ordering, `!` or `web:` prefix can win — the symptom is a computed `white-space: pre-wrap` on
  a span whose class list plainly contains `truncate`. This is how #185 was fixed twice: the
  first fix added `truncate`, typechecked, read correctly, and changed nothing on screen. Pair
  it with `min-w-0` on the flex parent, which is a separate requirement (above) — truncation
  without it just moves the overflow.
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
- **Un-approving a folder must not make its container unstoppable.** `stop`/`destroy` resolve
  "for release" — the executor-label check only — while every other verb re-checks the folder.
  Gating removal on approval meant the one path that could remove a container mounted on a
  withdrawn folder was refused exactly when removing it was urgent, and nothing else ever
  reclaims these. The server-supplied id is shape-checked (`[0-9a-f]{12,64}`) *before* it goes
  into an Engine API path; a machine holds at most eight Loxaic containers (`MAX_LOCAL_CONTAINERS`,
  counted by label — deleting a conversation is what brings it down); and the engine is
  cached and re-checked with a bounded ping, since `attachLocalContainer` is on the path of
  every call and used to re-walk every candidate socket, with no client timeout, per tool call.
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
- **The terminal socket bounds what one owner can cost the server**: eight terminals per user
  (the executor's own `MAX_TERMINALS`, reserved *before* the open's await so racing opens
  cannot all pass), and output past 1 MB of unsent socket buffer is dropped rather than
  queued — a terminal is a live view, so losing backlog is the right answer. `openTerminal()`
  itself is guarded: it was the one await on the still-paused socket that no `refuse()`
  covered, so an executor dropping in that window left the client waiting out its own
  timeout for a bare 1006 instead of the 4503.
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

### Tailscale from the GUI (the tsnet sidecar)

- **`infra/tsnet-proxy` runs in two directions and `supervisor/tsnet.js` drives both.**
  `client` proxies a local port to a tailnet host (a desktop Client); `serve` publishes the
  local server on the tailnet with an automatic HTTPS cert (a Host), plus `--funnel` for the
  public internet. The sidecar's stdout is a line protocol — `AUTH_URL`, `LISTENING`
  (client), `SERVING` (serve), `STATUS` — and everything the renderer sees
  (`stackState().tailnet`: `off | starting | needs-auth | up | error`) is derived from it.
  At most one sidecar runs; `main.js`'s `tsnet.key` says what it is for.
- **Configuration has exactly one write path: `setMode`.** `host.tailnet` and
  `client.via`/`controlUrl` ride in the same `config.json` as everything else, through
  `buildConfig`. The `tailnet.*` IPC channels (`getState`, `openAuthUrl`, `restart`) are live
  state and two actions, never settings. `openAuthUrl` takes no URL: the main process opens
  the link the *sidecar* printed, so a page cannot ask it to open an arbitrary address.
- **The auth key rides stdin, first line, and lives in `secrets.json`** — never
  `config.json` (read by the renderer, safe to log), never argv (`ps`), never env. `setMode`
  peels `authKey` off the payload (`extractAuthKey`) before `buildConfig`, which strips it
  again defensively; `hasTailnetAuthKey` tells the form whether one is stored, and the form
  never shows it back. Absent means keep, empty means forget.
- **A tailnet host's first start runs the server child twice, deliberately.** The
  `https://….ts.net` address is only known once the sidecar has joined — on a first run,
  after a person approves the node in a browser, which can take minutes — and better-auth
  reads the origin it signs cookies for at boot. So the stack comes up on the LAN address
  (usable immediately), the sidecar is started *without* being awaited, and on `SERVING` the
  server child alone is restarted with the tailnet URL via `stack.setAdvertiseUrl()` (Postgres
  stays up; the API base URL does not change). An explicit `advertiseUrl` wins and skips the
  restart, as it does everywhere else. `tailnet.spec.ts` asserts `effectiveAdvertiseUrl`
  becomes the ts.net address: nothing else could set it.
- **Launch never blocks on a tailnet.** `startForConfig`'s `wait` is true only for a person
  who just pressed Save/Connect and is looking at the approval card; the launch path waits
  `LAUNCH_TSNET_GRACE_MS` and otherwise opens the window and lets the join finish in the
  background — there is no window to show a prompt on until it returns. The old client path's
  five-second limit fell back to probing precisely while the person was approving the machine
  it had just asked them to approve.
- **The browser is auto-opened only on the `TSNET_TARGET` env path**, which has no GUI to
  show a card. The config-driven paths show the card with an "Open in browser" button. This is
  also what keeps the e2e from opening real browser tabs.
- **`TSNET_TARGET` (env) still outranks `client.via: "tsnet"` (config)** — same rule as every
  other env override in `resolveApi()`.
- **Serve and client state directories are separate** (`<dataDir>/tsnet-serve`,
  `<dataDir>/tsnet`): two different nodes, and one state file cannot hold two keys. The client
  one is the path the pre-GUI sidecar used — `dataDir()` is Electron's own `userData` in a
  default install — so a client approved before this existed keeps its identity.
- **`explainExit` turns a dead sidecar into a sentence**: the sidecar's own `tsnet-proxy:`
  fatal line first, a tsnet `health(…): error:` line second, and otherwise the last thing the
  shell or OS said. That last clause is how the e2e's exit-126 was diagnosed (below), and why
  the Retry button has something to show.
- **`LOXAIC_TSNET_BIN` is test-only** (one-time warning, read from the app's own env, same as
  `LOXAIC_E2E_PICK_DIR`). The Electron e2e sets it for *every* run so no test can reach the
  real control plane. `fixtures/fake-tsnet.sh` speaks the protocol; the hostname it is given
  picks the script (`*-fail-*` exits with the certificate message, `*-slow-*` delays).
- **The fixture is copied out of the checkout into a temp dir before use.** A repo under
  `~/Documents` is TCC-protected on macOS, and a packaged app launched by chromedriver — not by
  a terminal whose Files-and-Folders grant it could inherit — is refused when `bash` opens the
  script there: exit 126, "Operation not permitted", while the identical spawn from a shell
  works. It cost most of a stage to find, because the app reads its *own* bundle under
  `~/Documents` fine (its own files are exempt).
- **Never `ButtonSpinner` outside a `Button`.** It reads the parent Button's style context and
  throws without one, which unmounts the whole React tree — a blank window, with no error
  boundary to say why. `TailnetStatusCard`'s `starting` branch did exactly that, for the one
  second a fresh host spends there, and the e2e saw a black window with `innerText.length ===
  0`. `components/ui/spinner` is the standalone one.
- **The onboarding column is a `ScrollView`**, not a centred `Box`: the Host step with its
  tailnet fields is taller than a short window, and gluestack's `min-h-0` on every Box/VStack
  lets a flex column *compress* its children into each other rather than overflow — the same
  failure the Inspector hit. Centred while it fits, scrolls once it does not.

### Electron

- **Every package ships `THIRD_PARTY_NOTICES.txt`, `LICENSE`, `NOTICE`, Electron's licence and
  Chromium's, in the app's resources.** `scripts/third-party-notices.mjs` builds the first
  from what the app actually carries — the server payload, the desktop's production
  dependencies, the web client's (a superset, deliberately), embedded-postgres' bundled
  libraries and the sidecar's Go modules — and runs in every `package*` script. It **fails the
  build** on a required npm dependency that is not installed, a package with neither a licence
  nor a licence file, or a shared library no entry in `licenses/native-libraries.json`
  matches: those native libraries ship with no licence text, so the manifest (and the texts
  beside it) is the only record of them, and a new one upstream must stop a release rather
  than ship unattributed. The Windows build is the one that carries the most (libcurl,
  wxWidgets, winpthreads, `libpqwalreceiver.dll`), and no local test sees it — after an
  embedded-postgres bump, run `collectNative` over each platform's tarball. Electron's and
  Chromium's licences sit beside `Electron.app`, not inside it, so a macOS bundle had neither;
  the notices step copies them into `resources/electron-licenses/`. **Never from
  `node_modules/electron/dist` alone**: pnpm skips electron's install script (it is not in
  `onlyBuiltDependencies`), so CI and the release runners never have that directory —
  electron-builder downloads Electron for itself. The step falls back to the same release
  zip through electron's own `@electron/get`, checksum-verified. The first version read
  `dist/` and passed every local run, and CI's first run after going public failed on it.
  `embedded-postgres` does not
  export its `package.json`, so `require.resolve` cannot find its platform package — go
  through `collectNpm`, which is how a test of this first passed without running.
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
  and `loxaic:pickDirectory`, plus pushed `loxaic:stackState`, `loxaic:executorState` and `loxaic:power`).
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
  walks the steps by their call counts to the one `stepIndex` lands on — `stepIndex` being the
  count of tool messages the current turn already holds (one per *call*, so a multi-call step
  consumes several), computed once in `mockStream` and handed in rather than recomputed, so the
  two can never disagree about which step an iteration is on. Indexing steps by it directly
  made a two-call step skip the step after it. A step **bypasses** the single-call rule
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
  bare `Text` with no testID), and `chat.toolCall.<callId>` / `chat.toolCall.result.<callId>` on
  `ToolCallCard` (root box and the diff/plain-result `ScrollView`, whichever renders, both keyed
  by the tool call's own `callId` — a constant id on a per-call element is ambiguous the moment
  two cards are expanded).
- **A stale `apps/mobile/dist` web export is invisible until you look for it.** `ensureServer()`
  reuses a healthy server and `ensureWebExport()` reuses an existing export unless
  `E2E_FRESH_WEB=1` — so a spec asserting on a testID just added to `apps/mobile` can fail with
  "still not displayed" while a screenshot taken at the same failure shows the feature rendering
  *correctly*, because the served bundle predates the change. The symptom (`isDisplayed()` false,
  `data-testid` absent from the DOM, feature visibly working in a screenshot) means "rebuild the
  export," not "debug the component."

### Killing a command inside a container

- **The Docker Engine API has no kill-exec call**, and that is the API we speak to *every*
  engine through dockerode — `Exec` offers `start`, `resize`, `inspect` and nothing else. So
  Docker, Podman, OrbStack and Colima all behave identically here; it is not a Docker quirk to
  work around by preferring another engine (verified directly: Podman leaves an exec's process
  running after the client detaches, exactly as Docker does).
- **So the kill happens inside the container's own userspace.** A cancellable exec runs as
  `setsid -w bash -c 'trap … EXIT; echo $$ > <pgidfile>; "$@"' _ <command>`, and cancelling is an
  ordinary second exec that reads the file and signals the **process group**. Engine-agnostic by
  construction, because nothing is asked of the engine beyond running a command.
- **`setsid -w`, not bare `setsid`.** Plain `setsid` forks and the parent exits immediately, so
  the exec would report success the instant the command *started*. `-w` waits and returns the
  child's status, which is what keeps the wrapper invisible in the result.
- **Not `exec "$@"`.** That replaces the wrapper shell, so anything it was holding — the marker,
  the chance to record the group — is gone before the command runs.
- **A PGID file, not `pgrep -f <marker>`.** The marker appears in `setsid`'s own argv too, and
  `setsid` is *not* in the new group — so pgrep's first match leads to killing the wrong group
  and leaving the real tree alive. `$$` recorded from inside the new session is unambiguous.
- **Kill the group, not the pid**: `bash -lc "npm install"` has grandchildren and they are what
  hold the CPU. The host provider spawns `detached: true` for the same reason — its old timeout
  `SIGKILL`ed only the direct child and left the rest running.
- **This fixed the timeout as much as it fixed Stop.** A container command that blew its 60s cap
  was never killed, only detached from; it kept running until the container was reaped. Both
  paths now go through the same kill.
- **Every exec is wrapped, not only a cancellable one.** The timeout needs the same marker, and
  gating it on a signal left a timed-out clone, a wedged document extraction (the one exec
  whose input is untrusted) or a REST exec merely detached. `exec-cancel.test.ts` guards the
  wrapper itself: an uncancelled wrapped command must still return its own stdout, stderr and
  exit code, since a wrapper that swallowed those would break every exec while the
  cancellation cases stayed green.
- **A signal that is already aborted never starts the command — on all three providers.** After
  a Stop every remaining call in a batch arrives so. Starting anyway raced the wrapper (the
  killer read a PGID file the shell had not written, and the caller was told exit 130 for a
  command that then ran), and on the host provider the early return skipped the child's
  `error` listener, so an async spawn failure was an uncaught exception. The killer also
  *waits* for the marker (bounded) rather than reading it once, and is awaited until it
  finishes, so "the command is gone" is true when it returns. Host-mode children are
  `detached`, which also detaches them from the parent's death: live groups are killed on
  process exit.
- **Checking `aborted` once, at the top, is not enough — re-check after every await that comes
  before the listener.** `addEventListener("abort")` on a signal that has *already* fired never
  fires. `execInContainer` checked, then awaited `container.exec()` and `exec.start()`, and only
  then attached its listener, so a Stop landing during those Engine API round trips was lost
  outright and the command ran to completion (a sweep of abort delays: every one under ~5 ms on
  an idle engine, longer on a busy one). It now re-checks after `container.exec` (nothing has
  started: return without starting) and after attaching the listener (the command is running:
  take the kill path). It surfaced only as a batch call behind a Stop echoing its output in a
  full-suite run of `stop-abort.test.ts`, never alone. `exec-cancel.test.ts` holds each re-check
  with its own case, since one abort can only land in one window: a `setImmediate` always lands in
  `container.exec`, and the `exec.start` one is placed exactly by wrapping dockerode's `exec` so
  the abort fires as `start` is called. Each fails only when its own re-check is removed. The host provider has no await in that gap, and
  `callExecutor` checks `aborted` where it registers — the pattern to copy anywhere a signal
  crosses an await.
- Needs `setsid -w` from util-linux: present in the Ubuntu-based sandbox image, **absent from
  busybox**, so a base-image change needs this re-checked. (Alpine's `ps` also lacks `-o pgid`,
  which is how the first draft was caught.)

### Stopping a run

- **A stop is only as good as the places that check the signal.** `stream.stop` calls
  `run.abort.abort()` and nothing else; every part of the loop that can block has to notice.
  Two did not, and between them made "the stop button does nothing" the *ordinary* experience
  (#113): `waitForApproval` settled only on approve/deny or the approval timeout, so a stop at a
  permission prompt — manual mode, the default — parked the run for up to five minutes; and the
  per-call loop never re-checked, so a stop during a batch still ran every remaining call. A real
  session issued **five calls in one assistant message** and took 6m39s over them.
- **A stop at a step check-in unwinds the same way a stop at an approval does.**
  `waitForStepsDecision` takes the run's abort signal for exactly the reason `waitForApproval`
  does, and re-entering the queue for an aborted run throws `RunSlotAbortedError`, which the
  check-in's own catch turns into `producer.end("cancelled")` after setting `activeLeafId`.
  The tool results from before the question are real work and stay; no nudge is written,
  because stopping is not asking for an answer. What this does *not* do is clear the question
  from the record log — see "A finished stream's snapshot carries no pending question" above.
- **An unanswered approval is not a denial.** `waitForApproval` returns an `ApprovalOutcome`
  (`approved | denied | timeout | aborted | gone`) rather than a boolean, because the caller used
  to render every `false` as "User denied this tool call." — a claim about a person that three of
  the four cannot support. A beta session had the model conclude the user had refused the same
  call twice, five minutes apart, when no prompt had ever reached them; the recorded gap was
  5m06s, the timeout plus the generation before it. `denied` keeps that exact sentence, `aborted`
  reuses the per-call stop wording, and `timeout` says plainly that nobody refused. The timeout
  text deliberately stops there and does **not** suggest allowlisting: "Allow always" patches one
  server's per-tool policy for an MCP tool but `user_prefs.tool_allowlist` — global and
  mode-independent — for a builtin, and `timeout` is the one outcome carrying no evidence of what
  the user wanted, so the branch with the weakest evidence must not carry the strongest
  recommendation. The registry's resolver stays `(approved: boolean) => void`, so both WS
  handlers need no change.
- **How long a wait lasts is per user, with `APPROVAL_TIMEOUT_MS` as the server default**
  (#196). Precedence: `user_prefs.checkin_timeout_ms` / `approval_timeout_ms` (separate — "may
  this run?" and "keep going?" are different questions) → `APPROVAL_TIMEOUT_MS` (ms) → the
  built-in **10 minutes** (it was 5, which a 22-minute prompt evaluation on the beta box made
  incoherent). The columns are **nullable and null means "server default"** — a choice the
  settings screen names with its actual length (`GET /v1/prefs` returns read-only
  `serverDefaults`). Deliberately the *opposite* precedence to the sandbox settings, where an
  env pin outranks the row: those are deployment-wide security decisions, this is how long one
  person is willing to be waited on, and a parked run holds no slot for a pin to protect. The env
  is read at call time (vitest shares one process; tests set it to 50 ms, below the 5 s floor a
  pref may take). Everything is clamped to 24 h, far below Node's `2**31 - 1`, where a larger
  `setTimeout` delay silently becomes **1 ms** and would expire every wait instantly.
- **Adaptive windows stretch to twice the run's slowest model request** (`adaptive_timeout`,
  default on): on a backend where one step takes twenty minutes, ten minutes to answer is not
  a real offer. Timed around `streamCompletion` alone — never the iteration, which includes
  approval waits, or one long-unanswered approval would lengthen every later window.
- **One deadline per wait, computed before the event is emitted**, so the wire and the timer
  agree: `approval.request` and `steps.checkin` carry `timeout_ms`, `expires_at` and
  `timeout_basis`, and the check-in also `on_timeout`/`unattended`/`auto_continues` for the
  countdown's "I'll keep going (1 of 2)". `expires_at` is on the server's clock, so the client
  converts once on receipt (`lib/pendingWaits.ts`): a live event counts `timeout_ms` from now, a
  snapshot is corrected by the `server_now` its `stream.sync` carries.
- **Loop sensitivity is a pref too** (`normal` = the old fixed 3 / 2×, `relaxed` = 5 / 3×, `off`).
  It only ever concerns identical *calls*; time spent waiting on the model is never repetition,
  whatever it costs.
- **`case "aborted"` is unreachable in practice, and kept deliberately.** An abort does resolve
  the wait, but `slot.yieldWhile` then re-enters the queue and `enter()` refuses an aborted
  signal, throwing `RunSlotAbortedError` before the outcome is ever inspected. That ordering is
  deterministic, not a race — the throw always wins — so the old boolean code could not have
  written "denied" on an abort under any interleaving. The per-call catch writes the stop result,
  which is what `stop-abort.test.ts` asserts.
- **Tool calls in one message run in series, so abort is checked per call, not per iteration.**
  A skipped call still emits and persists a `tool_result` saying it was stopped — an
  assistant `tool_call` with no partner is the orphan case `loadHistory` has to strip, and
  most backends reject it outright.
- **Aborting at an approval unwinds through `slot.yieldWhile`, and is recorded like a skip.**
  The approval hands the inference slot back; re-entering the queue for an aborted run throws
  `RunSlotAbortedError`. The per-call loop catches it for *that* call — nothing ran for it —
  and records the same "stopped" result a skipped call gets, so the calls before it that did
  run (and did write) keep their results in the transcript and the prompt; the per-call check
  then skips the rest and the abort branch ends the turn. Letting the throw escape the loop
  used to skip the insert entirely: a batch stopped at its second approval lost the first
  call's result, and the model had no record a file it had written existed.
- **An in-flight `exec` is cancellable on all three providers.** `ExecOptions.signal` carries the
  run's abort signal. It never goes *on* the wire for the executor — an `AbortSignal` serialises
  to `{}` — it rides beside the call, and aborting sends `exec.cancel {id}`, which the executor
  turns back into a signal for that call's `handle.exec`. So the kill happens by the same
  process-group machinery on the user's own machine.
- **`exec.cancel` does not settle the pending call.** The executor kills the command and then
  answers the original call as normal, so the partial output survives and the promise resolves
  through the path it already had; the existing timeout stays the backstop for an executor too
  old to know the message. The abort listener is removed when the call settles, or a later abort
  would send a cancel for an id the executor has already forgotten.
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

### Environments on the box

- **`scripts/envs.sh` deploys from your workstation, and nothing in GitHub can reach the
  box.** A self-hosted runner, an SSH key in repository secrets, or a tunnel would each end
  with something in GitHub holding a credential to a machine on a home network — and once
  this repository is public, a fork's pull request is a stranger's code. So the workstation,
  already authenticated to GitHub, pushes to the box over an SSH key that already exists;
  the box needs no GitHub access, no inbound port, and no secrets. Which pull requests get
  deployed is whichever numbers get typed.
- **The slot's configuration comes from the workstation's checkout, never from the commit
  being deployed.** `compose.yml` and `metro.Dockerfile` are sent over after `git clean`.
  Otherwise a pull request could rewrite the terms it runs under — mounting the Docker
  socket, say — and a pull request opened before this tooling existed would have no
  `compose.yml` at all and be undeployable, which is most of them.
- **One preview slot on fixed ports, because the Expo Go URL is typed by hand.**
  `exp://<host>:42001` has to be the same link for every pull request, so `preview up`
  replaces rather than adds. Only one PR can be previewed at a time — an accepted cost.
- **A preview changing pull request drops its database first; the dev slot never does.** Two
  branches can carry different migrations, and one branch's schema on the other's data fails
  in ways that belong to neither. Redeploying the *same* PR keeps its volumes so you stay
  signed in; the dev slot holds long-lived test data and migrations are forward-only, so
  moving the trunk forward is not a reason to drop it (`dev down --volumes` is).
- **Dev runs a real model, previews run the mock.** A preview runs unreviewed code to check a
  flow quickly, and mocking means several a day cost nothing. The dev slot is merged code, is
  what the dev app build talks to, and the things only a real model shows — tool-call
  formatting, streaming timing, the prompt-reuse figures — are what a standing private
  environment is for. There is one dev slot, so it cannot queue behind itself.
- **The env file lives outside the build context.** It carries the slot's
  `BETTER_AUTH_SECRET`, and `server.Dockerfile` does `COPY . .` while `.dockerignore` does
  not exclude `.env` — so an env file inside the worktree baked the secret into an image
  layer *and* invalidated the `COPY` cache on every config change, turning a short redeploy
  into a full workspace reinstall.
- **Metro listens on its published port inside the container as well as outside.** Expo
  builds the URL it hands the phone from its own listening port and knows nothing about a
  port mapping, so the conventional `42001:8081` would advertise `exp://host:8081` — a port
  nothing serves.
- **`scripts/envs.local` is gitignored (`*.local`) and holds the box's address.** The
  repository is public; where someone's home server lives does not belong in it. The
  script refuses to run rather than defaulting to anyone's machine.
- **An environment is isolated from the *box*, not from the network.** No Docker socket and
  no credentials — but both containers have unrestricted egress to the LAN and the internet,
  and the build runs the deployed commit's own `pnpm install` (and so its lockfile's
  postinstall scripts) as root. That makes this safe for code you have read and unsafe as a
  sandbox for code you have not; deploying a fork's pull request is running a stranger's
  build scripts on your LAN.
- **Uncertainty about the preview slot's contents refuses rather than proceeds.** Reading the
  state file over ssh can fail, and "I cannot tell what is deployed" used to be
  indistinguishable from "nothing is deployed" — which chose to keep the volumes, so the next
  deploy would run one pull request's migrations on another's database. Likewise `sync` tears
  the slot down only on a definite `CLOSED`/`MERGED`: it runs unattended every five minutes,
  and any other answer, including failing to get one, leaves the slot alone.

### Releases and over-the-air updates

- **The version lives in the git tag, nowhere else.** All three version fields
  (`apps/desktop/package.json`, `apps/server/package.json`, `apps/mobile/app.json`) are `0.0.0`
  in the repository and `apps/desktop/scripts/stamp-version.mjs` writes the real number during
  the release run. **Do not "fix" those zeros** — a committed version is a second source of
  truth that drifts from the tag, and the point of stamping is that it cannot.
  `parseReleaseTag` accepts `vX.Y.Z` and `vX.Y.Z-beta.N` and nothing else, and the same parser
  is what CI's `meta` job uses, so a tag can never mean one thing to the stamp and another to
  the workflow.
- **Three apps, one config.** dev, beta and production are separate apps — separate display
  names, bundle identifiers, package names, schemes and update channels — and
  `apps/mobile/app.config.js` is the only place that table lives. `APP_VARIANT` picks one;
  unset is production (so `expo start`, Expo Go and a plain `expo export` all work), and an
  unrecognised value throws rather than quietly building production under a name nobody
  meant to ship. The build profile in `eas.json` carries the matching `APP_VARIANT`, so
  `--profile beta` is the only thing that has to be right.
- **`app.config.js` overlays `app.json`; it does not replace it.** `stamp-version.mjs` writes
  the release version by parsing and re-serialising that JSON, so a config that existed only
  as JavaScript would leave the stamp nothing to write to. The dynamic config passes
  `version` through untouched, which is the half of the contract it has to keep — and
  `app.json` keeps everything identical across variants.
- **A variant is its own runtime version, so `eas update` must run with the same
  `APP_VARIANT` as the build it targets.** The fingerprint policy hashes native config and
  the bundle identifier is native config, so the three variants hash differently — which is
  what makes the release build gate a per-platform, *per-variant* question. An update
  published under the wrong variant reaches nobody, and the only symptom is the gate
  starting a native build it "should not need".
- **A runtime version is per platform as well as per variant.** The fingerprint hashes native
  config, which differs between iOS and Android, so `eas update` publishes two updates for two
  runtimes and the build gate asks each platform about its own. The second release run
  published successfully and then failed in our own step, which assumed one runtime across both
  (`expected one runtime version, got ["16ae…","e92e…"]`) — so the build step never ran and no
  beta app was built. The publish step now emits `runtime_ios` and `runtime_android`, and fails
  if either platform is missing or reports more than one.
- **`Updates.channel` is simply the truth about an install, and nothing overrides it.** The
  channel is embedded by `app.config.js` from `APP_VARIANT`, so a build follows one channel
  for its whole life. There was a runtime override and a stored preference
  (`loxaic-update-channel`); both are gone, along with the question they created — "which
  channel is this on?" had two possible answers, the one the build embedded and the one
  someone tapped, and the Settings row could disagree with the headers being sent. A person
  who wants beta installs the beta app.
- **`checkAutomatically: "ON_ERROR_RECOVERY"` is still deliberate**, for a different reason
  now that the native layer would ask for the right channel anyway: JS drives every check, so
  a download never competes with one the native layer started, and the reload stays something
  the person taps in the banner rather than something a launch decides. The native path
  remains as crash recovery.
- **Nothing here ever reloads the app on its own.** `checkNow` downloads and stops; the
  restart is a banner the person taps. Automatic checks are throttled to 15 minutes and
  single-flighted; "Check now" bypasses the throttle, because that is someone asking.
- **A release is cut by `scripts/release.sh`, from your workstation, and CI does the rest.**
  `apps/desktop/scripts/next-tag.mjs` decides the version from the tags that exist — betas
  continue an unreleased line rather than starting a new one, a plain bump refuses while a
  newer beta is outstanding and names `promote` instead, and `promote` tags *the beta's own
  commit* rather than `dev`'s head, because releasing what the testers ran is the point.
- **Never pipe a command into `grep -q` under `pipefail`.** `grep -q` exits on its first match,
  the writer's next write lands on a closed pipe, and the *pipeline* fails even though the match
  succeeded. The release workflow's prerelease check did exactly this — `stamp-version --parse`
  writes `prerelease=` on the second of three lines — and `v0.0.1-beta.3` lost the race,
  classified as stable, and was built and published as production as well as beta. It is a race,
  so earlier tags passing proved nothing. Capture the output, then match it with a here-string
  (`grep -qx … <<< "$out"`), as the feed guard, the meta step, `scripts/envs.sh`'s
  `slot_running` and `fake-tsnet.sh`'s `in_env` check now all do. The race can only ever turn a
  match into a miss, so a check whose "yes" is the alarm (a leaked key) is where it hides.
- **The meta step branches on the parsed `prerelease` value, never on whether a match was
  found.** Exactly `true` is beta, exactly `false` is stable, and anything else fails the step.
  `set -e` on the capture only catches a non-zero exit; `--parse` exiting 0 with no output (which
  `invokedDirectly()` has caused before) would otherwise fall through to the stable branch and
  publish a beta tag as production from a green run.
- **The release workflow is a matrix over variants, and the build gate is per variant.** Each
  variant has its own bundle identifier, the fingerprint policy hashes native config, so their
  runtime versions differ — a finished build of one says nothing about the other. `APP_VARIANT`
  is set for the whole `expo-update` job so the config a publish runs against is the one the
  matching build used; a mismatch publishes an update that reaches nobody and reports nothing.
- **`advance-branches` moves `beta` and `master` only after the release has published *and*
  the mobile update has**, with a non-forced push: a branch pointer means "this shipped", and
  a tag cut from an older base fails there rather than rewriting what a branch says.
  `GITHUB_TOKEN` pushes never trigger workflows, so this cannot start another CI run.
  **`expo-update` has to be in its `needs` for that to hold**: `if: success()` evaluates over
  a job's own needs and nothing else, and `publish-release`'s gate deliberately tolerates a
  failed `expo-update` — so without it a failed mobile publish undrafted the
  desktop release, moved both pointers, and consumed the tag with no mobile update published.
  `publish-release` still tolerates it on purpose: the installers are real and uploaded, and a
  desktop release is worth having; it is the *pointer* that must not claim more than happened.
- **The installer-asset guard has to check for "no assets at all" separately.** `printf '%s\n'
  ""` emits one empty line, which `grep -vc '^Loxaic-Beta-'` counts — so an empty asset list
  produced a stable count of 1 and published a release with nothing installable, which is the
  exact inverse of the guard's purpose. **Nor is an installer proof that a platform finished**:
  the first release's Linux leg uploaded its AppImage, failed building the `.deb`, and the guard
  published a release holding one of six installers. Every platform that uploaded an installer must
  also have left its *feed* (`.dmg`/`.zip` → `beta-mac.yml`, `.AppImage`/`.deb` →
  `beta-linux.yml`, `.exe` → `beta.yml`; `latest*` for stable), because electron-builder writes
  a platform's feed only after every target for it has built. **Checked per platform, not as a
  total**: a count lets a finished macOS vouch for a Linux leg that stopped halfway, and that
  release's AppImages would never update again. A platform with no installer at all is still
  allowed — `fail-fast: false` exists so a release missing one platform ships the others.
- **Only `dev` builds an APK; beta and production go to Play as App Bundles.** An earlier
  design attached an APK to the GitHub release from an `android-apk` job — that job and that
  reasoning are both gone, replaced by store submission (see the Play listings bullet below).
  The dev app keeps its APK because it is installed from a link rather than submitted.
- **"Does this runtime have a build?" is the only question the gate answers, and the skip
  branch must therefore skip.** When a finished build already exists for this runtime and
  variant, the store is taken to already have it — from the release that built it, or from the
  bootstrap. That assumption is not uniform across platforms and nothing in CI can verify it:
  iOS bootstraps with `--auto-submit-with-profile`, but **Play refuses an API upload to a
  listing with no prior release**, so Android's first bundle is uploaded by hand in Play
  Console (`docs/DEPLOY.md`) — miss it and every release at that fingerprint skips against an
  empty store and still reports success. Submitting again
  is not merely redundant, it cannot run: `eas submit --non-interactive` throws unless given
  `--id`/`--latest`/`--path`/`--url`, and there is no implicit latest-build fallback.
  Supplying one only relocates the failure — `--latest` filters on platform, distribution and
  status but **not** build profile or runtime version, so it can pick the wrong binary, and
  `--id` re-sends something the store already took (Apple ITMS-4238, Play's reused
  `versionCode`). Retrying a genuinely failed submission is a person running `eas submit --id
  <build-id>`, which is a different job from releasing the JS that just changed.
- **EAS holds the App Store Connect key; GitHub holds only `EXPO_TOKEN`.** But the submit
  profiles cannot be empty: non-interactive `eas submit` will not look an App Store Connect
  record up from the bundle identifier (only interactive mode does), so each iOS profile
  carries `ascAppId`. It is not a secret. The claim that the record resolves itself was
  documented, reviewed and wrong, and cost the second release its TestFlight upload. The
  Android counterpart is the Play service-account key, which likewise can only be added to EAS
  interactively ("Google Service Account Keys cannot be set up in --non-interactive mode"). The alternative (`ascApiKey*` in eas.json, or `EXPO_ASC_*`
  with the `.p8` as a repository secret) would put an Apple credential in CI for no benefit.
- **CI cannot create credentials.** `eas build --non-interactive` can only use what already
  exists, so the first build of each platform *and each variant* has to be run by hand once —
  that is what generates the Android keystore and registers the iOS certificate and profile.
  A release run that fails with a credentials error is almost always this, not a broken
  workflow.
- **Both platforms submit on build completion, and neither goes live.**
  `--auto-submit-with-profile` schedules the upload server-side, so `--no-wait` still holds:
  iOS to TestFlight or App Store Connect, Android to that variant's Play listing on the
  **internal** track. EAS uploads and does not release — an external TestFlight group needs a
  Beta App Review, an App Store release needs the button in App Store Connect, and a Play
  release means promoting the internal build in Play Console. A tag push must never reach
  every user unreviewed.
- **Beta and production are two Play listings, not two tracks.** They have different package
  names (`com.loxaic.app`, `com.loxaic.app.beta`), which is what lets a tester keep both
  installed — the same model as iOS and the desktop. Only `dev` builds an APK, because it is
  installed from a link rather than submitted; the store profiles take EAS's App Bundle
  default, which Play has required for new apps since 2021.
- **Play refuses an API upload to an app that has never had a release**, so the first App
  Bundle for each listing goes through the Play Console by hand. This is the most common
  reason a first automated submission fails, and it looks nothing like its cause.
- **The mobile app is stamped with the *numeric* version, even on a beta tag.** `expo.version`
  becomes `CFBundleShortVersionString`, and Apple requires period-separated integers —
  `1.2.0-beta.1` is rejected at upload (ITMS-90060), server-side, long after a `--no-wait`
  build reported success. So a beta would silently never reach TestFlight from a green run.
  The desktop and server keep the full version, because electron-updater's feed rules are
  built on the prerelease component; a beta build is told apart on mobile by its build number
  and the channel it reports — which is why `describeVersion` renders `nativeBuild`. It
  collected that field and never displayed it, and suppressed `nativeVersion` as equal to
  `appVersion`, so beta.1, beta.2 and stable all read `App 1.2.3` in the one line a bug report
  is meant to quote.
- **A store failure on one platform must not stop the other being queued.** iOS is simply
  first in the loop, and `--auto-submit-with-profile` adds up-front failure modes an Apple
  account can produce (expired key, missing app record) — under `set -e` those aborted the
  step before Android was reached. Failures are collected per platform and the step fails
  after both have had their turn, which keeps failing-closed without coupling the platforms.
- **A JS-only release produces no new store build**, which is correct rather than a failure:
  the runtime version has not moved, so everyone receives the update over the air and the
  TestFlight and Play version numbers stay where they are.
- **A release tag publishes to `production` *and* `beta`.** Beta must stay a strict superset,
  or opting in would strand someone on an older build than the stable release they would
  otherwise have had.
- **A native build is started only when the runtime has none.** With the `fingerprint` runtime
  policy, a native or dependency change makes a new runtime version and an update published
  for it reaches no existing binary — but a JS-only release reuses the runtime, and building
  every time would cost 20-40 minutes and a queue slot for nothing. `release.yml` asks
  `eas build:list` for a finished production build at that runtime and builds only on none;
  `force_native_build` overrides it. Stamping cannot move the runtime version by itself: the
  fingerprinter ignores `version`/`buildNumber`/`versionCode`.
- **Expo Go cannot open a published update** — an update is built for a runtime version only a
  real build has. Expo Go is for Metro, and the docs say so; do not add an Expo Go path to the
  update workflows.
- **Web has to be excluded by hand.** expo-updates' web shim hardcodes
  `isEnabled = true` while implementing none of the API — no
  `setUpdateRequestHeadersOverride` at all, and a `reload()` that is a page refresh — so
  `isSupported()` checks `Platform.OS` first. Without that the settings row rendered on the
  web app, which has nothing to update: the server serves it and it changes when the server
  does. `specs/updates.spec.ts` is what caught it and is the only place this code runs on web.
- **`lib/expo-updates.ts` is the only file that imports `expo-updates`.** Every call in that
  module throws outside a native release build, so the guard lives in one place (`isSupported`)
  and everything else — the settings row, the banner, the hook — is written without platform
  guards of its own. The one thing that cannot sit behind an early return is `useUpdates()`,
  since a hook has to be called on every render; `useUpdateState()` calls it there and masks
  what it *reports* to inert values, which is how the rule stays true rather than
  true-except-for-that-hook.
- **`startUpdateChecks()` reads nothing from storage, which is why it no longer waits for
  hydration.** It used to, and the gate was load-bearing: `hydrateStorage()` is awaited inside
  `SessionProvider`'s effect while child effects run first, so an ungated call read an empty
  cache, latched `production` for the life of the process, and put every beta user back on
  Stable at each cold launch while Settings showed Stable selected. Removing the stored
  channel removed the race rather than the guard — worth knowing before anything else in this
  layer starts reading a preference at launch.
- **Over-the-air updates are not code-signed, and on Expo's pricing that is a fixed fact rather
  than a to-do.** EAS gates update code signing to its Enterprise plan: the first release run
  got as far as `🔒 Signing updates` and was refused server-side ("EAS Update code signing
  requires a subscription to the EAS Enterprise plan"). A full signing design had been built,
  reviewed and merged before any publish was attempted against this account — a two-minute
  `eas update --private-key-path` on a throwaway channel would have found it — so ask the
  paid-tier question *first* for any EAS feature. What unsigned means: whoever holds
  `EXPO_TOKEN` or the Expo login can publish JavaScript that every installed app runs, on
  every channel, so 2FA on that account and the handling of that one secret are the entire
  defence. `expo-update` names `environment: release` so that token can move behind required
  reviewers — but `dev-update.yml` reads the same token on every push to `dev`, so the gate
  protects nothing until that workflow has a token of its own. The route back to signing is a self-hosted updates server (expo-updates speaks a
  published protocol, and signing is free when the server is ours). **Do not re-add
  `codeSigningCertificate` while updates come from EAS**: a build that embeds a certificate
  refuses every unsigned update for as long as it is installed.

### The desktop updater

- **A whole new binary, not a bundle — but one row.** `hooks/useAppUpdates.ts` has
  two backends (`electron-updater` through the desktop bridge, expo-updates on native) and the
  settings row and banner are written once against the shape they share. Both hooks are called
  unconditionally and one is selected: whether a desktop bridge exists is fixed for the life of
  the process, but hooks may not be called conditionally on *anything*, and expo-updates' web
  implementation is inert rather than absent.
- **"Loxaic Beta" is a separate desktop application, decided at package time.**
  `LOXAIC_VARIANT` picks it (`scripts/builder-variants.cjs`), and it gets its own `appId`,
  product name, artifact name and — crucially — its own data directory, so beta and stable can
  be installed at once without two servers fighting over one embedded Postgres. The running
  app learns which it is from `src/variant.js`, reading the `extraMetadata` electron-builder
  stamped into the packaged package.json; `asar: false` is what makes that file readable.
  Setting top-level `productName` there also fixes something that was quietly wrong before:
  Electron derives `app.name` (and therefore `userData`) from it, and without it fell back to
  `@loxaic/desktop` while `defaultDataDir()` said `Loxaic`.
- **That fix moves the stable app's `userData`, and it is a one-time re-login.** `userData` is
  the *Chromium profile* — localStorage, cookies, session storage — so an install made before
  this change keeps its session in `.../Application Support/@loxaic/desktop` while the new one
  reads `.../Loxaic`. The result is an app that looks freshly installed: signed out, theme
  reset. **The database is untouched**, because `defaultDataDir()` always said `Loxaic`, which
  is exactly what makes this easy to misdiagnose — the conversations are all still there, the
  person just cannot see them until they sign in again. No release has ever been published, so
  the only installs affected are local development builds; a migration for that is more
  startup machinery than the transition is worth, but it has to be in the release notes of the
  first tag that carries it.
- **The beta variant pins `autoUpdater.channel = "beta"`, and `allowPrerelease` alone would be
  a bug.** With only `allowPrerelease`, GitHubProvider walks the releases feed and takes the
  newest entry *whether or not it is a prerelease*, then asks that release for `latest*.yml` —
  so a beta install would replace itself with the **stable** app the first time a release tag
  landed. Pinning the channel makes it ask each release for `beta*.yml`, which the beta variant
  publishes on every tag (`publish.channel: "beta"`). A beta tester therefore receives every
  release, always as the beta app. Stable sets neither and uses `/releases/latest`, which
  GitHub defines as excluding prereleases.
- **Assigning `channel` flips `allowDowngrade` to true**, in electron-updater's own setter. It
  is put back to false immediately afterwards, and the order is load-bearing — the fake in
  `updater.test.js` imitates that side effect precisely so the ordering cannot break silently.
- **The row stays visible on the desktop even when checks are off**, with the reason. A build
  that silently never updates is indistinguishable from one that is up to date, and the case a
  person is least likely to guess is the one that matters most (a `.deb`, which really does have
  to be updated by hand). Off means: not packaged, `LOXAIC_DISABLE_UPDATES=1`,
  `--loxaic-no-updates`, or Linux without `$APPIMAGE`.
- **`shutdownChildren()` is shared by the quit handler and the updater, and the order in
  `install()` is load-bearing.** It stops the children and *awaits* them, then sets `quitting`,
  then calls `quitAndInstall`. `quitAndInstall` closes the windows and only then emits
  `before-quit`; that handler must find `quitting` already true and step aside, because its
  `app.exit(0)` would kill the process out from under Squirrel's and NSIS's handover. And the
  children have to be down first regardless: the installer is about to replace the binary they
  were spawned from, with Postgres mid-write.
- **`state.js` is a pure reducer with no `require("electron")` anywhere**, which is what makes
  the two decisions worth having testable at all: an error clears when the next check *starts*
  (checks fail for passing reasons — a laptop that just woke — and an error that never clears is
  a permanent accusation in Settings), and a downloaded update is **sticky** (the six-hourly
  timer keeps running, and its `checking`/`not-available` events would otherwise walk "an update
  is ready" off the screen for one that is still on disk).
- **The release is drafted first and undrafted last.** GitHub's `/releases/latest` and its Atom
  feed both skip drafts, so nothing installed can see a release whose installers are still
  uploading — or one where a platform failed to build. `create-release` makes the draft (once,
  idempotently, so three matrix legs cannot race to create it), each leg uploads into it with
  `EP_DRAFT=true`, and `publish-release` flips the switch. `fail-fast: false`, because a release
  missing Windows is still worth having for the other two.
- **`asar: false` means `mac.target` must include `zip`.** MacUpdater downloads the zip, not the
  dmg; the dmg is what a person installs by hand.
- **The update channel has no authenticity check on Windows or Linux.** electron-updater's
  Windows signature check compares the downloaded installer's publisher against the running
  app's own certificate — with neither signed it is a no-op, and Linux has nothing equivalent.
  What is left is the `sha512` in `latest.yml`, generated and uploaded by the same job into the
  same release as the installer it vouches for: anyone who can write an asset there gets
  automatic code execution on every install. macOS is the exception once signed and notarized.
  That is why the release workflow's `contents: write` is scoped to the three jobs that touch the
  release and every action is pinned to a commit — the workflow publishes binaries clients
  auto-install, so a mutable tag there is a supply-chain seam.
- **A failed install is not allowed to be silent.** Three things had to change together:
  `beforeInstall()` is bounded and caught (its rejection into a `void` left the person in an app
  whose backend was already down, still being told an update was ready); the reducer's
  sticky-`ready` rule has an `installing` exception (`quitAndInstall` reports failure by emitting
  `error` at status `ready`, which the rule absorbed); and the renderer's bridge calls `.catch`
  into the error state rather than being `void`ed. And `quitting` is claimed only *after* the
  children are down — set before the await, a Cmd-Q mid-shutdown stepped aside and exited with
  Postgres mid-drain.
- **The draft is reused on a re-run only while it is still a draft.** `gh release view` succeeds
  for a published release too, so an unguarded "already exists → exit 0" let a re-run upload into
  a *live* release with `EP_DRAFT=true`, rewriting `latest.yml` while clients polled it. A
  published tag now fails the run with a message; deleting the release first is the deliberate
  act it should be. And `publish-release` runs on `always()` minus cancellation, then counts
  installer assets before undrafting: a matrix job concludes `failure` if any leg does, so the
  default needs-gate stranded every release missing one platform as a permanent draft — the
  opposite of what `fail-fast: false` was added for.
- **The Electron e2e pins `LOXAIC_DISABLE_UPDATES=1`.** A `--dir` build is packaged as far as
  `app.isPackaged` is concerned, so without it every run would ask GitHub for a release feed and,
  on a machine where a release exists, start downloading an installer mid-suite.
- **`E2E_SELF_CONTAINED=1` runs a subset and always has.** `standup()` returns before
  `ensureServer()` in that mode, and `ensureServer()` is what provisions the per-run admin
  account and points the server at the mock GitHub API — so every admin-requiring spec (the
  sandbox and agent ones) and the GitHub one fail there by construction, with a message saying
  so. Compare a red self-contained run against a default-mode one before concluding anything.
- **The lazy `import("electron-updater")` needs `mod.default.autoUpdater`, and only a packaged
  launch could say so.** It is CommonJS and defines `autoUpdater` with a `defineProperty` getter,
  which Node's cjs-module-lexer cannot see — so the ESM namespace a dynamic `import()` produces
  carries *no* `autoUpdater` named export. Every unit test passed because a hand-written fake
  module has real named exports; the packaged app failed on its first real launch with "Cannot
  set properties of undefined (setting 'logger')". One test now imitates the real shape.
  (The same launch also showed each failure logged twice, because `checkForUpdates` rejects
  *and* emits `error`.) A `--dir` build has no `app-update.yml` at all — electron-builder writes
  one only for a real target — so enabling updates there always reports that ENOENT.
- **Not verified by anything yet**: electron-updater's actual behaviour against a real release —
  the prerelease walk, `private` + `token`, `quitAndInstall` after a normal quit, `$APPIMAGE`.
  Windows packaging has never been exercised at all, and macOS installs are unsigned until
  signing lands.

### macOS signing and notarization

- **`identity: null` is gone, on purpose, and must not come back.** It used to mean "never sign,
  always" — but a config field applies to CI the same as a contributor's laptop, and CI is
  exactly where signing has to happen. The right way to get an unsigned local build back (no
  cert on this machine, or deliberately skipping it) is the env var
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, which is a per-invocation choice rather than a committed
  one. Restoring `identity: null` would silently turn every release build unsigned again.
- **Without a cert at all, packaging still succeeds — it just warns.** `forceCodeSigning`
  defaults to false, so a machine with zero identities in its keychain (verified directly: this
  one) falls back to an unsigned/ad-hoc build with a warning in the log, not a failure. That is
  what every `package:dir` run on this repo has been doing all along; B4 only changes what
  happens when a real certificate *is* present.
- **The three hardened-runtime entitlements are not optional decoration.**
  `build/entitlements.mac.plist` grants `allow-jit` and
  `allow-unsigned-executable-memory` (Electron/V8 need to allocate and execute JIT'd machine
  code, which the hardened runtime refuses by default — the app crashes on launch without
  these) and `disable-library-validation` (hardened runtime otherwise refuses to load a dylib
  not signed by the same Team ID as the app — and `asar: false` means node_modules' native
  bindings are plain files on disk, signed by their own upstream publishers, not by us). No
  App Sandbox entitlements are present: this is a plain Developer ID app, not a Mac-App-Store
  one, so sandbox keys like network-client would be inert clutter, not protection.
- **`entitlements`/`entitlementsInherit` point at the same file.** There is no separate
  sandboxed login-helper process here that would need the narrower inherited set the option
  exists for — one file covers both because both signing passes need the same three grants.
- **`gatekeeperAssess: false` is not "skip verification," it is "skip a check that cannot pass
  yet."** electron-builder's post-sign Gatekeeper assessment runs immediately after signing,
  before notarization has happened and long before the notarization ticket is stapled — a
  signed-but-not-yet-notarized app fails that assessment by construction. The real check is
  `spctl -a -vv -t install` against the stapled build, done once notarization has actually run.
- **Notarization needs all three of `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`, and is silently skipped with none of them.** electron-builder's own
  `getNotarizeOptions` throws if exactly one or two of the three are set (a half-configured
  secret set should fail loudly, not notarize wrong), but returns `undefined` — no error, a log
  line — when none are set at all. That is what makes a contributor's local `package:dir`
  keep working with no Apple account involved. `notarize: true` in package.json is declarative
  documentation of the intent; the behavior is identical whether that key is present or absent,
  since only `notarize: false` changes anything.
- **The five signing/notarization secrets reach exactly one step, on exactly one platform.**
  Declared job-wide they sat in the environment of `pnpm install` — and every third-party
  postinstall script it runs — on all three runners; "only electron-builder reads them" was
  true and beside the point. And "read only on darwin" was wrong twice over: **Windows has its
  own read** (`WIN_CSC_LINK` falls back to `CSC_LINK`, and `win` names no certificate, so the
  Apple `.p12` would have signed the NSIS installer), and **an unset GitHub secret expands to
  `""`, which electron-builder does not treat as absent** — `""` passes its `== null` guard,
  reaches `importCertificate`, resolves to the project directory, and throws "not a file", so
  the first tag after `identity: null` was removed would have failed macOS packaging outright.
  The package step's shell unsets anything empty and everything on a non-macOS leg; the
  `environment: release` on the `desktop` job is the enabler for moving the key behind required
  reviewers, which a repository secret — readable by a workflow on any branch — cannot be.
  electron-builder still imports `CSC_LINK` into a throwaway keychain itself; nothing else is
  needed.
- **Every nested Mach-O binary needs a valid signature for notarization to succeed, not just the
  app itself.** `asar: false` is why osx-sign walks and signs the embedded Postgres binaries and
  the `tsnet-proxy` sidecar along with everything else in the bundle — Apple's notarization
  service rejects a submission containing *any* unsigned executable, wherever it lives inside
  the `.app`. `codesign --verify --deep --strict` is what proves this actually happened; it
  cannot be exercised without a real Developer ID certificate, which this environment does not
  have.
- **Nothing here has been verified against a real Apple account.** The whole signing and
  notarization path — a real `codesign`, a real notarization submission and its ticket, `spctl`
  accepting the stapled result, `xcrun stapler validate` — needs Apple Developer credentials in
  repository secrets and a release tag actually pushed. Confirmed instead: packaging still
  succeeds both unsigned (no keychain identity) and with signing explicitly suppressed
  (`CSC_IDENTITY_AUTO_DISCOVERY=false`), the entitlements plist parses, and the workflow YAML
  and its embedded shell are both syntactically valid.

- **Signing a bundle this size needs the runner's file limit raised, and `ulimit` alone does not
  raise it.** `@electron/osx-sign` opens every file at once (`walkAsync` runs `isBinaryFile`
  inside an unbounded `Promise.all`), the app holds ~16,000 files, and a `macos-15` runner caps a
  process at 10,240 through `kern.maxfilesperproc` — so the second release died with `EMFILE`
  mid-signing. Reproduced on the runner against osx-sign's own walk: defaults fail, `ulimit -n
  65536` alone fails, `sudo sysctl kern.maxfilesperproc` plus `ulimit` passes. The package step
  does both, on macOS only. Nothing local reproduces it, because a Mac's own limit is
  effectively unlimited.
- **The certificate must be *Developer ID Application*; an *Apple Development* certificate signs
  and cannot be notarized.** The second release signed every binary with an Apple Development
  certificate and Apple rejected all 133 of them, the main executable and Electron Framework
  included, with "The binary is not signed with a valid Developer ID certificate". When *every*
  binary is rejected, suspect the certificate type before suspecting a missed nested file.
  `security find-identity -v -p codesigning` names the type; check it before exporting the
  `.p12` into `CSC_LINK`.

## Conventions

- pnpm workspaces + Turborepo; packages scoped `@loxaic/*`; TypeScript strict.
- Minimal changes; match existing file style; don't add deps without a reason.
- **`dev` is the trunk — every pull request targets it**, and it is the default branch.
  `master` and `beta` are git release pointers: they mark what has shipped, not what someone
  merged. `release.yml`'s `advance-branches` job moves them once a release has fully
  published — every tag fast-forwards `beta`, a stable tag also moves `master` — with a
  non-forced `GITHUB_TOKEN` push. That is why their ruleset blocks only deletion and force
  pushes: a user-owned repository cannot name the GitHub Actions app as a ruleset bypass, so
  "restrict updates" would stop the release from moving them. `dev` requires a pull request
  and the CI and DCO checks; `v*` tags can be created only by an admin.
  A hotfix pull request straight to `master` is the one legitimate exception, which is why CI
  still runs on both `master` events. Nothing is *developed* on either pointer.
- **The git `beta` branch and the EAS `beta` channel are unrelated.** `release.yml` publishes
  with `eas update --channel beta`, which targets Expo's own channel and never touches a git
  ref — see `docs/DEPLOY.md`.
- **Every commit carries a DCO sign-off** (`git commit -s`, which adds `Signed-off-by:`),
  checked on each pull request by the DCO app — see `CONTRIBUTING.md`. That includes commits
  an agent makes.
- **Issue and PR numbers cited in this file and in code comments refer to this repository's
  history**, including items opened while it was private.
- **A release is cut from `dev` by pushing a `vX.Y.Z` tag**, which is the only thing that sets
  a version — `release.yml` fires on `push: tags: ['v*']`, with a `workflow_dispatch` input
  for re-publishing an existing one. See "Releases and over-the-air updates".
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
