# Open-Shannon — Design Plan

## Intent

Build a high-fidelity, self-contained HTML prototype of the **Open-Shannon** client —
a self-hosted, multi-user **AI assistant with agent harness** (per
`docs/IMPLEMENTATION.md` §1) — with five surfaces: **Chat**, **Agent console**,
**Routines**, **Settings**, and **Stats**. The Stats surface's layout is a faithful
clone of a React analytics dashboard
(`https://example.com/dashboard/analytics`); the other four follow the
Shannon desktop/mobile layout grammar already seeded in the repo's `AppShell`.
The theme layer is the repo's own engine: **`packages/config-style` tokens +
the `.agents/skills/gluestack-ui-v5` skill rules**, with the accent swapped to
**Aqua accent** (user decision), so the prototype ports into `packages/ui` without
re-tokenizing.

This document is the source of truth for the Design-mode build. Edit freely; the
build agent follows the final version of this file.

---

## Review Round 1 — Preview comments (2026-08-12) — **ACTIVE**

Source: 15 open preview comments (OD annotation store, all `status=open`) + 3 manual
element deletions in `shannon-agent.html` made in the visual editor (run-header stat
spans `run-elapsed` / `run-tokens` / `run-cache` — already gone in the OD copy;
propagate to the repo copy on sync, and do not re-add them).

Four cross-cutting components emerge from the comments; build each once, apply to
every surface.

### R1. Cross-cutting components

- **U1 — Unified composer (chat + agent).** One composer spec for both surfaces:
  attach button, workspace chips, **model selector** (moved out of the chat header),
  **context indicator**, send button that **swaps to stop** while a run/stream is
  active. Agent composer adds: **mode dropdown** (Planning / Manual / Auto, moved out
  of the run header — **agent composer only**, Q4) and a **smart-routing toggle +
  gear**. Both composers get a **thinking-level selector** (None / Low / Medium /
  High) stored **per conversation**; new conversations take the default from Settings
  (Q5). Context indicator = compact
  ring/bar showing % of the model's context window filled; click → popup with context
  stats (tokens in/out/cached, files in context, cache %, tok/s) — a compact sibling
  of the chat context panel.
