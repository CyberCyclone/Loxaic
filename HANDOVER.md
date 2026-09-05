# Handover — Loxaic

> **Deploy story has moved on.** Since this was written, the desktop app became
> self-contained (embedded Postgres, `--headless` mode, no Docker required to run it)
> and Docker Compose became one of two supported deployments rather than the only one.
> The Run matrix / Deploy sections below still work but describe the pre-pivot picture —
> see [`docs/DEPLOY.md`](docs/DEPLOY.md) for the current story, and
> [`AGENTS.md`](AGENTS.md) (the source of truth) for everything else.

Self-hosted, multi-user AI platform: a Claude + Claude Code replacement running on your
own hardware. All 9 build stages are complete. This document is the entry point for
picking the project back up — architecture, run matrix, deploy story, and what to know
before touching anything.

## What it is

- **Chat**: streaming conversation with a self-hosted llama.cpp model, conversation
  history, forks.
- **Agent**: a real tool-calling loop — the model reads/writes files, runs shell
  commands, greps/globs, fetches URLs, all inside a disposable per-conversation sandbox
  container, with planning/manual/auto permission modes and a live approval flow.
- **Routines**: cron-scheduled prompts that run into a conversation unattended.
- **Stats**: token usage, cache hit rate, per-model TTFT percentiles, broken down by
  time range.
- One account system (better-auth), reachable from a phone (Expo Go), a browser, or a
  packaged Electron app — over your LAN or, via Tailscale, from anywhere.

## Architecture at a glance

**One frontend, four targets.** `apps/mobile` is an Expo + expo-router + gluestack-ui v5
app. It compiles to iOS, Android, and — via `expo export --platform web` — a static web
bundle. That same web bundle is what both the browser and the Electron shell load; there
is no separate web codebase and no separate UI component library.

**Same-origin web hosting, no CORS.** `apps/server` (Fastify) serves the API and, if a
web build is present at `WEB_DIST_DIR` (default `apps/mobile/dist`), the static bundle
too — same origin, same port (4000). A browser just points at the server's URL for
everything.

