# AGENTS.md

**Read [`HANDOVER.md`](HANDOVER.md) first.** It's the source of truth for architecture,
the run matrix, and current state.

## Project in one line

Self-hosted, multi-user AI platform — a Claude + Claude Code replacement: llama.cpp
inference, a real agent tool-calling loop with sandboxed execution, one universal Expo
frontend (iOS/Android/Web/Electron), reachable remotely over Tailscale (or your own
reverse proxy).

## Layout

- `apps/server` — Fastify API + WS (chat + agent tool loop) + routines scheduler + sandbox orchestrator
- `apps/mobile` — the one frontend (Expo + expo-router + gluestack-ui v5), targets iOS/Android/Web
- `apps/desktop` — Electron shell that loads `apps/mobile`'s web export; embeds a Tailscale sidecar
- `packages/agent` — tool definitions, `AgentEvent` union, permission-mode logic (shared by server + client)
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
```

## Gotchas

### TypeScript + React Native

- **JSX files must use `.tsx`** — TypeScript ignores JSX in `.ts` files.
- **Relative imports in packages with no build step** (`packages/db`, `packages/agent`,
  `packages/sync`) **must include the `.ts` extension** (`from "./schema.ts"`, not
  `from "./schema"`). These packages ship raw TS — `apps/server`'s bundler (tsup) leaves
  them external, so they run under Node's native TypeScript support in production, which
  follows real ESM resolution rules (dev's `tsx` loader is more forgiving and won't catch
  a missing extension).

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

- `packages/agent` owns the builtin `TOOLS` plus the `ResolvedTool`/`ToolSource` types; the
  server's per-run `Toolset` (`apps/server/src/mcp/registry.ts`) resolves names, approval
  policy, and dispatch for builtins and MCP tools alike (see "MCP servers" below).
- Sandboxes are per-conversation, lazily created on first tool use, and **survive socket
  close** (reconnecting mid-task keeps the working directory) — see
  `apps/server/src/agent/sandbox-manager.ts`. An idle reaper stops them after 30 minutes.
- `web_fetch` runs on the **server**, not in the sandbox (`NetworkMode: none` — sandboxes
  have no network). It has a real SSRF guard (DNS-resolves and rejects private/loopback/
  link-local answers, follows redirects manually so every hop is re-checked).

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

### Dev mode

- A per-device Settings toggle (`Settings.devMode`) reveals the Raw I/O panel and dev-only
  catalog entries. Read it as `!!settings.devMode` — blobs saved before it existed lack the key.
- Telemetry rides an **ephemeral bus** (`apps/server/src/streams/debug-bus.ts`) and a top-level
  `debug.event` message, never the durable stream log: raw SSE lines are high-frequency and the
  memory driver doesn't evict an in-flight run, so the broker would grow RSS for the whole run
  and bloat every reconnect's catch-up read. Nothing is stored, capture lasts only while a
  client is subscribed, and every tap checks `hasDebugSubscribers` before building a payload.
- Channels: `model.request` (exact redacted request JSON), `model.raw` (raw SSE lines, batched
  64/100ms), `model.done`, `tool.call` / `tool.result_raw` (raw pre-sanitization result — the
  one place MCP success content is unwrapped, so it is redacted there), `mcp.lifecycle`
  (a server skipped by the per-server isolation, which is otherwise invisible).
- Payloads cap at 32KB (`capString`); the client keeps 300 entries and flushes state on a timer.
  `MOCK_INFERENCE=true` synthesizes request/raw frames so the panel works without a GGUF.
- "Mock MCP (dev)" is a catalog entry whose availability is **probed** (`canLaunch`) rather than
  gated on NODE_ENV — a prod install ships neither tsx nor the fixture, so it self-omits.

### Electron

- Never `loadFile()`/`file://` for the packaged build — expo-router's client-side routing
  needs the History API and every asset path is absolute (`/_expo/...`), both of which
  break under `file://`. Use `electron-serve`'s `app://` scheme (already wired in
  `apps/desktop/src/main.js`).
- There's no server at the renderer's origin (`app://` in prod, `localhost:8081` in dev),
  so unlike the mobile/web builds Electron can't assume same-origin. The main process
  resolves the real API URL and hands it to the renderer via a `contextBridge` preload
  script (`window.shannon.apiBaseUrl`) — see `apps/mobile/lib/endpoint.ts`.

## Conventions

- pnpm workspaces + Turborepo; packages scoped `@shannon/*`; TypeScript strict.
- Minimal changes; match existing file style; don't add deps without a reason.
- Ports (dev): server 4000, inference 4002, ntfy 4003, Postgres 5432, Expo web 8081.
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