- **U2 — Settings as modal.** `nav-settings` opens a modal (not a page nav) on every
  surface (chat, agent, routines, stats). Same layout as the current page: tab rail left (General / Models /
  Workspaces / Devices / Server / Usage), content right. Deep-linkable: callers can
  open it pre-selected on a tab (the model modal's gear lands on **Models**).
  Settings is **never a page** (Q3): `shannon-settings.html` is removed; the modal
  ships on every surface, and the launcher's Settings entry points at the chat home
  (`shannon-chat.html`) with the modal auto-opened.
- **U3 — Model modal v2.** Adds: search bar filtering the list; new **Remote Models**
  group (OpenRouter and other **Cloud** third-party providers, placeholder rows);
  a **thinking level** selector (None / Low / Medium / High — llama.cpp reasoning
  levels) that sets the level for the **current conversation** (Q5); footer
  **settings gear** → opens U2 on the Models tab.
- **U4 — Smart routing.** Settings › Models: replace **Per-Mode Defaults** with
  **Smart routing** — profile select (**Cloud** = third-party hosted providers such
  as OpenRouter · **Server** = your self-hosted llama.cpp · **Hybrid** = either,
  chosen automatically per task) + per-task model mapping (planning model,
  heavy-thinking model, routine/simple-jobs model) (Q2). Composer toggle
  (U1) enables it per conversation; its gear opens U2 at this section. Persist to
  localStorage.

### R2. Per-comment task list

| # | File | Anchor element | Comment (abridged verbatim) | Implementation |
|---|---|---|---|---|
| A1 | agent | `[data-od-id="mode-selector"]` | "This belongs with the chat box as a dropdown / tool popup, since it's a 'per chat' feature." | Remove segmented control from run header; add mode dropdown to composer tool row (U1) |
| A2 | agent | steer `textarea` | "The chat box should be the same as on the 'chat screen', and it's missing the option to select the LLM, along with the context indicator. The context indicator should popup the context stats and also indicate how close to the context window the user is." | Replace steer box with U1 composer: model selector + context indicator w/ stats popup |
| A3 | agent | inspector todo section | "The panels should be in a side panel and opened the same way as the chat.html." | Inspector (todos / changed files / context) becomes a right slide-over panel, toggled like chat's context panel; not always-visible |
| A4 | agent | header stop button | "No need for this. Stopping is part of the chat box when a chat is active." | Remove header stop button; composer send ↔ stop swap (U1) |
| A5 | agent | steer `textarea` tool group | "Under this in the 'tool' group, add a toggle to use 'smart routing' with a settings button to select 'Cloud', 'Hybrid', and 'Local'. With the intention that this can auto change the model based on the task." | Smart-routing toggle + gear in composer tool row (U1/U4); profiles named Cloud / Server / Hybrid per Q2 |
| C1 | chat | header model button ("Llama 3.1 8B") | "The belongs to the comment / reply section next to the 'workspace' selector." | Move model selector from header into composer tool row, beside workspace chips (U1) |
| C2 | chat | model modal, Server Models group | "The modal also needs to have levels of 'thinking'. It would depend on what llama.cpp uses. E.g, None, Low, Medium, High" | Per-model thinking-level selector (U3) |
| C3 | chat | model modal | "Add an option for remote models. I want to eventually add 'open router' etc. to the options. Also, add a search bar and a 'settings' button… opens the settings modal just jumped straight to the 'models' tab." | Search bar + Remote Models group + gear → U2 @ Models (U3) |
| C4 | chat | sidebar account label ("Self-hosted") | "Change this to 'shannon.tailscale.com'" | Text change; apply on all pages (shared sidebar) |
| C5 | chat | message badge "chat" | "Chat messages should change this and 'agent' to 'Cloud' and 'Offline'" | Origin badges become location badges: **Server** (on the server, synced) / **On device** (local to this device only) — naming per Q1 |
| C6 | chat | sidebar "New chat" button | "Move this into the chat history panel." | Button moves into thread-list panel header (next to search); same on agent page's run-history panel for consistency |
| C7 | chat | composer kbd hint ("↵ Send · ⇧↵ Newline") | "Remove this. Enter will not send a message, that's very annoying. Only the button will send the message." | Remove hint + Enter-to-send handler; Enter = newline; send button only |
| R1 | routines | routine modal prompt `textarea` | "Under this, add a 'directory' selector so it can run in a directory or pull data from it." | Add directory/workspace selector under Prompt; persists with the routine (localStorage) |
| S1 | settings | `nav-settings` | "This needs to open a 'Settings' popup/modal rather than taking to a new page. Keep the same layout with tabs in the left panel and content on the right." | U2 modal on every surface; page removed per Q3 |
| S2 | settings | "Per-Mode Defaults" heading | "Change this to 'smart routing'. It has options for 'Cloud', 'Hybrid', and 'Local', where the user can select what models should be routed to based on the task. E.g… planning… heavy thinking… routine simple jobs." | U4 settings section |

### R3. Manual deletions to propagate (already in OD copy)

- `shannon-agent.html` run header: spans `run-elapsed`, `run-tokens`, `run-cache`
  deleted by the user in the visual editor. Carry into the repo copy; run stats now
  surface in the context-indicator popup (U1) and inspector panel (A3), not the header.

### R4. Acceptance checks

1. Every comment A1–C7 / R1 / S1–S2 implemented at its anchor; no anchor left stale.
2. Chat and agent composers expose the same controls (attach, workspace, model,
   context indicator, send↔stop); agent adds mode dropdown + smart-routing toggle.
3. Enter never sends; no kbd hint remains; send button is the only submit path.
4. Model modal: search filters; thinking level per model; Remote Models group; gear
   opens settings modal pre-selected on Models.
5. Settings modal opens from nav on every surface; same tabs-left/content-right
   layout; opens on requested tab.
6. Smart routing: settings section (profile + 3 task mappings) and composer toggle
   both persist via localStorage and reflect each other.
7. No `chat` / `agent` text badges remain; **Server** / **On device** location badges
   used per Q1.
8. Sidebar: New chat inside thread panel; account label `shannon.tailscale.com`
   everywhere.
9. Agent: no header stop button, no header mode selector, no run-header stat spans;
   inspector slide-over behaves like chat's context panel (incl. mobile overlay).
10. Token discipline unchanged: 10-hex palette, radii {6,10,16,9999}, Public Sans,
    oklch/color-mix derivations only.
11. Both copies (OD project + repo `design/`) synced; repo keeps relative asset links
    (never the preview API URL).
12. `shannon-settings.html` is deleted; every nav Settings item opens the modal;
    launcher's Settings entry links to `shannon-chat.html` and auto-opens the modal.
13. Thinking level: selector in model modal + composer sets it per conversation
    (persisted per conversation); Settings › Models holds the default for new
    conversations.

### R5. Decisions (answered 2026-08-12)

- **Q1 (C5):** Location badges confirmed — named **Server** (on the server, synced)
  and **On device** (local to this device only). Replaces `chat` / `agent` origin
  badges; conversation kind moves to an icon.
- **Q2 (S2/A5):** Smart-routing profiles: **Cloud** = third-party hosted providers
  (OpenRouter etc.), **Server** = self-hosted llama.cpp, **Hybrid** = either, chosen
  automatically per task via the three mappings (planning / heavy thinking / simple
  jobs).
- **Q3 (S1):** Settings is **never a page** — modal only. `shannon-settings.html`
  is removed; anything that would deep-link to settings opens the app at the home
  chat screen with the modal opened.
- **Q4 (A1):** Mode dropdown lives in the **agent composer only**.
- **Q5 (C2):** Thinking level is stored **per conversation**; the **default** for new
  conversations is set in the settings modal.

No open questions remain in this round.

---

## Light Mode — Plan (2026-08-12) — **ACTIVE**

Theme switching (Light / Dark / System) across all five surfaces + launcher. Dark stays
the reference theme; light is **derived, not redesigned**. Control point: settings modal
› General › Appearance (currently a static "Dark" badge).

### L1. Current state (audited 2026-08-12)

- `shannon.css :root` holds dark-first tokens (`--bg #18181b` … `--warning`); no
  `data-theme` mechanism exists anywhere.
- 35 `color-mix(in oklch, var(--token) …)` derivations across files — these follow a
  token flip automatically. ✅
- Settings modal › General › Appearance is a static badge — becomes the segmented control.
- Stats charts pass `var(--token)` strings into SVG attributes via `svgEl()` — unreliable
  across theme flips; switch to computed-color resolution + re-render on `themechange`.
- `rgba(0,0,0,.3/.5)` modal backdrops are theme-agnostic — keep.
- `.range-tab.active` + accent buttons use a `#fff` text literal → normalize to `--on-accent`.

### L2. Token architecture (shannon.css)

- `:root, [data-theme="dark"] { …current values, unchanged… }`
- `[data-theme="light"] { …derived light scale… }`
- **"System" is resolved by JS, not CSS media-query blocks** (avoids duplicating the
  whole light scale): new `assets/theme-init.js` (~20 lines, loaded synchronously in
  `<head>` before the stylesheet) reads `localStorage["shannon-theme"]`
  (`light | dark | system`, default **`system`** — locked 2026-08-12), resolves via `matchMedia('(prefers-color-scheme: light)')`,
  stamps `<html data-theme>`. No FOUC, no duplicated CSS. A `matchMedia` change listener
  re-resolves while set to `system`; a `storage` listener syncs across open pages; a
  custom `themechange` event notifies charts.
- New semantic tokens: `--on-accent` (`#ffffff`, locked literal), `--accent-text`
  (dark: `var(--accent-2)`; light: `oklch(from #0096ff calc(l - 0.12) c h)` — raw
  `#0096ff` on white is 3.3:1, fails for links), `--code-bg`, `--shadow-1`, `--shadow-2`
  (black-alpha rgba values; not hex literals).
- **No new hex literals.** Light scale = locked literals reused (`#ffffff`, `#18181b`)
  + `oklch(from <locked-hex> …)` derivations only.

### L3. Light scale mapping (dark → light)

| Token | Dark (locked) | Light derivation | ≈ result |
|---|---|---|---|
| `--bg` | `#18181b` | `oklch(from #f4f4f5 calc(l - 0.015) c h)` | `#f6f6f7` canvas |
| `--surface` | `#27272a` | `#ffffff` (locked literal) | white cards |
| `--muted` | `#3f3f46` | `oklch(from #a1a1aa calc(l + 0.22) calc(c * 0.5) h)` | `#e4e4e7` tracks |
| `--fg` | `#f4f4f5` | `#18181b` (locked literal) | zinc-900 text |
| `--fg-2` | `#a1a1aa` | `#71717a` (locked literal) | 4.7:1 on white ✅ |
| `--fg-3` | `#71717a` | `oklch(from #71717a calc(l - 0.10) c h)` | ≈`#52525b`, 5.9:1 ✅ |
| `--border` | `#3f3f46` | `oklch(from #a1a1aa calc(l + 0.17) calc(c * 0.6) h)` | `#e4e4e7` |
| `--accent` / `--accent-2` | `#0096ff` / `#1da1f2` | unchanged | buttons, charts |
| `--danger` / `--success` | `#dc2626` / `#16a34a` | unchanged | status |
| `--warning` | `oklch(0.75 0.16 65)` | `oklch(0.62 0.15 65)` (darker for white bg) | |
| `--on-accent` | — | `#ffffff` (locked literal) | text on accent fill |

Accent-fill buttons keep white text in both themes — same pairing as the locked aqua
pattern; documented, not a regression.

### L4. Component audit (verify each in both themes)

Code blocks + diffs (`--code-bg`), thinking blocks, tool cards, striped tables, badges,
context menus / popovers / modals / slide-over (surface + `--shadow-2`), scrollbars,
`::selection`, focus ring (accent, unchanged), sparklines + KPI deltas (color-mix on
success/danger follows), range tabs, sidebar active item, composer, permission bar,
routine toggles, charts (see L5).

### L5. Chart color strategy (shannon-stats.html)

- Add `chartColors()` helper: `getComputedStyle(document.documentElement)` resolves
  `--accent`, `--accent-2`, `--border`, `--fg-3`, `--success`, `--danger` → concrete
  values passed into `svgEl()` attributes (also removes the latent `var()`-in-attribute
  risk).
- Re-run chart builders on `themechange` and `storage` events; legend dots already use
  CSS vars and follow automatically.

### L6. Settings control + events (shannon-shared.js)

- General › Appearance: segmented control **Light / Dark / System** replaces the badge;
  persists `shannon-theme`, applies immediately, dispatches `themechange`.
- `storage` listener updates all open pages when one changes theme.
- Launcher `index.html` has no settings modal — init script only; renders in stored theme.

### L7. Files touched

| File | Change |
|---|---|
| `shannon.css` | `:root` split into dark/light blocks; 5 new tokens; `#fff` → `--on-accent`; component spot-fixes |
| `assets/theme-init.js` | **NEW** — resolve + stamp + listeners; blocking load in `<head>` before stylesheet |
| `shannon-shared.js` | Appearance segmented control + apply + `themechange` dispatch |
| `shannon-stats.html` | `chartColors()` + re-render on `themechange`; `#fff` → `--on-accent` |
| `shannon-chat/agent/routines.html` | `<head>` init script tag; inline color spot-checks |
| `index.html` | init script tag |

### L8. Acceptance checks

1. No FOUC / wrong-theme flash on any page (init script synchronous, pre-CSS).
2. Contrast ≥ 4.5:1 in both themes: `--fg` on `--bg`, `--fg-2`/`--fg-3` on `--surface`,
   links (light uses `--accent-text`). Accent-fill button pairing documented in L3.
3. Zero new hex literals — light scale is locked literals + `oklch(from …)` only
   (grep-verified against the 10-hex set).
4. `shannon-theme` persists across reloads; `system` follows OS live; `storage` event
   syncs pages.
5. Charts re-render resolved colors on `themechange`; no stale dark fills; legends match.
6. All 13 Review-Round-1 checks unaffected; zero console errors on all 5 pages × both
   themes.
7. Theme switch changes **color only** — radii, spacing, typography, layout untouched.
8. Both copies (OD project + repo `design/`) synced.

### L9. Decisions (locked 2026-08-12)

1. **Default theme** — `system` when nothing is stored.
2. **Code blocks in light mode** — light-themed via `--code-bg` (matches GitHub
   light); no dark code islands.

No open questions remain in this round.

---

## React Component Breakdown — Plan (2026-08-16) — **ACTIVE**

### RC1. Intent & audit

Break the five HTML surfaces down into a reusable React component library.
What exists today (audited 2026-08-16):

- `shannon.css` — token layer + **~85 shared classes** (shell, sidebar, threadlist,
  buttons, cards, badges, inputs, switch, tables, modals, composer, settings, model
  modal, smart routing, theme seg).
- `shannon-shared.js` — Settings modal (6 tabs), Model modal v2, `SHANNON_MODELS` /
  `SHANNON_WORKSPACES` fixtures, `locationBadge()`, settings/smart-routing/thinking-
  level persistence, toast.
- Per-surface JS — chat (~55 classes: messages, thinking, tool cards, composer,
  context panel, ctx menu), agent (~45: run header, tool rows, diff, permission bar,
  inspector, todos), routines (~15: cron builder, drawer), stats (~20: KPI cards,
  SVG charts, range tabs).
- Theme system — `assets/theme-init.js` + `[data-theme]` token blocks (L-round).

Nothing is thrown away: the HTML/CSS prototype stays as the **visual reference of
record**; the React app must match it pixel-for-pixel.

### RC2. Target architecture (locked 2026-08-16: option A + C)

| Option | What it means | Trade-off |
|---|---|---|
| **A. Web React (recommended)** | Vite + React 18 app in `design/react/`, imports `shannon.css` unchanged | Pixel-parity free; theme system just works; verifiable in browser today |
| B. Gluestack v5 / RN now | Components straight into `packages/ui` style (RN + react-native-web) | Final destination per original brief, but CSS-var theming doesn't translate to RN inline styles; no quick visual verification |
| C. A now, shaped for B | Web React with gluestack-style APIs (compound components, variant props) so the RN port is mechanical | Recommended path: **A with C's API discipline** |

The token contract is unchanged either way: `docs/design-system.md` + `shannon.css`
`:root` blocks remain the source of truth; React components consume the same CSS
variables, so the locked palette/type/radius rules keep passing unchanged.

### RC3. Folder structure (new, under the repo's `design/`)

```
design/react/
  index.html                  # Vite entry
  package.json  vite.config.ts  tsconfig.json
  src/
    main.tsx  App.tsx         # hash routing between the 5 surfaces
    theme/ThemeProvider.tsx   # theme-init.js logic as provider + useTheme()
    fixtures/                 # conversations.ts, models.ts, workspaces.ts,
                              # routines.ts, stats.ts (lifted from inline JSON)
    components/
      primitives/   Button Card Badge Input Select Switch Segmented Modal
                    Table Kbd ProgressBar StatusDot Avatar Toast
      layout/       AppShell Sidebar NavItem ThreadList ThreadRow MainHeader
                    MobileBar AccountRow SaveBar
      composer/     Composer ComposerChips AttachmentChip WorkspaceChip
                    ModelSelector ContextIndicator SendButton SmartRouteToggle
                    ModeDropdown
      chat/         MessageList Message ThinkingBlock ToolCallCard CodeBlock
                    UsageLine ForkChips MessageActions ContextMenu ContextPanel
                    PromptSuggestions EmptyState
      agent/        RunHeader AgentStream ToolCallRow DiffView PermissionBar
                    PlanningBanner CompactionMarker Inspector TodoList
                    ChangedFiles CtxMeterMini
      routines/     RoutineTable RoutineRow RoutineCard CronBuilder
                    RunHistoryDrawer EmptyRoutines
      stats/        StatsGrid KpiCard ChartCard RangeTabs Sparkline AreaChart
                    LineChart BarChart PercentileBars
      settings/     SettingsModal SettingRow ThemeSeg SmartRoutingPanel
                    (6 tab sections as own components)
      models/       ModelModal ModelRow ModelGroup ThinkingLevels
    surfaces/       ChatSurface AgentSurface RoutinesSurface StatsSurface
                    LauncherSurface
```

### RC4. Component inventory (from the CSS/JS audit — every pattern has a home)

- **Primitives** — `.btn*` → `<Button variant="primary|ghost|danger|secondary"
  size="sm|lg">`; `.card*` → `<Card>` compound (`Card.Header/Title/Sub/Body`);
  `.badge-*` → `<Badge tone>` + `<LocationBadge location="server|device">`
  (ports `locationBadge()`); `.input/.select` → `<Input>/<Select>`; `.switch` →
  `<Switch checked onChange>`; `.theme-seg` → `<Segmented>`; `.modal-*` →
  `<Modal>` compound; `.table` → `<Table striped>`; `.status-dot`, `.kbd`,
  `.download-progress` → `<StatusDot>/<Kbd>/<ProgressBar>`; toast → `useToast()`.
- **Layout** — `.shell/.sidebar*/.nav-item` → `<AppShell nav activeSurface>`;
  `.threadlist*` + `.thread-row*` → `<ThreadList>` + `<ThreadRow selected
  onContextMenu>`; `.main-header/.mobile-bar` → `<MainHeader>/<MobileBar>`;
  `.account-row` → `<AccountRow>`; `.save-bar` → `<SaveBar dirty>`.
- **Composer (U1 parity, shared by chat + agent)** — `<Composer>` owns input,
  send↔stop, chips row; slots for `<ModelSelector>` (opens `<ModelModal>`),
  `<ContextIndicator>` (ring + stats popup), `<SmartRouteToggle>` + `<ModeDropdown>`
  (agent only), `<AttachmentChip>`/`<WorkspaceChip>`. Enter never sends (C7).
- **Chat** — `<MessageList>` of `<Message>` (avatar, head, body, `<UsageLine>`,
  hover `<MessageActions>`: Copy/Fork/Rewind/Regenerate); `<ThinkingBlock>`
  collapsible; `<ToolCallCard>`; `<CodeBlock>` with copy; `<ForkChips>`;
  `<ContextMenu>` (Open/Fork/Rewind/Rename/Pin/Export/Delete); `<ContextPanel>`
  (files, meter, cost); `<PromptSuggestions>`/`<EmptyState>`.
- **Agent** — `<RunHeader>` (state dot, title, target; no stat spans per R3);
  `<AgentStream>` of `<ToolCallRow>` (8 v1 tools, expandable `<ToolDetail>` /
  `<ToolOutput>`, `<DiffView>` for fs_edit); `<PermissionBar>` (Allow once /
  Always / Deny); `<PlanningBanner>`; `<CompactionMarker>`; `<Inspector>`
  slide-over with `<TodoList>`, `<ChangedFiles>`, `<CtxMeterMini>`.
- **Routines** — `<RoutineTable>`/`<RoutineCard>` (responsive), `<CronBuilder>`
  (presets, validation, humanized preview), `<RunHistoryDrawer>`, `<EmptyRoutines>`.
- **Stats** — `<StatsGrid>` of `<KpiCard>` (+`<Sparkline>`); `<ChartCard>` with
  `<RangeTabs>`; `<AreaChart>/<LineChart>/<BarChart>/<PercentileBars>` — same
  hand-rolled SVG generators, re-rendered on `themechange` (L-round behavior).
- **Settings / Models (shared modals)** — `<SettingsModal tab>` deep-linkable,
  6 sections as components incl. `<ThemeSeg>` + `<SmartRoutingPanel>`;
  `<ModelModal>` with search, `<ModelGroup>`s (incl. Remote Models), per-row
  `<ThinkingLevels>`.

### RC5. API conventions

- **Variant props, not class strings** — `<Button variant="primary">`, never
  `className="btn-primary"` from consumers; components map to the existing CSS
  classes internally (this is the gluestack-style discipline that makes the RN
  port mechanical).
- **Compound components** where the DOM is a unit: `Modal`, `Card`,
  `SettingsModal`, `ModelModal`, `Composer` (slots).
- **Data in via props; fixtures only at the surface level** — components are pure
  and reusable; surfaces wire fixtures + state.
- Preserve `data-od-id` values as an optional `odId` prop so preview annotations
  keep working.
- Every interactive component ships its hover/focus/active/disabled states exactly
  as the CSS defines them — no state styling invented in JS.

### RC6. State & data

- `src/fixtures/*` — lifted verbatim from the inline JSON (conversations with full
  histories, models, workspaces, routines, stats series). Placeholder GGUF names
  stay flagged as before.
- Hooks: `useTheme()` (provider ports `theme-init.js`: `shannon-theme`
  localStorage, system resolution, cross-tab `storage` sync, `themechange`
  dispatch for charts), `useSettings()`, `useSmartRouting()`,
  `useThinkingLevel(convKey)`, generic `useLocalStorage()`.
- Surface state colocated: chat (active conversation, streaming, ctx menu),
  agent (run playback state machine, inspector open), routines (modal/drawer),
  settings (dirty → `<SaveBar>`). No global store in v1 (RC9.5).

### RC7. Theme mapping

`shannon.css` is imported once in `main.tsx` — **zero token changes, zero new hex
literals**; the dark/light blocks and `color-mix()` derivations keep working.
`ThemeProvider` replaces the inline script: sets `data-theme` on
`documentElement` before first paint (Vite injects it synchronously), keeps
system + cross-tab sync, and the stats charts subscribe to re-render.

### RC8. Build workflow & acceptance checks

Order: scaffold → primitives + layout → **chat surface first** (reference
implementation proving the composer/modal/theme stack) → agent → routines →
stats → launcher. Each surface is verified side-by-side against its HTML original
at 1440/768/390 before the next starts.

- [ ] All 5 surfaces render and route; zero console errors
- [ ] Visual parity with HTML originals at 1440/768/390 (spot-check per surface)
- [ ] Theme: Light/Dark/System switching, persistence, cross-tab sync, chart
      re-render — all L8 behaviors still pass
- [ ] Round-1 behaviors preserved: unified composer, settings modal on all
      surfaces, model modal v2, smart routing, location badges, agent inspector
      slide-over, no Enter-to-send
- [ ] No new hex literals anywhere in `src/` (grep check); components consume
      CSS classes/tokens only
- [ ] Public Sans loading unchanged (fonts.css import)
- [ ] HTML prototypes untouched; both copies synced

### RC9. Decisions (locked 2026-08-16)

All five answered with the recommended options:

1. **Target stack** — **A + C**: web React (Vite + React 18) in `design/react/`
   with gluestack-style component APIs; Gluestack RN port into `packages/ui`
   deferred to a later round.
2. **Language** — **TypeScript**, matching the repo.
3. **Port order** — **chat-first vertical slice** (proves the composer/modal/theme
   stack), then agent → routines → stats → launcher per RC8.
4. **HTML prototypes** — **kept** as the visual reference of record; not deleted
   after parity.
5. **State** — **colocated hooks only**; no global store in v1.

No open questions remain in this round.

---

## 1. Locked inputs

| Input | Value | Status |
|---|---|---|
| Product | Self-hosted AI assistant with agent harness; llama.cpp inference, agent harness, sandboxes, routines, offline-first sync with conversation forks (IMPLEMENTATION.md §1) | Locked |
| Clone target | Reference analytics dashboard layout — governs **Stats surface layout only** | Locked |
| Theme engine | Repo ground truth (§2): `config-style` tokens + gluestack-v5 skill rules | Locked |
| Palette (hybrid — user decision 2026-08-11) | Neutrals from repo `design-tokens.js`: bg `#18181b` / `#27272a` / `#3f3f46` · fg `#f4f4f5` / `#a1a1aa` / `#71717a` · border `#3f3f46` · danger `#dc2626` · success `#16a34a`. Accent = **aqua** `#0096ff`, hover `#1da1f2` (overrides repo violet `#6d28d9` / `#7c3aed`) | **Locked** |
| Radii / spacing / type scale | radii 6 / 10 / 16 / full · spacing 4 / 8 / 16 / 24 / 32 · fontSizes 12 / 14 / 16 / 18 / 24 (unitless numbers; RNW converts to px) | Locked |
| Font family | **Public Sans** (user decision 2026-08-11), self-hosted woff2, display + body (single family justified: utilitarian, data-dense console); fallback `system-ui, -apple-system, Segoe UI, Helvetica Neue, Arial, sans-serif` | **Locked** |
| Data | Fixtures mirroring the real Drizzle schema (§7), clearly labeled demo data | Locked |

## 2. Repo ground truth (read 2026-08-11)

Sources: `AGENTS.md`, `docs/IMPLEMENTATION.md`,
`.agents/skills/gluestack-ui-v5/SKILL.md`, `packages/config-style/design-tokens.js`,
`packages/ui/src/{layout/AppShell.tsx,layout/components.tsx,components/index.tsx,theme/index.ts}`.

Hard constraints the design must respect:

- **D6 platform split:** web = inline styles via react-native-web (NativeWind fails
  on Vite); mobile = NativeWind v4 + Metro. → Token values must stay consumable as
  **JS numbers**; the HTML prototype expresses them as CSS vars but the plan's token
  table (§6) is the JS-number source of truth.
- **Gluestack skill rules:** semantic tokens ONLY (`bg-primary`, `text-foreground`,
  `bg-card`, `border-border`…) — never generic/numbered colors; component props over
  className; compound components (`ButtonText`, `InputSlot`…); spacing scale, no
  arbitrary px; tva for variants; `InputIcon` must sit in `InputSlot`.
- **Existing AppShell:** `Sidebar` (260px, bg.secondary, 1px border-right; nav =
  chat / agent / stats / settings; "OS" avatar + "Open-Shannon" wordmark) +
  `ThreadList` (280px, rows = title + kind Badge + relative time) + main pane
  (`ChatView` + `Composer`, min-height-44 input). The prototype elevates this shell,
  it doesn't reinvent it.
- **Data model (§6 of IMPLEMENTATION.md):** conversations have `kind` =
  `chat | agent | routine`; messages are a **tree** (`parent_id`) with visible
  **forks**; `ContentBlock` = text | thinking | tool_call | tool_result | attachment;
  usage is tracked per completion in `usage_records` (input/cached/output tokens,
  TTFT, pp/tg speeds) — **local inference has no dollar cost**; stats are tokens,
  cache-hit %, and speeds.
- **Harness (§7):** tools v1 = `fs_read, fs_write, fs_edit, bash, grep, glob,
  web_fetch, todo_write`; permission modes **planning / manual / auto**; run states
  `running | awaiting_approval | done | error`; compaction into `summary` nodes.
- **Routines (§6.1):** `routines(name, cron, prompt, target, enabled, last_run_at,
  next_run_at)` + `routine_runs(status, started_at, finished_at)`; ntfy
  notifications. → Confirms "routines = scheduled agent runs".

---

## 3. Surface map & file strategy

Six self-contained files. **Each surface file is responsive** (designed at 1440px,
collapses to the Shannon mobile pattern at ≤768px, verified at 390px) instead of
splitting mobile files — keeps the round at 6 files instead of 11.
Responsive-per-surface confirmed (user, 2026-08-11).

| File | Surface | Repo view | Reference |
|---|---|---|---|
| `index.html` | Launcher/overview | — | — |
| `shannon-chat.html` | Chat | `chat` | Shannon desktop + mobile chat |
| `shannon-agent.html` | Agent console | `agent` | Shannon agent harness UX, app-native |
| `shannon-routines.html` | Routines | (new nav item) | `routines` schema |
| `shannon-settings.html` | Settings | `settings` | Shannon settings pattern |
| `shannon-stats.html` | Stats | `stats` | Analytics dashboard layout (layout) |

Routines as the fifth sidebar item confirmed (user, 2026-08-11).

## 4. Shared shell (all surfaces)

**Desktop (≥1024px):** three-column AppShell, faithful to the repo layout —
1. **Sidebar (260px, bg.secondary):** wordmark + avatar; "New chat" primary button
   (aqua accent fill — the shell's single primary CTA); nav items (Chat · Agent ·
   Routines · Stats · Settings) with active row = bg.tertiary fill; connection/sync
   status line (server · local) pinned above the account row at bottom.
2. **ThreadList (280px):** context-aware recents (chats / agent runs / routine
   history per surface), rows = title + kind Badge + relative time, search filter,
   hover actions (rename, delete); collapses away on narrow screens.
3. **Main pane:** surface content + composer where applicable.

**Mobile (≤768px):** top bar (hamburger → drawer containing sidebar + thread list;
surface title; one contextual action); bottom composer on Chat/Agent. Touch targets
≥44px; no horizontal scroll.

## 5. Surface specs

### 5.1 Chat (`shannon-chat.html`)

- **Thread:** user + assistant messages rendering `ContentBlock[]` — markdown text,
  collapsible **thinking** blocks, tool_call/result cards when a chat turns agentic,
  attachment chips; fenced code with copy; streaming state (send ↔ stop swap).
- **Forks (core differentiator, Stage 3 spec):** fork chips on branched nodes, branch
  picker on hover, "continue here" affordance, jump between branches, branch
  soft-delete. Origin badge (`server`/`device`) on offline-originated messages.
- **Per-assistant-message line (§6.5 micro-feature):** muted
  `38 tok/s · cached 64% · 1,240 in / 386 out`; an estimated-cost figure appears only
  when the selected model fixture has a non-zero price (local GGUFs = $0). Cost
  display confirmed kept (user, 2026-08-11).
- **Header:** chat title (inline rename), **model selector** (grouped menu:
  server models from `model_registry` / on-device models; each row = name, quant,
  context size; single-select with check), context-panel toggle.
- **Composer:** auto-growing textarea (Enter sends), attachment button → file chips
  (name, size, remove) with drag-over state, **workspace chip** (attach a server-side
  directory as context), tools toggle, send/stop.
- **Context panel (toggleable; bottom-sheet on mobile):** attached files + workspace
  with per-item token counts, context meter (% of model's `context_tokens`),
  conversation usage accumulator (tokens, cache %, est. cost if priced).
- **Empty state:** centered prompt suggestions (secondary cards).

### 5.2 Agent console (`shannon-agent.html`) — Shannon agent harness

- **ThreadList** shows agent runs (title, repo/branch chip, status dot).
- **Run header:** title, sandbox/workspace target chip, **mode selector
  (planning / manual / auto)** mid-run switchable, run-state badge
  (running / awaiting_approval / done / error), elapsed time, tokens + cache %
  for the run (`run_id`-scoped), stop/pause.
- **Stream:** user prompt; agent messages; collapsible thinking; **tool-call rows**
  for the v1 tools (`fs_read`, `fs_write`, `fs_edit` w/ inline diff from
  `tool_result.diff`, `bash` w/ output, `grep`, `glob`, `web_fetch`, `todo_write`)
  — icon, summary, duration; expand/collapse for detail; compaction marker where a
  `summary` node replaced history.
- **Permission bar** (manual mode / denylisted tools): pinned above composer —
  action summary + Allow once (solid accent) / Always allow / Deny; planning mode
  shows a read-only banner instead (writes blocked, output = plan artifact).
- **Right inspector (bottom-sheet on mobile):** live todo list (from `todo_write`),
  changed files with +/- counts, context % meter, run usage.
- **Steer input** composer; disabled while paused. Fixture playback confirmed
  (user, 2026-08-11).

### 5.3 Routines (`shannon-routines.html`)

Grounded in the `routines` / `routine_runs` schema:
- Header + "New routine" primary (only primary on this surface).
- **Table (desktop) / card list (mobile):** name, prompt summary, humanized cron
  ("Weekdays 09:00"), target (chat / agent run + workspace), model, last run
  (status badge + relative `last_run_at`), `next_run_at`, enabled Switch, actions
  (run now, edit, delete).
- **Create/edit modal:** name, prompt textarea, schedule builder (presets + custom
  cron with validation + humanized preview), target + model selects, ntfy
  notification toggle. Save disabled until valid; inline errors.
- **Row → detail drawer:** `routine_runs` history (status, started/finished,
  duration, tokens), each row linking to its conversation.
- Empty state; toggle + run-now persist via `localStorage`.

### 5.4 Settings (`shannon-settings.html`)

Section nav (left rail / top tabs on mobile):
- **General:** profile (better-auth user), default mode, appearance (dark-only —
  noted, no picker).
- **Models:** `model_registry` manager — server GGUFs (display name, quant, size,
  context) with add-by-URL; **device models** with download-manager rows (progress
  state); per-mode defaults (planning / manual / auto) selects.
- **Workspaces:** registered server-side directories (name, host path, remove).
- **Devices:** `devices` rows (name, platform, `last_seen_at`), revoke.
- **Server:** Tailscale/MagicDNS address, inference endpoint, connection status.
- **Usage:** link into Stats + compact per-model totals table.
- Masked API-key pattern is N/A (no cloud keys) — replaced by GGUF URL + Tailscale
  fields; destructive actions use confirm dialogs; dirty Save bar + toast; all
  persisted to `localStorage`.

### 5.5 Stats (`shannon-stats.html`) — Analytics dashboard layout, `usage_records` content

Layout follows standard analytics dashboard patterns (§8); content follows
IMPLEMENTATION.md §6.5:

- **Range tabs:** Session / Today / Week / Month / Year (drive all widgets).
- **KPI card row** (stat-card pattern): tokens today, cache-hit %, avg TTFT,
  avg generation tok/s — each with delta chip + sparkline.
- **Large area/line card:** tokens over time, stacked by model.
- **Bar card:** pre-fill (pp) vs generation (tg) speeds per model.
- **Line card:** cache hit-rate over time.
- **Percentile panel:** TTFT / duration p50/p95.
- **Tables:** per-model and per-conversation usage (striped rows, hover).
- Charts are hand-rolled inline SVG (mirrors D18 react-native-svg decision) with
  filled encodings — aqua accent + `#1da1f2` for series, derived zinc tints for
  grids.

Every dashboard-derived layout element is **TODO(verify)** until measured against the
live page in dark mode.

## 6. Theme engine — tokens → gluestack semantics

Token table (single source of truth; values are JS numbers per AGENTS.md gotcha):

| gluestack semantic | Source token | Value |
|---|---|---|
| `background` | repo `bg.primary` | `#18181b` |
| `card` / `background-secondary` | repo `bg.secondary` | `#27272a` |
| `muted` / hover fill | repo `bg.tertiary` | `#3f3f46` |
| `foreground` | repo `fg.primary` | `#f4f4f5` |
| `foreground-secondary` | repo `fg.secondary` | `#a1a1aa` |
| `muted-foreground` | repo `fg.muted` | `#71717a` |
| `border` | repo `border` | `#3f3f46` |
| `primary` | **Aqua** (user decision) | `#0096ff` |
| `primary-hover` | aqua hover | `#1da1f2` |
| `primary-foreground` | repo `fg.primary` | `#f4f4f5` |
| `destructive` | repo `danger` | `#dc2626` |
| `success` | repo `success` | `#16a34a` |

10 unique hexes total (border repeats bg.tertiary) — **the only color literals in
any artifact**; alpha variants via `color-mix()`/oklch relative syntax on these
tokens only (mirrors the skill's `/70` alpha allowance).

- Radii sm 6 / md 10 (default for cards, buttons, inputs — matches existing
  `packages/ui` components) / lg 16; spacing scale 4/8/16/24/32 only; type scale
  12/14/16/18/24 in **Public Sans**.
- Port note: on the repo side, override `colors.accent` / `accentHover` in
  `packages/config-style/design-tokens.js` (violet → aqua) rather than forking
  component styles; self-host Public Sans in each client (web font-face, Expo
  bundled font, Electron inherits the web build).
- Port mapping: each prototype component names its gluestack counterpart
  (`packages/ui` copy-paste set): Button (primary/secondary/ghost), Input
  (InputSlot rule), Card, Badge, Avatar, Separator already exist → extend per
  skill's `creating-components` templates (Modal, Switch, Table, Tabs, Accordion,
  Menu, ActionSheet/BottomSheet, Progress, Toast, AlertDialog, FormControl).

## 7. Data & fixtures

Inlined `fixtures.js` per file, shaped like the real schema (Drizzle §6.1):

- `models[]` ← `model_registry`: {id, display_name, quant, size_bytes,
  context_tokens, location: server|device|both, pricePer1M (0 for local)}.
  Placeholder GGUF entries (e.g. small/medium/large quants) — **TODO(user):** drop
  in real model names (last remaining open item, §10).
- `conversations[]` / `messages[]`: tree by `parent_id`, ContentBlock kinds,
  per-message `usage` {input_tokens, cached_tokens, output_tokens, ttft_ms,
  predicted_tps} → the `tok/s · cached %` line and all Stats math are **computed
  from fixtures**, never hardcoded.
- `runs[]`: conversation kind `agent` + steps (message | thinking | tool_call |
  tool_result w/ FileDiff), todos, changedFiles, run_state.
- `routines[]` / `routineRuns[]` per schema; next_run derived from cron or fixture.
- `workspaces[]`, `devices[]`, `settings` (per-mode defaults).
- UI mutations (toggles, renames, settings, screen position) via `localStorage`.
  No network calls.

## 8. Build workflow (Design mode, web-clone skill)

1. Initialize project skeleton → `NOTES.md`.
2. Dashboard layout (Stats surface only): standard analytics dashboard patterns.
   Self-host **Public Sans** (woff2 + `assets/fonts/fonts.css`).
   Chat/Agent/Routines/Settings are original designs governed by §2 repo truth,
   not clone sources.
3. Build order: shared tokens + shell → `shannon-stats.html` →
   `shannon-chat.html` → `shannon-agent.html` → `shannon-routines.html` →
   `index.html`; then `od-preview-rewrite.mjs`.
4. Verify per §9; serve locally, console clean; Stats fidelity check.
5. Licensing (NOTES.md): all layout patterns are standard analytics dashboard
   conventions — no third-party branding ships. Public Sans is OFL-licensed — fine to
   self-host.

## 9. Acceptance checks

**Global (every file)**
- [ ] Color literals ⊆ the 10 locked hexes (§6); alpha/derivations via
      `color-mix()` or oklch relative syntax on tokens only
- [ ] Radii only 6/10/16 (+full); spacing only 4/8/16/24/32; type only 12/14/16/18/24;
      **Public Sans** self-hosted woff2 + declared system fallback
- [ ] Semantic-token discipline mirrors the gluestack skill (no generic/numbered
      color classes in port notes)
- [ ] Shell geometry: sidebar 260px + thread list 280px, 1px `#3f3f46` borders,
      active nav = bg.tertiary fill
- [ ] One primary CTA per viewport per surface; hover/focus states keep ≥4.5:1
      contrast with fg/bg moving as a pair; visible `:focus-visible` rings
- [ ] No overlaps/clipping/orphans; no horizontal scroll at 390px; targets ≥44px
- [ ] `data-od-id` on regions/headings/CTAs/repeated cards; files ≤ ~1000 lines;
      no `scrollIntoView`; no placeholders or dead sections

**Chat**
- [ ] Composer auto-grows; Enter/Shift+Enter correct; send↔stop while streaming
- [ ] Attachment chips add/remove + drag-over state; workspace chip attach/detach
- [ ] Model menu groups server vs device models; selection updates header + hints
- [ ] Per-message `tok/s · cached %` line matches fixture math; fork chips + branch
      picker switch visible branch; origin badges on device-originated messages
- [ ] Context meter % correct vs model `context_tokens`; cost figure only when priced

**Agent console**
- [ ] All 8 v1 tools render distinct row/detail treatments; `fs_edit` shows diffs
      (danger/success tokens only for +/- lines)
- [ ] Mode selector switches planning/manual/auto and changes stream behavior;
      permission bar's Allow once / Always / Deny produce visibly different outcomes;
      planning mode blocks writes with a banner
- [ ] Todos + changed files stay in sync with stream fixtures; run-state badge
      transitions running → awaiting_approval → done

**Routines**
- [ ] Cron validates + humanizes; invalid blocks Save; fields match schema (name,
      cron, prompt, target, enabled, last/next run)
- [ ] Toggle + run-now persist across reload; detail drawer lists `routine_runs`

**Settings**
- [ ] Per-mode default model selects (planning/manual/auto); device-model download
      rows show progress state; workspace add/remove; device revoke confirms
- [ ] Dirty state enables Save; toast + persistence across reload

**Stats**
- [ ] Range tabs re-bucket every widget from fixtures; charts filled (area/bar/line),
      aqua accent series, zinc-tinted grids
- [ ] KPI cards show tokens, cache %, TTFT, tok/s (no dollar KPIs for local models)
- [ ] Layout fidelity: visual-diff + strict audit pass

## 10. Decisions & open questions

Resolved (user, 2026-08-11):

1. **Palette** — hybrid: repo zinc neutrals + **aqua** accent (`#0096ff`,
   hover `#1da1f2`); repo danger/success kept; repo violet overridden.
2. **Font** — **Public Sans**, self-hosted.
3. **Routines nav** — fifth sidebar item confirmed.
4. **Cost display** — kept: optional per-model $/1M; local GGUFs = $0, cost UI
   hidden when unpriced.
5. **Scope mechanics** — responsive-per-surface (6 files); agent console is fixture
   playback.

Still open:

- **Fixture model names** (§7) — placeholder GGUF entries until you supply the real
  `model_registry` roster. Non-blocking; fixtures are editable post-build.

---

## Next step

All prior rounds are implemented and both copies synced:
- Review Round 1 (unified composer, settings modal, model modal v2, smart routing, badges)
- Light Mode (dark/light/system, FOUC-free, chart re-render)
- React Component Breakdown (RC1–RC9) — **implemented 2026-08-16**

The React app at `design/react/` ships all 5 surfaces (chat, agent, routines, stats,
launcher) as TypeScript components consuming `shannon.css` unchanged. Verification:
`tsc --noEmit` clean, `vite build` succeeds (82 modules), zero hex literals in `src/`,
theme-init.js in `public/` for FOUC-free boot, fixtures lifted to `src/fixtures/`,
hooks porting all localStorage persistence (theme, settings, smart routing, thinking
levels). Both OD project and repo `design/react/` are in sync.

Run `cd design/react && npm run dev` to serve at localhost:5174.
