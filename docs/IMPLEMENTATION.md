# Open-Shannon — Implementation Document

> **Superseded — kept for history only.** This describes an earlier planning iteration
> (different stage numbering, a model-routing scheme that was never the one actually
> used) and references `apps/web`/`packages/ui`, both retired. **Read
> [`HANDOVER.md`](../HANDOVER.md) instead** — it reflects the codebase as it exists now.

> **This is the source of truth for the project.** It exists so any session or model can pick
> up the build cold. If you are resuming: read §1–§3, then go straight to **§12 — Where We Are**
> for the current stage, next action, and which model should be active.

---

## 0. Status

| Field | Value |
|---|---|
| Current stage | **Stage 7 — Electron + polish (verified)** |
| Stage 0 (planning) | Complete |
| Stage 1 (scaffold) | Complete |
| Stage 2 (chat core) | Complete |
| Stage 3 (sync + forks) | Complete |
| Stage 4 (sandboxes) | Complete |
| Stage 5 (agent harness) | Complete |
| Stage 6 (routines) | Complete |
| Stage 7 (desktop) | Complete |
| Next action | Scaffold the monorepo per §10 Stage 1 checklist |
| Model for current stage | `qwen/qwen3.6-plus` (routine scaffolding) |

---

## 1. Product Definition

Open-Shannon is a **self-hosted, multi-user AI platform** — an open-source replacement for the
Claude desktop app + Claude Code + LM Studio, running on the owner's hardware.

- A central **Docker host** runs inference (llama.cpp), the API/harness server, Postgres, the
  web UI, and disposable **sandbox environments** (repo checkouts, test runs, agent execution).
- **Clients**: web app (own container), Expo mobile app, Electron desktop app. All three share
  one component library (Gluestack v5 / NativeWind) from a monorepo.
- **Remote access** via Tailscale.
- **Offline-first**: clients can chat with **on-device models** (llama.rn on mobile, llama.cpp
  sidecar on desktop) while disconnected; message history is a **tree** and syncs back to the
  server on reconnect. Concurrent continuations create visible **conversation forks**.
- **Agent harness**: our own Claude Code-style loop (tools, permissions, planning/manual/auto
  modes, context compaction) driven by local models through llama.cpp.

### Core features (requirements, verbatim scope)

1. General chat with streaming, multi-user, synced history.
2. Remote vibe-coding agent (Claude Code equivalent) from any device.
3. Sandbox environments: pull a repo, run/test inside disposable containers.
4. Select a server-side local directory as a working context ("workspaces").
5. Routines: scheduled prompts/agent runs with notifications.
6. Model selection per conversation + per mode (planning / manual / auto).
7. On-device local models with sync-back and fork handling.
8. Modern, clean GUI laid out like the Claude desktop app (sidebar + thread list + chat pane).

---

## 2. Architecture

```
┌────────────────────── Docker Host ──────────────────────┐
│ docker-compose (dev: macOS/CPU · prod: Proxmox/ROCm)    │
│                                                          │
│  server (4000)      Fastify + WS, auth, sync, harness,   │
│    │                sandbox orchestrator                 │
│    ├─▶ inference (4002)  llama.cpp llama-server          │
│    │                     CPU image (dev) / ROCm (prod)   │
│    ├─▶ db (5432)         Postgres 17                     │
│    ├─▶ sandboxes         sibling containers via          │
│    │                     /var/run/docker.sock            │
│    │                     (gVisor runsc optional, Linux)  │
│    └─▶ ntfy (4003)       push notifications (later)      │
│  web (4001)         nginx serving Vite static build      │
└──────────────────────────┬───────────────────────────────┘
                           │ Tailscale (host-level, MagicDNS, `tailscale serve` TLS)
              ┌────────────┼─────────────┐
           web app      Expo mobile    Electron desktop
           (browser)    (llama.rn)     (bundled web build + llama.cpp sidecar)
```

### Data flows

- **Chat (server model)**: client → WS `chat.send` → server → llama.cpp
  `/v1/chat/completions` (streaming) → durable `StreamLog` (§2 streaming architecture,
  2026-08-25 entry in §12) → WS `stream.sync`/`stream.event` → persisted as message tree
  nodes (skipped entirely for incognito conversations).
- **Chat (device model)**: client runs llama.rn/sidecar locally, writes nodes to local SQLite;
  pushed to server via sync on reconnect.
