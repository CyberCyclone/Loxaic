# AGENTS.md

**Read `docs/IMPLEMENTATION.md` first.** It is the source of truth: architecture, locked
decisions, data model, stage plan, and a "Where We Are" section that says what to do next and
which model should be doing it. Update its §12 at every stage boundary.

## Project in one line

Self-hosted, multi-user Claude + Claude Code replacement: llama.cpp inference on a Docker
host, custom agent harness, sandboxed code execution, offline-first clients with conversation
forks, accessed over Tailscale from web / Expo / Electron.

## Layout

- `apps/server` — Fastify API + WS + harness + sync + sandbox orchestrator
- `apps/web` — Vite + React SPA (plain React with CSS classes from `design/shannon.css`)
- `design/` — Source of truth for UI: complete OpenDesign prototype + `design/react/src/` React components that are copied into `apps/web/src/design-components/` and used directly
- `packages/ui` (Gluestack v5 + NativeWind — used only by mobile/Expo)
- `apps/mobile` — Expo app
- `apps/desktop` — Electron (Stage 7)
- `packages/ui` (Gluestack v5 + NativeWind), `packages/agent`, `packages/sync`,
  `packages/api-client`, `packages/db` (Drizzle), `packages/config-*`
- `infra/` — Dockerfiles, Tailscale doc

## Commands

```bash
pnpm install
pnpm dev                  # turbo: server (4000) + web (5173) with hot reload
docker compose up --build # full stack: db, server, web (4001), inference (4002)
pnpm --filter mobile start
```

## Gotchas

### TypeScript + React Native

- **JSX files must use `.tsx` extension** — TypeScript ignores JSX in `.ts` files.
- **`@types/react-native` conflicts with named imports** (`View`, `ViewStyle`). Three
  packages set `skipLibCheck: true` to work around this: `packages/ui`, `apps/web`,
  `apps/mobile`. Don't remove these without verifying the full `pnpm typecheck` passes.
- **Design token values are numbers** (e.g. `fontSizes.sm: 14`, not `"14px"`). React
  Native (and react-native-web) converts them to px automatically.

### DB / Drizzle

- **Never import from `drizzle-orm` directly** in server or web packages. `packages/db`
  re-exports all operators (`eq`, `and`, `desc`, etc.) and the `db` instance. Import
  from `@shannon/db`. Two drizzle-orm instances in the dependency tree cause type errors.
- **No `users` table.** better-auth auto-creates `user`, `session`, `account`,
  `verification` on first request. App tables reference better-auth's user IDs.
- **Migrations auto-run on server startup** via `apps/server/src/db/migrate.ts`. The
  migration folder is `packages/db/drizzle/`. Run `pnpm --filter @shannon/db db:generate`
  after schema changes, then `db:push` in dev or let the server migrate on start.

### Inference

- **Set `MOCK_INFERENCE=true`** in `.env` for dev without llama.cpp. The inference
  provider echos back a mock response with fake timings.
- Real inference requires a llama.cpp server at `INFERENCE_BASE_URL` (default
  `http://localhost:4002`). The docker compose CPU image needs a GGUF model at
  `./models/model.gguf`.

### NativeWind / Web

- **NativeWind babel plugin fails on Vite** (both v4 and v5 preview). The web app uses
  **inline styles via react-native-web** — no Tailwind on web. Mobile uses NativeWind v4
  via Metro (working). Don't try to add NativeWind to the web build without first verifying
  the babel plugin loads in Vite's ESM context.

### Web build for Docker

- The web container serves `apps/web/dist/`. Vite builds to `dist/` via `pnpm --filter
  @shannon/web build`. The dist is also what Electron loads at runtime.
- The Vite dev server on port 5173 proxies `/health`, `/v1`, and `/ws` to the server.

## Conventions

- pnpm workspaces + Turborepo; packages scoped `@shannon/*`; TypeScript strict.
- Minimal changes; match existing file style; don't add deps without a reason.
- Ports: server 4000, web 4001, inference 4002, ntfy 4003, Postgres 5432 (dev-mapped).
- Build-time model routing: routine work → `qwen/qwen3.6-plus`, heavy reasoning →
  `deepseek/deepseek-v4-pro`, planning/large-context → `moonshotai/kimi-k3`. Announce the
  recommended model at each stage gate (see IMPLEMENTATION.md §5.1/§10).

## Theme System

- **Source of truth:** `design/` folder — HTML/CSS prototype with locked tokens, 11 hex palette,
  Public Sans font, dark-first + light mode. Read `design/docs/design-system.md` and
  `design/AGENTS.md` before touching UI.
- **Tokens:** `packages/config-style/design-tokens.js` exports `darkTheme`, `lightTheme`, and
  `tokens` (backward compat = darkTheme). All color values are pre-computed hexes — no
  `color-mix()` or `oklch()` in JS. Badge tints use 8-digit hex with alpha (e.g. `#0096ff26`).
- **ThemeProvider:** `packages/ui/src/theme/index.tsx` — `useTheme()` returns `{ theme, preference,
  setPreference, isDark }`. Persistence key: `shannon-theme` (`light|dark|system`, default `system`).
  Cross-tab sync via `storage` event. System resolution via `matchMedia`.
- **All components** must use `useTheme()` — never the static `tokens` export.
- **Font:** Public Sans self-hosted in `apps/web/public/fonts/`. `global.css` has `@font-face`.
- **No-FOUC bootstrap:** `apps/web/index.html` has inline script in `<head>` that reads
  `localStorage['shannon-theme']` and sets `data-theme` on `<html>` before React mounts.