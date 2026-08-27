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
pnpm --filter @shannon/mobile web # Expo web dev server (localhost:8081)
pnpm --filter @shannon/mobile ios # or android

pnpm --filter @shannon/desktop dev         # self-contained desktop app, dev mode (embedded stack, Metro web build)
pnpm --filter @shannon/desktop package     # prod build: mac dmg, linux AppImage + deb, windows nsis (untested)
pnpm --filter @shannon/desktop package:dir # prod, unpacked — faster iteration, what the e2e suite drives

pnpm test        # turbo test — vitest (only apps/server + apps/desktop have tests today)
pnpm lint        # turbo lint — eslint (apps/server)
pnpm typecheck   # turbo typecheck — tsc --noEmit across all packages
```

Tests are Vitest, colocated under `__tests__/` dirs. Run one package or one test:

```bash
pnpm --filter @shannon/server test               # all server tests
pnpm --filter @shannon/server test -- authz      # tests matching "authz"
pnpm --filter @shannon/server test -- src/streams/__tests__/drivers.test.ts
```

End-to-end suites are WebdriverIO, in `apps/e2e`, and run on demand (never as part of
`pnpm test`). They stand the whole stack up themselves:

```bash
pnpm --filter @shannon/e2e test:web        # see apps/e2e/README.md for setup + env vars
E2E_SELF_CONTAINED=1 pnpm --filter @shannon/e2e test:electron  # against the packaged app's own embedded stack
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
  found via XCUITest's `accessibility id` strategy (`~id`). The web and Android mappings are
  confirmed against real builds; the iOS one follows RN's documented behaviour but hasn't been
  run yet (see `apps/e2e/README.md`).
- Don't hand-roll these selectors in specs — use the helpers in `apps/e2e/src/helpers/`, which
  own the mapping.

### DB / Drizzle

- **Never import from `drizzle-orm` directly.** `packages/db` re-exports every operator
  (`eq`, `and`, `desc`, etc.) and the `db` instance — import from `@shannon/db`. Two
  drizzle-orm instances in the dependency tree cause type errors.
- **No `users` table.** better-auth auto-creates `user`/`session`/`account`/`verification`
  on first request. App tables reference better-auth's `user.id`, which is `text`, not `uuid`.
- **Postgres/postgres.js returns `SUM()`/`AVG()` over `integer` columns as strings**
  (bigint/numeric precision preservation). Cast to `::float8` in SQL, not `::int` (avoids a
  32-bit overflow ceiling on lifetime token sums). Columns typed `real` parse natively.
- Migrations auto-run on server startup (`apps/server/src/db/migrate.ts`). Migration folder:
  `packages/db/drizzle/`. Run `pnpm --filter @shannon/db db:generate` after schema changes.

### Inference

- **Set `MOCK_INFERENCE=true`** for dev without llama.cpp. Mock mode drives the full agent
  tool loop too — it emits a real (fake) tool call when the prompt mentions one, so the
  approval/deny/auto/planning paths are all testable without a GGUF.
- Real inference needs llama.cpp started with `--jinja` (native OpenAI tool calling) at
  `INFERENCE_BASE_URL` (default `http://localhost:4002`). See `docs/RUNTIME.md` for the
  per-platform (Mac/Windows/Linux, Metal/CUDA/ROCm) setup matrix.

### Agent tool loop

- `packages/agent` owns `TOOLS`/`toOpenAiTools`/`toolRequiresApproval` — the
  server and every client import from here so the protocol can't drift. The wire event
  union lives in `packages/types` (`StreamEventKind`), not here.
- Sandbox execution goes through `apps/server/src/sandbox/provider.ts`'s
  `SandboxHandle`/`SandboxProvider` interface — never a raw `Docker.Container`. Two
  providers: `container-provider.ts` (dockerode; Docker, Podman, OrbStack, Colima — any
  Docker-Engine-API-compatible socket, auto-discovered) and `host-provider.ts` (no
  isolation, agent commands run directly on the host — an explicit `SANDBOX_MODE=host`
  opt-in). Selected via `SANDBOX_MODE` (`container` default | `host` | `off`), read at
  call time — see `docs/RUNTIME.md`.