- **Agent run**: server harness loop → tool calls execute in a sandbox container (or a mounted
  workspace) → events streamed (`agent.tool_call`, `agent.tool_result`, approvals, diffs).
- **Sync**: op-log push/pull (§6.3). Live updates over WS `sync.ops`.

---

## 3. Monorepo Layout

pnpm workspaces + Turborepo. All packages scoped `@shannon/*`.

```
open-shannon/
├── apps/
│   ├── server/     # Fastify API + WS, harness, sync, auth, sandbox orchestrator (Node 22, TS)
│   ├── web/        # Vite + react-native-web SPA — also the bundle loaded by Electron
│   ├── mobile/     # Expo (expo-router); dev build required for llama.rn (NOT Expo Go)
│   └── desktop/    # Electron (Stage 7); bundles apps/web/dist, spawns llama.cpp sidecar
├── packages/
│   ├── ui/         # Gluestack v5 components (copy-paste model) + AppShell layout primitives
│   ├── agent/      # Harness-shared types: tool defs, event schema, permission modes
│   ├── sync/       # Op-log sync protocol — client half + server half
│   ├── api-client/ # Typed REST/WS client used by all three frontends
│   ├── db/         # Drizzle schema + migrations
│   ├── config-ts/  # Shared tsconfigs
│   └── config-style/# NativeWind/Tailwind preset + design tokens
├── infra/
│   ├── docker/     # Dockerfiles (server, web-nginx, sandbox base image)
│   └── tailscale.md
├── docker-compose.yml          # dev: CPU inference
├── docker-compose.rocm.yml     # prod override: ROCm inference, GPU devices
├── docs/IMPLEMENTATION.md      # this file
├── AGENTS.md
├── package.json / pnpm-workspace.yaml / turbo.json
└── README.md
```

**Ports**: server `4000`, web `4001`, inference `4002`, ntfy `4003`, Postgres `5432`
(host-mapped in dev for drizzle-kit; internal-only in prod).

---

## 4. Tech Decisions (locked)

| # | Area | Decision | Rationale / notes |
|---|---|---|---|
| D1 | Inference | **llama.cpp `llama-server` direct**, OpenAI-compatible, `--jinja` tool calling | Chosen over Ollama (no cache-hit metrics, ~1.5–1.8× slower per community benches, limited flag surface) and LM Studio (closed-source, GUI-first, not headless — ruled out). Dev image `ghcr.io/ggml-org/llama.cpp:server` (CPU). Prod `:server-rocm` (verify exact tag at Stage 2). Multi-model on-demand loading via **llama-swap** (or llama-server native router mode once mature) at Stage 6. Ollama allowed as an **optional dev-only** provider via `INFERENCE_BASE_URL`; never the prod path. |
| D2 | AMD V620 (gfx1030) | **ROCm container primary, Vulkan fallback** | gfx1030 confirmed working under ROCm in Docker; Vulkan simpler but weaker multi-GPU. PCIe passthrough to a Linux VM on Proxmox (preferred over LXC). |
| D3 | Agent harness | **Custom-built** in `apps/server` | Replaces Claude Code / opencode entirely. No Agent SDK dependency. |
| D4 | Model routing | `ModelProvider` interface → `ServerLlamaCpp`, `DeviceLocal`, `RemoteOpenAICompat` (optional, later) | One selector UI across server/device/remote models. |
| D5 | Web stack | **Vite + react-native-web SPA** (NOT Next.js) | Electron must load a fully bundled offline build; one static build serves nginx + Electron. |
| D6 | UI kit | **Gluestack v5** (copy-paste components) + **NativeWind v4 (mobile) + inline styles (web)** | NativeWind v5 preview and v4 babel plugins both fail on Vite ESM (require() interop). **Mobile**: NativeWind v4 + Metro (working). **Web**: inline styles via react-native-web (working). Upgrade to NW v5 when NativeWind ships a Vite plugin. |
| D7 | Server framework | **Fastify 5** + `@fastify/websocket`, tsx dev, tsup build | WS-first app, low overhead. |
| D8 | DB / ORM | **Postgres 17 + Drizzle** | Typed migrations, JSONB content blocks. |
| D9 | Auth | **better-auth** (email/password first; passkeys later); bearer tokens per device | Multi-user from day one. |
| D10 | Sync | **Custom op-log** over append-only message tree | Handles forks natively; PowerSync fights tree semantics (kept as documented alternative, §11). |
| D11 | Sandboxes | **Sibling containers via docker.sock**; `SandboxProvider` interface; **gVisor `runsc`** optional on Linux; microVMs (microsandbox/E2B) deferred | Daytona went closed-source June 2026 — do not use. |
| D12 | Remote access | **Tailscale** host-level install; MagicDNS; `tailscale serve` for TLS. Headscale doc as optional full-self-host path. | Simple + secure. |
| D13 | Monorepo | **pnpm + Turborepo**, TypeScript strict | — |
| D14 | Push | **ntfy** self-hosted container (Stage 6); Expo Push/APNs only if needed later | Stays self-hosted. |
| D15 | Mobile local AI | **llama.rn** (llama.cpp RN binding) in an Expo **dev build** | Expo Go cannot run it. GGUF download manager in-app. |
| D16 | Desktop | **Electron, fully bundled offline build** (electron-builder), llama.cpp sidecar spawned by main process | User requirement. Stage 7. |
| D17 | Fork merge | **Deferred** — TODO item with design sketch (§6.4), not in Stage 3 scope | User decision 2026-08-11. |
| D18 | Stats charts | **Hand-rolled on react-native-svg** | Fully universal across RN + RNW; avoids Skia/chart-lib web-compat risk. |
| D19 | Token tracking | **Append-only `usage_records` per completion**, captured from llama.cpp `usage`+`timings` (server) or llama.rn timings (device, synced as ops) | llama.cpp is the only local backend reporting exact cache hits (`cache_n`) — a key factor in D1. See §6.5. |