**Electron is the odd one out.** Its renderer loads either Metro's dev server
(`localhost:8081`) or a packaged bundle through the `app://` scheme — neither has a real
server at that origin, so unlike every other build Electron can't assume same-origin.
Its main process resolves the real API URL (optionally through an embedded Tailscale
sidecar) and injects it into the renderer via a `contextBridge` preload script. See
[docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md#electron-desktop-app).

**The agent tool loop is real, not scripted.** `packages/agent` defines the tool schemas
and permission-mode logic. The server (`apps/server/src/streams/runs/agentRun.ts`) runs
an iteration loop against llama.cpp's native OpenAI-style tool calling (`--jinja`),
executing each tool call (`apps/server/src/agent/executor.ts`) inside a lazily-created,
per-conversation sandbox container that survives socket disconnects. `web_fetch` is the
one tool that runs on the server itself, since sandboxes have no network — it carries a
real SSRF guard.

**Streaming is durable and resumable, not a bare WS pipe.** Both chat and agent runs
write to a sequenced `StreamLog` (`apps/server/src/streams/` — in-memory driver for dev,
Redis Streams driver for prod) instead of pushing deltas straight to a socket. A client
reconnects with `stream.subscribe {conversation_id, cursors}` and gets one folded
`stream.sync` snapshot (everything so far) followed by live `stream.event`s — no lost
messages on a dropped connection, no reconcile-polling. `packages/types/src/
stream-protocol.ts` is the shared wire protocol for both surfaces. Real `stream.stop`
(the model actually stops generating, not just the socket closing). Every WS command is
authorized through one chokepoint (`streams/authz.ts`) so a user can never touch another
user's conversation, even by id.

**Offline-first sync groundwork** exists (`packages/sync` detects conversation forks;
messages carry `origin: "server" | "device"` and a Lamport clock) but device-side local
inference and full bidirectional sync were never built — see **Known gaps** below.

## Run matrix

```bash
pnpm install
ulimit -n 130000                          # macOS: Metro's watcher needs more than the 256 default

# Server (Postgres must be reachable — docker compose up db, or your own)
MOCK_INFERENCE=true pnpm --filter @loxaic/server dev   # no llama.cpp needed
pnpm --filter @loxaic/server dev                        # real inference at INFERENCE_BASE_URL

# Mobile / Web (same codebase, three ways to run it)
pnpm --filter @loxaic/mobile web          # Expo web dev server → localhost:8081
pnpm --filter @loxaic/mobile ios          # iOS Simulator
pnpm --filter @loxaic/mobile android       # Android emulator
npx expo start --tunnel                     # scan with Expo Go on a real phone

# Electron
pnpm --filter @loxaic/mobile web           # dev: needs Metro running (above)
pnpm --filter @loxaic/desktop dev          # loads localhost:8081
pnpm --filter @loxaic/desktop package       # prod: export:web + tsnet sidecar + electron-builder → dist/*.dmg
```

Full details, including Android emulator adb reverse-tunnel setup and EAS Update
(over-the-air phone updates with no dev machine): [docs/DEPLOY.md](docs/DEPLOY.md).

## Deploy

- **Server + web, same origin**: `docker compose up --build` (Postgres + server, which
  builds and serves the web export itself — see `infra/docker/server.Dockerfile`) or
  bare-metal via `pnpm --filter @loxaic/mobile export:web && pnpm --filter
  @loxaic/server dev`.
- **Remote access**: [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) — Tailscale Serve
  (recommended, free, no open ports) or bring your own reverse proxy.
- **Inference**: [docs/RUNTIME.md](docs/RUNTIME.md) — native llama.cpp with Metal on
  Mac, CUDA on Windows/NVIDIA, the provided ROCm compose override on Linux/AMD.
- **Phone**: Expo Go for dev iteration, or EAS Update for a no-dev-machine phone install
  ([docs/DEPLOY.md](docs/DEPLOY.md)).
- **Desktop**: `pnpm --filter @loxaic/desktop package` → an unsigned DMG (macOS) /
  NSIS installer (Windows) / AppImage (Linux) — code-signing isn't set up, so users on
  macOS will need to right-click → Open past Gatekeeper the first time.

## Layout

```
apps/
  server/    Fastify API + WS (chat + agent tool loop) + routines scheduler + sandbox orchestrator
  mobile/    the one frontend — Expo + expo-router + gluestack-ui v5
  desktop/   Electron shell (loads apps/mobile's web export) + embedded Tailscale sidecar spawn
packages/
  agent/     tool definitions, permission-mode logic — shared by server + client
  api-client/  typed REST + WS client, re-exports @loxaic/types' stream protocol for the UI
  db/        Drizzle schema + query operator re-exports
  sync/      fork/conflict detection for the offline sync protocol
  types/     shared primitives (ContentBlock, Result, etc.) + the stream-protocol wire types
  config-ts/ shared tsconfig bases
infra/
  docker/    Dockerfiles (server — also builds+serves the web export; sandbox image)
  tsnet-proxy/  Go module: Electron's embedded-Tailscale sidecar (see below)
  tailscale/ Tailscale Serve config
design/      the original static HTML/CSS prototype — historical reference, nothing imports it
docs/        DEPLOY.md, REMOTE_ACCESS.md, RUNTIME.md
```

### `apps/mobile` in more detail

```
app/(app)/          screens: chat, agent, routines, stats — each a thin screen over a hook
hooks/               useChatSession, useAgentSession, useRoutines, useStats — WS + REST wiring
components/
  chat/              MessageList, Message, ToolCallCard, ThinkingBlock, ThreadList
  agent/             AgentStream, RunHeader, Inspector, PermissionBar, PlanningBanner, ModeSelector
  routines/, stats/, composer/, settings/, shell/
lib/
  endpoint.ts        API base URL resolution (LAN/tailnet probing, Electron bridge, Settings override)
  session.tsx, storage.ts, diff.ts, types.ts
```

`useAgentSession` is the one worth reading before extending the agent surface — it
reconstructs full message history (including tool_call/tool_result joins by `call_id`)
from the REST API, and separately handles live WS events, including the case where a
tool call arrives with no preceding text (common with real models — there's no
`message_id` on `agent.tool_call` events, so it tracks a per-iteration placeholder that
gets promoted to the real id once one's known).

## Known gaps

Recorded here rather than left to be rediscovered:

- **Device-side inference and full offline sync were never built.** `packages/sync`
  exists and messages carry the fields a real sync protocol would need
  (`origin`/Lamport clock), but there's no on-device model runtime and no bidirectional
  merge — everything today is server-authoritative, online-only.
- **iOS only got a partial check, in Stage 8, not the full pass every other stage got
  on web + Android.** `expo start --ios` does successfully install and launch real Expo
  Go on a simulator with no App Store/Xcode project needed — confirmed working — and the
  login screen renders correctly there, matching web/Android exactly. Couldn't get past
  that first screen in this environment: touch injection needs either the simulator
  panel (gated behind a one-time permission grant only a human present at the machine
  can approve) or macOS's own Automation/`osascript` access to System Events (also not
  granted here — it's also what makes Expo CLI's own `--ios` auto-open step fail,
  worked around by starting Metro alone and opening Expo Go via `xcrun simctl openurl`
  instead). Nothing in the codebase is iOS-unsafe (no custom native modules anywhere,
  Expo Go compatibility maintained throughout), but a real sign-in-and-use-every-surface
  pass, the kind every other platform got, still hasn't happened.
- **Chat's client-side fork button doesn't create a real server-side conversation** —
  it clones local state with a new client-generated id, so sending into a forked thread
  fails on both surfaces with a clean "not found" error (as of the 2026-08-25 streaming
  rework, every `chat.send`/`agent.send` with a `conversation_id` is checked against
  `streams/authz.ts` before anything is written — this closed chat's old silent-orphan-row
  gap as a side effect, but the underlying fork feature is still not implemented). A real
  "duplicate conversation" server endpoint is the actual fix, still not built.
  `useAgentSession`'s fork has the identical limitation, inherited deliberately for
  parity rather than fixed ad hoc in one surface only.
- **Electron code-signing isn't set up** — `mac.identity: null` in
  `apps/desktop/package.json` produces a working but unsigned/unnotarized build.
- **The embedded Tailscale sidecar's full login round-trip was verified up to the
  point of a real `login.tailscale.com/a/...` auth URL being emitted** (confirmed via a
  live `tsnet` connection to Tailscale's control plane) but not past that, since
  completing it needs an interactive browser session with a real Tailscale account.
- **No code-review-style audit was done of `design/`'s original static prototype vs.
  the live app** beyond the per-stage spot checks recorded in each stage's own history —
  if pixel-level parity with the original mockups matters, that's a dedicated pass, not
  something already done.

## Conventions and gotchas

See [AGENTS.md](AGENTS.md) — TypeScript/import quirks, Drizzle rules, the agent tool
loop's shape, Electron's origin-resolution requirement, and the theme system.
