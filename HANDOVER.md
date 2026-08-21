# Handover — Shannon Design Integration

## What happened

The web UI was rebuilt to use OpenDesign React components from `design/react/src/` instead of hand-written react-native-web components. The design folder is the **source of truth** for all UI — every component, every string, every CSS class.

### Old architecture (removed)
- `apps/web/src/screens/Chat.tsx`, `Agent.tsx`, `Stats.tsx`, `Routines.tsx`, `SettingsModal.tsx` — **deleted**
- `packages/ui/src/layout/*` — still exists (used only by Mobile/Expo, not web)
- Hand-written RNW components with inline styles — replaced by design components

### New architecture
- `apps/web/src/design-components/` — 35+ files copied from `design/react/src/`
- `apps/web/src/shannon.css` — 32KB CSS (full shell + all surface styles)
- `apps/web/src/App.tsx` — 27-line auth gate + surface router
- `apps/web/src/screens/Login.tsx` — only hand-written screen remaining
- Plain React with HTML elements + CSS classes (`className="sidebar"` etc.)
- Theme via `data-theme` attribute on `<html>` + CSS variables in `shannon.css`
- No-FOUC bootstrap in `apps/web/index.html` (reads `shannon-theme` localStorage)

## What's working

| Surface | State | Notes |
|---|---|---|
| **Login** | ✅ | Hand-written, works with API auth |
| **Chat** | ✅ Live API | WS streaming + conversation loading wired |
| **Agent** | Fixtures only | Needs WS `createAgentSocket` integration |
| **Routines** | Fixtures only | Needs `/v1/routines` API wiring |
| **Stats** | Fixtures only | Needs `/v1/stats/usage` API wiring |
| **Settings modal** | ✅ | UI working, localStorage backed |
| **Model modal** | ✅ | UI working, fixture model data |
| **Theme switching** | ✅ | Light/Dark/System via `shannon.css` CSS vars |

### Chat API wiring (reference for other surfaces)

In `design-components/surfaces/ChatSurface.tsx`:
- Accepts `token` prop from App.tsx
- `useEffect` on mount: calls `getConversations()` from `@shannon/api-client`, maps to design `Conversation` type, loads messages for latest via `/v1/conversations/:id/messages`
- `useEffect` for WS: `createChatSocket(token, callback)`, handles `chat.delta`, `chat.message_complete`, `chat.conversation`, `chat.error`
- `handleSend`: appends user message locally, sends via `sendChatMessage(ws, text, model, convId)`
- Merge logic: API conversations are merged with fixture conversations (fixtures serve as demo data for new users)

### File map

```
apps/web/src/
├── App.tsx                          (auth gate + surface routing, 27 lines)
├── main.tsx                         (imports shannon.css + global.css + ReactDOM render)
├── shannon.css                      (32KB — all shell/surface CSS)
├── global.css                       (@font-face only)
├── screens/Login.tsx                (hand-written)
├── design-components/
│   ├── layout/                      (AppShell, Sidebar, ThreadList, MainHeader)
│   ├── surfaces/                    (ChatSurface, AgentSurface, RoutinesSurface, StatsSurface)
│   ├── chat/                        (MessageList, Message, CodeBlock, ThinkingBlock, ToolCallCard, ContextMenu, PromptSuggestions)
│   ├── composer/                    (Composer — full toolbar with model selector, thinking, context indicator, attachments, workspaces, agent mode/smart routing)
│   ├── agent/                       (AgentStream, Inspector, PermissionBar, PlanningBanner)
│   ├── routines/                    (RoutineTable, RoutineModal)
│   ├── stats/                       (KpiCard, Sparkline, AreaChart, LineChart, BarChart, PercentileBars)
│   ├── settings/                    (SettingsModal — 6 tabs, ModelModal — search/groups/thinking)
│   ├── primitives/                  (Badge, Button, Card, Input, Modal, Segmented, Switch, Table)
│   ├── hooks/                       (useTheme, useSettings, useThemeInSettings, useToast, useLocalStorage)
│   ├── fixtures/                    (conversations, agent-runs, routines, stats, models)
│   └── types.ts                     (SurfaceId, Conversation, Message, AgentRun, Routine, etc.)
```

## What needs to be done

### 1. Wire Agent surface to live API

**File:** `design-components/surfaces/AgentSurface.tsx`

The AgentSurface currently uses `AGENT_RUNS` fixtures from `fixtures/agent-runs.ts`. Replace with:
- Accept `token` prop (like ChatSurface)
- Create a WebSocket via `createAgentSocket(token, callback)` from `@shannon/api-client`
- Agent WS event types: `agent.delta`, `agent.done`, `agent.error`, `agent.conversation`, `agent.mode_changed`, `agent.approval_request`
- `handleSend`: create locally + call `sendAgentMessage(ws, text, mode, convId)` from `@shannon/api-client`
- `handleModeChange`: call `setAgentMode(ws, mode)`
- The `Composer` component needs `showModeDropdown`, `mode`, `onModeChange`, `smartRouting`, `onSmartRoutingChange` props — they're already supported
- The `AgentStream` renders `run.messages` with tool-call cards, thinking blocks, permission bar — works as-is, just needs live data fed in