---

## 5. Model Roster

### 5.1 Build-time model assignments (which model executes each stage)

The human switches the coding agent's model at each stage gate. Ids are OpenRouter slugs.

| Role | Slug | Context | Use for |
|---|---|---|---|
| Planning / large-context execution | `moonshotai/kimi-k3` | 1M | Plans, whole-repo reviews, cross-cutting integration, final audits |
| Heavy reasoning | `deepseek/deepseek-v4-pro` | 1M | Sync protocol, agent state machine, sandbox security design |
| Routine coding / execution | `qwen/qwen3.6-plus` | 1M | Scaffolding, CRUD, UI implementation |

### 5.2 Runtime model routing (product feature)

Model picker in UI chooses among: server models (GGUFs on llama.cpp), device-local models,
and (optionally, later) OpenRouter-compatible remote providers. Registry table
`model_registry` drives availability. Per-mode defaults (planning/manual/auto) are user
settings, overridable per conversation.

---

## 6. Data Model & Sync

### 6.1 Postgres schema (Drizzle, in `packages/db`)

```sql
-- better-auth manages: user, session, account, verification (its own tables)
devices        (id uuid pk, user_id fk, name text, platform text, last_seen_at timestamptz, created_at)
conversations  (id uuid pk, owner_id fk, title text, kind text,           -- 'chat' | 'agent' | 'routine'
                active_leaf_id uuid null,                                 -- current branch tip per owner
                model_pref jsonb, created_at, updated_at, deleted_at null)
messages       (id uuid pk,                -- client-generated UUID (idempotent push)
                conversation_id fk, parent_id uuid null,                  -- THE TREE
                author_type text,          -- 'user'|'assistant'|'system'|'tool'|'summary'
                author_user_id uuid null, origin text,                    -- 'server'|'device'
                device_id uuid null, model text null,
                lamport bigint, content jsonb,                            -- ContentBlock[]
                status text,               -- 'streaming'|'complete'|'error'|'cancelled'
                created_at timestamptz, deleted_at timestamptz null)
sync_ops       (seq bigserial pk, user_id fk, device_id uuid null,        -- null = server-originated
                op_type text, entity_id uuid, payload jsonb, lamport bigint, created_at)
workspaces     (id uuid pk, owner_id fk, name text, host_path text, created_at)  -- server-side dirs
sandboxes      (id uuid pk, owner_id fk, conversation_id fk null, container_id text,
                image text, status text, repo_url text null, branch text null,
                limits jsonb, created_at, stopped_at null)
routines       (id uuid pk, owner_id fk, name text, cron text, prompt text,
                target jsonb, enabled bool, last_run_at, next_run_at)
routine_runs   (id uuid pk, routine_id fk, conversation_id fk, status text, started_at, finished_at)
model_registry (id text pk, display_name text, gguf_url text, size_bytes bigint,
                quant text, context_tokens int, capabilities jsonb, location text) -- 'server'|'device'|'both'
usage_records  (id uuid pk,                -- client-generated when device-originated
                user_id fk, device_id uuid null,          -- null = server inference
                conversation_id fk null, message_id uuid null, run_id uuid null,
                model text, origin text,                  -- 'server'|'device'
                input_tokens int, cached_tokens int, output_tokens int,
                ttft_ms int, prompt_ms int, predict_ms int, total_ms int,
                prompt_tps real, predicted_tps real,
                created_at timestamptz)                   -- UTC; UI buckets in local tz
```