- Sandboxes are per-conversation, lazily created on first tool use, and **survive socket
  close** (reconnecting mid-task keeps the working directory) — see
  `apps/server/src/agent/sandbox-manager.ts`. An idle reaper stops them after 30 minutes.
  A sandbox row (`sandboxes` table) records which provider it belongs to; a mode switch
  mid-deployment makes old rows unusable rather than silently reattaching to the wrong kind.
- `web_fetch` always runs on the **server**, never in the sandbox — container sandboxes
  have no network (`NetworkMode: none`) and host-mode ones deliberately aren't trusted with
  an unfiltered fetch either. It has a real SSRF guard (DNS-resolves and rejects
  private/loopback/link-local answers, follows redirects manually so every hop is
  re-checked).
- The container sandbox image (`shannon-sandbox`) builds itself automatically on first use
  if missing — nothing needs to build it ahead of time (`ensureImage()` in
  `container-provider.ts`).

### Electron

- Never `loadFile()`/`file://` for the packaged build — expo-router's client-side routing
  needs the History API and every asset path is absolute (`/_expo/...`), both of which
  break under `file://`. Use `electron-serve`'s `app://` scheme (already wired in
  `apps/desktop/src/main.js`).
- There's no server at the renderer's origin (`app://` in prod, `localhost:8081` in dev),
  so unlike the mobile/web builds Electron can't assume same-origin. The main process
  resolves the real API URL and hands it to the renderer via a `contextBridge` preload
  script (`window.shannon.apiBaseUrl`) — see `apps/mobile/lib/endpoint.ts`.
- **`"asar": false`** in `apps/desktop/package.json`'s electron-builder config, deliberately.
  Electron patches `child_process.execFile` to transparently read out of `app.asar`, but not
  `spawn` — and `embedded-postgres` `spawn`s `initdb`/`postgres` from paths its own package
  exports (no custom-binary-dir option), while its postinstall also creates symlinks that
  asar-packing would silently drop. The app's own source is tiny (a handful of files), so
  nothing meaningful is lost by shipping unpacked.
- **`SHANNON_LISTENING <port>`** is a stdout handshake line the bundled server prints once
  `app.listen()` resolves (`apps/server/src/index.ts`) — the desktop supervisor
  (`apps/desktop/src/supervisor/server.js`) greps for it via `readline` instead of polling
  `/health`, mirroring the `tsnet-proxy` sidecar's own `LISTENING <addr>` handshake. Don't
  remove or reformat that `console.log` without updating the supervisor.
- **Release build vs `pnpm dev` never collide on one host, by construction**: the
  self-contained app defaults to port `4100` (`SHANNON_PORT`) with an embedded Postgres on
  an ephemeral localhost port, data under the platform user-data dir; the dev stack keeps
  `4000`/`5432`/compose volumes. The packaged app never reads the repo's `.env` — its child
  env is built entirely by the supervisor. See `docs/DEPLOY.md`'s ports/data-dir table.

## Conventions

- pnpm workspaces + Turborepo; packages scoped `@shannon/*`; TypeScript strict.
- Minimal changes; match existing file style; don't add deps without a reason.
- Ports (dev): server 4000, inference 4002, ntfy 4003, Postgres 5432, Expo web 8081.
  Self-contained desktop app (a separate deployment, coexists with dev on one host): server
  4100 (`SHANNON_PORT`), Postgres on an ephemeral localhost port — see `docs/DEPLOY.md`.
- **Semantic gluestack tokens only** for UI colors (`text-foreground`, `bg-primary`, etc.)
  — never numbered Tailwind colors (`gray-500`) or raw hex in className. `react-native-svg`
  can't resolve CSS custom properties, so SVG fills/strokes are the one exception: literal
  hex is correct there (see `ContextRing`, `TokensChart`).

## Theme system

- **Preference hook:** `apps/mobile/hooks/useTheme.ts` — `useThemePreference()` returns
  `[pref, setPref]`, `pref: 'light' | 'dark' | 'system'`. Persistence key: `shannon-theme`.
  Feed the value into `GluestackUIProvider`'s `mode` prop.
- **Tokens:** Tailwind v4 CSS-first config in `apps/mobile/global.css` (`@theme inline`,
  `@variant light`/`@variant dark`) — no separate design-tokens package. Dark is the
  design default. UniWind applies the active variant at runtime via `Uniwind.setTheme()`.
- The original static prototype under `design/` is a historical reference for the palette
  and layout, not something anything imports or builds against anymore.