### 2. Wire Routines surface to live API

**File:** `design-components/surfaces/RoutinesSurface.tsx`

Currently uses `ROUTINES` and `ROUTINE_RUNS` fixtures from `fixtures/routines.ts`. Replace with:
- `useEffect` to `fetch('/v1/routines', { headers: { Authorization: Bearer ${token} } })`
- POST to `/v1/routines` for create, PATCH for toggle, DELETE for remove
- Run history: GET `/v1/routines/:id/runs`
- The `RoutineTable` component renders rows with toggles, the `RoutineModal` handles create/edit

### 3. Wire Stats surface to live API

**File:** `design-components/surfaces/StatsSurface.tsx`

Currently uses `KPIS`, `TOKENS_OVER_TIME` fixtures from `fixtures/stats.ts`. Replace with:
- `useEffect` to `fetch('/v1/stats/usage', { headers })`
- Response maps to `KpiCard` props: `{ label, value, delta, deltaDir, spark }`
- Charts need data formatted as `{ label, values: Record<string, number> }[]` for `AreaChart`
- The existing `/v1/stats/usage` endpoint returns: `{ inputTokens, cachedTokens, outputTokens, totalTokens, cacheHitRate, requestCount, avgTtftMs, avgPromptTps, avgPredictedTps, avgTotalMs }`
- Build KPI cards from those fields (requestCount = Requests, totalTokens = Total Tokens, etc.)

### 4. All surfaces need `token` passed from App.tsx

Update `App.tsx` to pass `token` to Agent, Routines, and Stats surfaces (Chat already done):

```tsx
if (screen === "chat") return <ChatSurface onNavigate={handleNavigate} token={token} />;
if (screen === "agent") return <AgentSurface onNavigate={handleNavigate} token={token} />;
if (screen === "routines") return <RoutinesSurface onNavigate={handleNavigate} token={token} />;
if (screen === "stats") return <StatsSurface onNavigate={handleNavigate} token={token} />;
```

Each surface's interface needs `token: string` added to its props.

### 5. Login screen needs design pass

**File:** `apps/web/src/screens/Login.tsx`

The login screen doesn't use `shannon.css` — it uses its own inline styles. The design prototype has a login via sign-in/sign-up. This is low priority since the auth flow works.

## Key gotchas

- **Never edit `design-components/` files as the source of truth** — changes to these files should flow from `design/react/src/` to keep the design in sync. If you need to modify a component for API integration, add new props rather than changing render output. Major UI changes should go to the design folder first.
- **CSS import chain**: `main.tsx` imports `global.css` (fonts) + `shannon.css` (all component styles). The CSS uses `var(--bg)`, `var(--surface)`, etc. from the `:root`/`html[data-theme="light"]` blocks. No inline styles needed.
- **Theme**: controlled by `shannon-theme` key in localStorage. Values: `light`, `dark`, `system`. The blocking script in `index.html` sets `data-theme` on `<html>` before React mounts (no FOUC). The `useTheme()` hook in `hooks/useTheme.ts` reads this. There's a SECOND theme system in `packages/ui/src/theme/` — that's for Mobile/Expo only, don't touch it for web.
- **Type mapping**: The API types (from `@shannon/api-client`) differ from the design types (`design-components/types.ts`). ChatSurface shows how to map: API `Conversation` → design `Conversation`, API `Message` → design `Message`. Message content is `content` in API, `text` in design.
- **WebSocket**: `createChatSocket` and `createAgentSocket` from `@shannon/api-client` create WWebSocket connections. The agent WS events are typed as `AgentEvent` in the API client.
- **Build/typecheck**: `pnpm typecheck` + `pnpm --filter @shannon/web build`. Both must pass. Currently 375KB JS + 32KB CSS gzipped ~116KB + ~6KB.
- **design/ folder**: Has two copies — `design/react/src/` (React components) and `design/shannon-*.html` (static HTML prototypes). The React components sometimes differ slightly from the HTML. The React components are the source for the web app.
- **No react-native-web needed for web anymore**: The web app uses plain `<div>`, `<span>`, `<button>`, `<svg>` — standard HTML. Only Mobile/Expo uses RNW.

## Commands

```bash
pnpm dev                    # turbo: server (4000) + web (5173)
pnpm --filter @shannon/web build  # production build
pnpm typecheck               # full turbo typecheck (10 packages)
npx http-server -p 8765 design/  # serve design prototype for comparison
```

## Current build output

```
dist/index.html                   0.99 kB
dist/assets/index-*.css          31.99 kB (gzip: 5.70 kB)
dist/assets/index-*.js          375.11 kB (gzip: 115.93 kB)
```