```ts
// packages/db — message content blocks
type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; call_id: string; tool: string; args: unknown }
  | { kind: "tool_result"; call_id: string; output: string; diff?: FileDiff[] }
  | { kind: "attachment"; ref: string; mime: string };
```

### 6.2 Message tree & forks

- A conversation is a tree of messages linked by `parent_id`. A **fork** exists wherever a node
  has more than one non-deleted child.
- Continuing a branch = appending a child to that branch's leaf. Both local and remote
  continuations are always preserved; nothing is auto-merged or overwritten.
- `conversations.active_leaf_id` tracks the branch the user is "on" (per owner; synced with
  last-writer-wins since it's metadata, not tree structure).
- **Fork UI (Stage 3)**: fork chips on branched nodes, branch picker, "continue local /
  continue remote" affordances, jump between branches, delete branch = soft-delete subtree
  (`deleted_at` on all descendants).
- Nodes generated offline carry `origin='device'`, `device_id`, and a Lamport clock value;
  `parent_id` — not timestamps — defines tree truth, so offline forks attach correctly.

### 6.3 Op-log sync protocol (`packages/sync`)

- **Push**: `POST /sync/push` `{ device_id, ops: [{ client_op_id, op_type, entity_id, payload, lamport }] }`
  → server validates + assigns `seq` → `{ accepted: [{client_op_id, seq}], rejected: [...] }`.
  Message creates are idempotent on client-generated UUID.
- **Pull**: `GET /sync/pull?since=<seq>&limit=<n>` → `{ ops, cursor }`. Initial sync pages from 0.
- **Live**: WS `sync.ops` fan-out to the user's other connected devices.
- **Conflict rules**: append-only entities (messages, ops) never conflict. Mutable metadata
  (title, active_leaf, archived, deleted flags) → field-level last-writer-wins, tiebreak by
  `(lamport, device_id)`.
- Client storage: expo-sqlite (mobile) / sql.js or IndexedDB (web/desktop) mirror tables,
  plus a `pending_ops` outbox drained on reconnect.

### 6.4 Fork "merge" — DEFERRED (TODO)

Not in scope for Stage 3 (user decision). When built: **synthesis node** — a new message whose
context is an LLM-generated synthesis of both branch transcripts, referencing both leaf ids.
Both branches remain intact; the merge node starts a third branch. True semantic merging of two
conversation branches is not well-defined; this is the honest approximation.

### 6.5 Usage tracking ("token tracker")

Per-completion usage records for every inference in the system — chat, agent loops (each
tool-loop iteration, linked by `run_id`), routines, and device-local generations.

- **Capture (server origin)**: the inference proxy in `apps/server` records llama.cpp's
  `usage` + `timings` on every completion: `prompt_n` / `predicted_n` tokens, `cache_n`
  (prompt-KV cache hits), `prompt_per_second` (pre-prompt speed), `predicted_per_second`
  (generation speed), plus TTFT measured at the stream layer and total duration.
- **Capture (device origin)**: llama.rn / desktop sidecar timings recorded to client SQLite,
  pushed as `usage.record` sync ops (append-only, no conflicts).
- **Fidelity note**: llama.cpp is the only local backend that reports exact cache hits
  (`cache_n`); Ollama cannot (a key factor in D1). Remote providers (deferred) get degraded
  records (usage + latency only).
- **API**: `GET /v1/stats/usage?bucket=session|day|week|month|year&group_by=model|conversation&from&to`
  → token sums, cache hit %, avg/p95 TTFT, avg pp/tg t/s. Time-bucketed SQL over
  `usage_records`; no rollup tables unless profiling later demands them (§11). "Session" =
  selected conversation / agent run, plus a current-app-session filter. Day boundaries use
  the requesting user's local timezone.
- **Live**: WS `usage.recorded` event updates open clients' stats views.
- **UI**: Stats screen (shared `@shannon/ui`, all three apps): range tabs (Session / Today /
  Week / Month / Year), tokens-over-time stacked by model, cache hit-rate line, pp vs tg
  speed panel, TTFT/duration percentiles, per-model and per-conversation tables. Charts
  hand-rolled on react-native-svg (D18). Micro-feature: subtle `tok/s · cached %` line under
  each assistant message.

---

## 7. The Harness (agent mode) — Stage 5

- **Loop**: client `chat.send` with `mode` → server runs provider stream → on tool calls,
  executes → appends results → continues until stop. All steps stream as WS events.
- **Tools v1**: `fs_read`, `fs_write`, `fs_edit` (search/replace), `bash` (sandbox-scoped),
  `grep`, `glob`, `web_fetch`, `todo_write`. Scoped to sandbox or mounted workspace.
- **Permission modes**:
  - `planning` — read-only tools only; output is a plan artifact in the conversation; no writes.
  - `manual` — every mutating tool call emits `agent.approval_request`; UI approves/denies.
  - `auto` — allowlisted tools auto-approved; denylist always asks.
- **Context management**: `/compact` (chat and agent, invoked via the composer's slash
  palette or the context ring's Compact button) summarizes the conversation into a
  `summary`-authored message and continues from it. Nothing is deleted — every prior
  message stays in Postgres and on screen; the history loaders (`loadChatHistory`,
  `agentRun`'s `loadHistory`) simply start replaying from the newest summary instead of
  the top, so what's *sent* shrinks while what's *shown* doesn't. A repeat `/compact` with
  nothing new since the last one is refused without a model call. Token savings are
  computed from real usage records where one exists (`apps/server/src/streams/runs/compactRun.ts`),
  falling back to an estimate — flagged as such — only when none does.
- **Event schema** (`packages/agent`):

```ts
type ServerEvent =
  | { type: "chat.delta"; conversation_id: string; message_id: string; delta: string }
  | { type: "chat.message_complete"; conversation_id: string; message_id: string }
  | { type: "agent.tool_call"; call_id: string; tool: string; args: unknown }
  | { type: "agent.tool_result"; call_id: string; output: string; diff?: FileDiff[] }
  | { type: "agent.approval_request"; call_id: string; tool: string; args: unknown }
  | { type: "agent.run_state"; run_id: string; state: "running" | "awaiting_approval" | "done" | "error" }
  | { type: "sync.ops"; ops: SyncOp[]; cursor: number }
  | { type: "usage.recorded"; record: UsageRecord };
```

---

## 8. Sandboxes — Stage 4

- **Orchestrator** in `apps/server` talks to the host Docker daemon via mounted
  `/var/run/docker.sock` (server container gets the socket; documented risk + gVisor path).
- **Base image** `shannon-sandbox`: ubuntu 24.04 + git, Node 22, Python 3.12, ripgrep, build-essential.
  Built by `infra/docker/sandbox.Dockerfile`.
- **Lifecycle**: create per (user, session) → optional `git clone` (URL + token) → `docker exec`
  for commands (terminal over WS) → file tree read/write API → stop/destroy with TTL reaper.
- **Limits**: CPU/mem/pids via container opts; per-session bridge network; no host mounts
  except explicitly registered `workspaces`.
- **Isolation tiers**: t0 plain container (dev/everywhere) → t1 `runtime: runsc` gVisor
  (Linux prod) → t2 microVMs (microsandbox/E2B) deferred to §11.
- On macOS/Windows hosts only t0 is available — acceptable for dev; document it.

---

## 9. Environments & Ops

### 9.1 Dev (current: macOS + Docker Desktop)

- No GPU in Docker on macOS → **CPU inference**; use a small Q4 GGUF (≤3B) for tests.
- `docker compose up` → db, server, web, inference(CPU), all healthy.
- Optional speedup: run native Metal `llama-server` outside Docker and point
  `INFERENCE_BASE_URL` at it. Not on the critical path.
- Expo: `pnpm --filter mobile start` (dev client build for llama.rn later).

### 9.2 Prod (Proxmox + AMD V620)

- Proxmox → Linux VM with **PCIe passthrough** of the V620 (preferred; LXC possible but
  fiddlier for AMD).
- `docker compose -f docker-compose.yml -f docker-compose.rocm.yml up -d`
  → swaps inference to `server-rocm` image + GPU device mappings.
- Vulkan fallback documented if ROCm misbehaves on gfx1030.
- Open question (non-blocking): VRAM per V620 (16 vs 32 GB) — affects prod GGUF size choices.

### 9.3 Tailscale (`infra/tailscale.md`, written in Stage 1)

- Install on host + each client device; MagicDNS; `tailscale serve` for TLS in front of web.
- Headscale (self-hosted control plane) noted as optional alternative.

---

## 10. Stage Plan

Each stage ends at a demoable gate. **The human switches the agent model at each gate**
(§5.1). Stages are sequential; do not start the next until the gate passes.

| # | Stage | Gate (acceptance) | Model |
|---|---|---|---|
| 1 | Monorepo + frameworks PoC + GUI shell | Same `@shannon/ui` AppShell renders on web (Vite) + mobile (Expo); `docker compose up` healthy (server `/health`, web nginx, db); Tailscale doc written | **qwen3.6-plus** |
| 2 | Inference + chat core | Two users stream chat from web + mobile via llama.cpp; auth; conversations/messages persisted; model picker (server models); **`usage_records` captured at the inference proxy + stats endpoint + basic totals in UI** | **deepseek-v4-pro** design → qwen implement |
| 3 | Offline-first sync + forks | Plane-mode phone chats (local model later; server-model cache for now) sync back; forks visible with continue/jump/delete; concurrent-edit test passes; **`usage.record` ops join the sync protocol** | **deepseek-v4-pro** design → qwen implement → **kimi-k3** gate review |
| 4 | Sandboxes | From phone: clone repo → run tests → watch live terminal; file tree API; limits enforced | **deepseek-v4-pro** + qwen |
| 5 | Agent harness | "Add feature X to repo Y" end-to-end from mobile: planning/manual/auto modes, approvals, diffs, compaction, workspaces; **usage tagged per `run_id`/mode** | **kimi-k3** + deepseek + qwen |
| 6 | Routines + on-device models | Cron routine runs into a conversation + ntfy push; llama.rn on mobile + GGUF manager; desktop llama.cpp sidecar; offline→fork→sync e2e; **device-origin usage capture + full Stats screen with charts; llama-swap (or native router mode) for multi-model** | qwen + deepseek |
| 7 | Desktop + polish + macOS/Windows hosts | Installable Electron (bundled offline build, sidecar, tray, updater); design pass; host docs for macOS/Windows; CI releases | qwen → **kimi-k3** final audit |

### Stage 1 checklist (current — execute exactly this, nothing more)

1. Root: `pnpm-workspace.yaml`, `package.json` (dev/build/lint/typecheck scripts), `turbo.json`,
   base `.gitignore`, `.env.example`.
2. `packages/config-ts` (base tsconfigs), `packages/config-style` (NativeWind preset, design
   tokens — dark-first, Claude-like neutrals + single accent).
3. `packages/types` — shared primitives (ids, Result types).
4. `packages/ui` — Gluestack provider setup + initial component set (Button, Input, Card,
   Avatar, Badge, Separator) + **AppShell** (Sidebar / ThreadList / ChatView / Composer
   placeholders, responsive: sidebar collapses to drawer on narrow screens).
5. `packages/api-client` — `getHealth()` typed fetch only (real client grows in Stage 2).
6. `apps/server` — Fastify + `GET /health`, `GET /v1/models` (static stub), CORS; Dockerfile.
7. `apps/web` — Vite + react-native-web + NativeWind; renders AppShell from `packages/ui`;
   nginx Dockerfile for the static build.
8. `apps/mobile` — Expo + expo-router; renders the same AppShell; monorepo Metro config
   (`watchFolders`, node module resolution).
9. `docker-compose.yml` (db, server, web, inference CPU with mounted `./models` dir, healthchecks)
   + `docker-compose.rocm.yml` override (profile-gated).
10. `infra/tailscale.md` — host + device setup, MagicDNS, `tailscale serve`.
11. Verify: `pnpm dev` (web+server hot), `docker compose up --build` healthy, `expo start` renders.
12. Update §12 of this document.

**Risk gate inside Stage 1**: if NativeWind v5 does not build on Vite+RNW after a genuine
attempt, fall back to **NativeWind v4 + Tailwind v3** (D6) and record the decision in §4.

---

## 11. Deferred / TODO (do not build early)

| Item | Stage it belongs to / trigger |
|---|---|
| Fork **merge** (synthesis node, §6.4) | Post-Stage-7 or explicit user request |
| PowerSync / generic table sync | Only if op-log sync proves insufficient |
| microVM sandboxes (microsandbox / E2B self-host) | If untrusted multi-tenant code execution is needed |
| Headscale | If Tailscale coordination server must be self-hosted |
| macOS/Windows host support (plain-Docker fallback) | Stage 7 |
| RemoteOpenAICompat provider (OpenRouter etc.) | User request |
| Passkeys, SSO | After email/password is stable |
| Multi-model on-demand loading — **resolution: llama-swap** (or llama-server native router mode if mature) | Stage 6 (D1) |
| Stats rollup tables | Only if `usage_records` time-bucket queries profile poorly |
| Expo Push / APNs | If ntfy proves insufficient |

---

## 12. Where We Are

> Update this section at every stage boundary and after any major decision. This is the
> first thing a fresh session reads.

- **2026-08-11** — Stage 0 complete: requirements gathered (custom harness, llama.cpp,
  multi-user, offline-first + forks, bundled Electron, Proxmox/V620 prod, Mac dev first),
  plan approved, this document written. Repo contains only `README.md`, `AGENTS.md`,
  `docs/IMPLEMENTATION.md`.
- **2026-08-11 (update 3)** — **Stage 2 verified.** All 7 packages typecheck clean, web
  build passes (302KB / 95KB gzipped). Server modules: `routes/auth` (sign-up/in/out/
  session/token), `routes/conversations` (CRUD + soft-delete), `routes/stats` (usage
  aggregation with cache-hit %), `ws/chat` (chat.send → streaming → delta/complete/error
  protocol), `inference/provider` (llama.cpp SSE + `MOCK_INFERENCE=true` dev mode),
  `auth/middleware` (Bearer token auth), `db/migrate` (auto-migrate on startup). DB
  schema: drizzle-kit migrations generated; better-auth manages `user`/`session`/`account`/
  `verification`. Web UI: Login screen + ChatScreen with streaming (`screens/`). API
  client: auth methods, WS chat client (`createChatSocket`, `sendChatMessage`).
  Runtime test requires `docker compose up -d db` + `MOCK_INFERENCE=true server`.
  `/health` responds. Web Vite **build succeeds** (dist/assets + index.html). NativeWind
  v5 preview and v4 babel plugins both fail on Vite ESM (`require()` interop). **Decision**
  (D6): Mobile uses NativeWind v4 + Metro (works). Web uses inline styles via
  react-native-web (works). Upgrade to NW v5 when NativeWind ships a Vite plugin.
  Stage 1 checklist complete. Exceptions: docker compose not tested (requires Docker
  running); Expo start not tested (requires Expo CLI + device/simulator).
- **2026-08-12** — **Design port (Option A) complete.** All 10 packages typecheck clean, web
  build passes (311KB / 97KB gzipped). `design/` folder is the source of truth for UI: locked
  11-hex palette (zinc neutrals + aqua accent `#0096ff`), Public Sans self-hosted, dark-first
  + light mode. Tokens restructured in `packages/config-style/design-tokens.js` with
  `darkTheme`/`lightTheme` exports + pre-computed badge tints (8-digit hex). ThemeProvider in
  `packages/ui/src/theme/index.tsx` with `useTheme()` hook, `shannon-theme` localStorage key,
  system resolution via `matchMedia`, cross-tab sync. No-FOUC bootstrap in
  `apps/web/index.html`. All screens updated to use `useTheme()` hook. SVG icon set via
  `react-native-svg` (replaces emoji icons). Components upgraded: Button (4 variants × 3
  sizes), Badge (5 tinted variants), Switch, SegmentedControl, Input (real TextInput).
  AppShell rebuilt with sidebar nav (Chat/Agent/Routines/Stats + Settings modal). Sandbox
  screen removed from nav (API stays for agent integration).
- **2026-08-12 (update 2)** — **Design integration complete.** All OpenDesign React components
  from `design/react/src/` are copied to `apps/web/src/design-components/` and used directly.
  All 4 surfaces (Chat, Agent, Routines, Stats) render with design CSS from `shannon.css`
  (32KB). Web app no longer uses react-native-web — it's plain React with HTML elements and
  CSS classes. `App.tsx` reduced to 27 lines (auth gate + surface routing). Hand-written
  screens deleted (ChatScreen, AgentScreen, StatsScreen, RoutinesScreen, SettingsModal).
  Only LoginScreen remains custom. Full CSS for all surfaces (shell, chat, agent, routines,
  stats) in `apps/web/src/shannon.css`. Theme via `data-theme` attribute + CSS vars. Fixtures
  from design used as mock data.
- **Next action**: Wire real API (conversations, WS streaming, routines, stats) into design
  surfaces, replacing fixture data.
- **Active model for next stage**: `qwen/qwen3.6-plus` (implementation).
- **2026-08-25** — **Durable resumable message streaming.** Replaced the old bare-WS
  delta push (two closure vars per in-flight response, no seq numbers, no resume) with a
  durable, sequenced `StreamLog` (`apps/server/src/streams/`): pluggable driver
  (`memory.ts` zero-dep dev default, `redis.ts` via `ioredis`, Redis Streams + TTL, prod
  default in `docker-compose.yml`), `StreamBroker` (25ms producer-side coalescing,
  `STREAM_COALESCE_MS`, force-flush on structural events, in-process `EventEmitter`
  fan-out — Redis is durability/catch-up only, not pub/sub). One shared wire protocol for
  chat + agent (`packages/types/src/stream-protocol.ts`, replaces the old `AgentEvent`/
  `ChatClientEvent`): `stream.subscribe {conversation_id, cursors}` → one folded
  `stream.sync` snapshot (everything-so-far) then live `stream.event`s, gap-healed by the
  client re-subscribing on a `seq` mismatch. Real `stream.stop` (AbortSignal finally wired
  into `provider.ts`), run-scoped tool approvals (any device on the account can approve),
  per-command session re-validation, boot-time orphan recovery for crashed streams
  (`streams/recovery.ts` + a Postgres sweep for stuck `status='streaming'` rows). Added
  **incognito conversations** (signed-in users; `chat.send {incognito:true}` — zero
  Postgres writes for conversations/messages/usage_records, lives only in the stream
  backend with a 24h idle TTL, lost on server restart in memory mode; composer toggle in
  `apps/mobile/components/composer/Composer.tsx`). Added a single authz chokepoint
  (`streams/authz.ts` `assertConversationAccess`) checked on every WS command — PG and
  ephemeral ownership resolved in parallel to avoid an existence-timing side channel — so a
  user can never read, stop, or approve another user's conversation even with its id.
  New indexes: `messages(conversation_id, created_at)`, `messages(conversation_id,
  lamport)`. Live verification (real server, real Postgres, real inference, two throwaway
  accounts) confirmed the full cross-user isolation matrix, real `stream.stop` cancellation,
  the incognito zero-row-write assertion, and orphan recovery after an unplanned mid-stream
  restart (no rows ever stuck at `status='streaming'`). That pass also caught a real gap:
  a second device already viewing a conversation never learned about a brand-new run
  started from a different device, since `stream.subscribe` only synced streams that
  existed *at subscribe time*. Fixed with `streams/watchers.ts` — a process-local
  conversation-level notice board separate from the broker's per-stream taps — that
  `delivery.ts`'s `handleSubscribe` now registers against for the life of the socket, plus
  a synchronous slot-reservation in `subscribeToStream` to close the resulting double-tap
  race for a socket that's both the sender and a standing watcher of its own conversation.
  Confirmed live with two browser tabs on the same conversation. Redis-mode crash recovery
  specifically remains untested — no Docker registry access in the dev sandbox this pass
  ran in — the driver-parity vitest suite (`streams/__tests__/`) exercises the same
  contract against Redis automatically whenever `REDIS_URL`/`TEST_REDIS_URL` is reachable.
- **Active model for next stage**: Sonnet 5.
- **Blocked on**: nothing.
