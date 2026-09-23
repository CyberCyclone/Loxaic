# Loxaic UI Design System

**Version:** 1.0 · **Last updated:** 2026-08-12

## 1. Overview

Loxaic is a self-hosted AI assistant with an agent harness. The UI provides five surfaces — chat, agent console, routines, stats, and a launcher — built as self-contained HTML files sharing a CSS token system and a JS component library.

**Design goals:** data-dense, console-grade clarity; dark-first with system-aware light mode; one accent color used sparingly; responsive at 1440/768/390px.

## 2. File Structure

```
design/
├── index.html              # Launcher — links to all surfaces
├── loxaic.css             # Shared tokens + shell + components (316 lines)
├── loxaic-shared.js       # Settings modal, model modal v2, smart routing, location badges
├── assets/
│   ├── theme-init.js       # Blocking theme bootstrap (system resolution, no FOUC, cross-tab sync)
│   └── fonts/
│       ├── fonts.css       # @font-face declarations (self-hosted Public Sans)
│       └── *.woff2         # 3 weights: 400 Regular, 500 Medium, 600 SemiBold
├── loxaic-chat.html       # Chat surface
├── loxaic-agent.html      # Agent console surface
├── loxaic-routines.html   # Scheduled recurring agent runs
├── loxaic-stats.html      # Usage analytics
├── docs/
│   └── design-system.md    # This file
├── AGENTS.md               # Agent instructions for working on the Loxaic UI
├── plan.md                 # Design plan document
└── NOTES.md                # Build notes, scoring, known gaps
```

## 3. Design Tokens

All tokens are defined as CSS custom properties in `loxaic.css`. Dark mode is the `:root` default; light mode overrides via `html[data-theme="light"]`.

### 3.1 Color Palette

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#18181b` | `#ffffff` | Page background |
| `--surface` | `#27272a` | `#f4f4f5` | Cards, sidebar, thread list |
| `--muted` | `#3f3f46` | `color-mix(...)` | Hover states, muted backgrounds |
| `--fg` | `#f4f4f5` | `#18181b` | Primary text |
| `--fg-2` | `#a1a1aa` | `color-mix(...)` | Secondary text |
| `--fg-3` | `#71717a` | `#71717a` | Tertiary text, labels, meta |
| `--border` | `#3f3f46` | `color-mix(...)` | Borders, dividers |
| `--accent` | `#0096ff` | `#0096ff` | Primary accent (links, buttons, focus) |
| `--accent-2` | `#1da1f2` | `#1da1f2` | Accent hover state |
| `--accent-text` | `var(--accent)` | `color-mix(in oklch, #0096ff, #18181b 38%)` | Link text color (4.5:1 on white in light) |
| `--on-accent` | `#ffffff` | `#ffffff` | Text/icon color on accent-fill surfaces |
| `--code-bg` | `var(--bg)` | `#f4f4f5` | Code block, tool output backgrounds |
| `--danger` | `#dc2626` | `#dc2626` | Error, destructive actions |
| `--success` | `#16a34a` | `#16a34a` | Success, connected status |
| `--warning` | `oklch(0.75 0.16 65)` | `oklch(0.60 0.18 65)` | Warnings, in-progress states |

**Locked hex literal set** (the only hex values allowed in CSS/HTML/JS):
```
#18181b  #27272a  #3f3f46  #f4f4f5  #a1a1aa  #71717a
#0096ff  #1da1f2  #dc2626  #16a34a  #ffffff
```
All other colors must be derived via `color-mix()` or `oklch()` relative syntax referencing these literals.

### 3.2 Typography

| Property | Value |
|---|---|
| Font family | `"Public Sans", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif` |
| Self-hosted | 3 woff2 weights (400/500/600) in `assets/fonts/` |
| Display + body | Same family (data-dense console — single family is appropriate) |
| Monospace | `ui-monospace, "SF Mono", monospace` (system font, not self-hosted) |

### 3.3 Spacing & Layout

| Token | Value | Usage |
|---|---|---|
| `--sidebar-w` | `260px` | Left navigation sidebar (collapsed: 208px via JS) |
| `--threadlist-w` | `280px` | Chat thread list panel |
| `--header-h` | `56px` | Top header height |
| `--r-sm` | `6px` | Badges, buttons, inputs, small controls |
| `--r-md` | `10px` | Cards, modals, popovers |
| `--r-lg` | `16px` | Large modals, overlay containers |
| `--r-full` | `9999px` | Pills, avatars, status dots |

Spacing follows a 4/8px baseline grid. Card padding: 16–24px. Touch targets: ≥32px (SM: 28px, LG: 40px).

### 3.4 Shadows

| Token | Dark | Light |
|---|---|---|
| `--shadow-1` | `none` | `0 1px 3px rgba(0,0,0,.08)` |
| `--shadow-2` | `0 8px 24px rgba(0,0,0,.3)` | `0 8px 24px rgba(0,0,0,.12)` |

## 4. Theme System

### 4.1 Architecture

- `:root` = dark tokens (default)
- `html[data-theme="light"]` = light token overrides
- `assets/theme-init.js` is a **blocking script** loaded in `<head>` before first paint — reads `localStorage['loxaic-theme']`, resolves system preference via `matchMedia('(prefers-color-scheme: light)')`, and sets `data-theme` on `<html>`
- Default preference: `system` (respects OS dark/light setting)

### 4.2 LoxaicTheme API

Exposed on `window.LoxaicTheme` by `theme-init.js`:

```js
LoxaicTheme.get()        // Returns 'light' | 'dark' | 'system'
LoxaicTheme.set(pref)    // Sets preference, applies theme, persists to localStorage
LoxaicTheme.resolved()   // Returns the actually-resolved theme ('light' or 'dark')
```

### 4.3 Cross-Tab Sync

- `storage` event listener: when another tab changes `loxaic-theme`, this tab re-applies
- `matchMedia` change listener: when OS preference changes and user selected "system", theme re-applies
- `themechange` CustomEvent dispatched on `window` after every theme application — charts and other JS-rendered content listen for this to re-render

### 4.4 Settings Control

The Appearance row in the Settings modal (General tab) has a three-button segmented control: **Light / Dark / System**. Wired to `LoxaicTheme.set()` in `loxaic-shared.js`.

## 5. Component Inventory

### 5.1 Shell Layout

- **Sidebar** (260px): brand logo, nav items, account row
- **Thread list** (280px, chat only): search, conversation rows with hover actions
- **Main pane**: header bar + scrollable content
- **Mobile** (≤1024px): sidebar + thread list become off-canvas drawers with hamburger toggle
- **Mobile** (≤768px): thread list hidden, opens from sidebar

### 5.2 Buttons

| Class | Style | Usage |
|---|---|---|
| `.btn-primary` | Solid accent fill, `--on-accent` text | One per action per viewport |
| `.btn-secondary` | Muted background, border, `--fg` text | Secondary actions |
| `.btn-ghost` | Transparent, `--fg-2` text → `--fg` on hover | Tertiary actions, close buttons |
| `.btn-danger` | Solid danger fill, `--on-accent` text | Destructive actions |
| `.btn-sm` / `.btn-lg` | 28px / 40px height | Size variants |

### 5.3 Cards

`.card` — surface background, 1px border, 10px radius, 16px padding. Used for stats KPIs, chart containers, model rows, setting rows.

### 5.4 Inputs

`.input` — 32px height, 6px radius, `--bg` background, 1px border. Focus state: accent border color. Used for text inputs, selects, textareas.

### 5.5 Badges

| Class | Appearance |
|---|---|
| `.badge-server` | Accent-tinted background, accent text |
| `.badge-device` | Muted-tinted background, secondary text |
| `.badge-success` | Success-tinted, success text |
| `.badge-danger` | Danger-tinted, danger text |
| `.badge-warning` | Warning-tinted, warning text |

### 5.6 Tables

Striped rows (alternating `color-mix` muted background), hover highlight. Used in stats (per-model, per-conversation) and settings (usage).

### 5.7 Modals

- **Settings modal** (760px): tabs-left/content-right layout, 6 sections (General, Models, Workspaces, Devices, Server, Usage), dirty-save bar, deep-linkable via `openSettings(tab)`
- **Model modal** (420px): search bar, grouped model list (Server/On-Device/Remote), thinking level chips, gear button → Settings › Models

### 5.8 Unified Composer

Shared between chat and agent surfaces:
- Model selector button → opens model modal
- Context indicator with stats popup (tokens, cost, cache %)
- Textarea with send/stop swap
- Agent-only: mode dropdown (Planning/Manual/Auto), smart routing toggle

### 5.9 Switches

36×20px toggle, muted track → accent track when checked, 16px knob translates 16px.

## 6. Surfaces

### 6.1 Chat (`loxaic-chat.html`)

Conversation-based chat with:
- Thread list with search, rename, pin, fork, rewind, export, delete
- Model selector with per-conversation thinking level
- File attachments with drag-drop
- Workspace context chips
- Expandable thinking blocks
- Inline tool-call cards (fs_read, grep, bash with results)
- Code blocks with copy button and language label
- Per-message usage line (tok/s · cached % · in/out)
- Fork chips for branched conversations
- Location badges (Server / On device)
- Context panel with token meter and cost

### 6.2 Agent Console (`loxaic-agent.html`)

Agent run console with:
- Run header with status, model, elapsed time
- Mode selector (Planning/Manual/Auto) in composer
- Streaming tool-call rows with expandable detail and inline diffs
- Permission bar (Allow once / Always / Deny)
- Planning banner and compaction markers
- Inspector slide-over with live todo list, changed files, context meter
- Smart routing toggle in composer

### 6.3 Routines (`loxaic-routines.html`)

Scheduled recurring agent runs:
- Routine list with enable/disable toggles
- Cron builder with presets and validation
- Humanized cron preview
- Directory/workspace selector
- Run history drawer
- All persisted to localStorage

### 6.4 Stats (`loxaic-stats.html`)

Usage analytics dashboard:
- 4 KPI cards with sparklines (tokens, cache %, TTFT, tok/s)
- Stacked area chart (tokens over time, by model)
- Line chart (cache hit-rate)
- Bar chart (pp/tg speeds by model)
- Percentile bars (TTFT p50/p95/p99)
- Per-model and per-conversation striped tables
- Range tabs (Today / 7d / 30d)
- All charts are hand-rolled SVG with filled encodings
- Charts re-render on `themechange` event

## 7. Rules

1. **One accent color** — aqua `#0096ff` appears at most twice per screen (e.g., one primary button + one focus ring)
2. **No gradients** — solid fills only, except `color-mix` derivations for tints
3. **No emoji as icons** — all icons are inline SVG with `currentColor`
4. **One primary CTA per viewport** — other entry points are secondary/ghost/text links
5. **Focus-visible** — 2px accent outline on every focusable element
6. **Contrast** — 4.5:1 minimum for text, 3:1 for large text and icons, in both themes
7. **Literal discipline** — only the 11 locked hex values; all else via `color-mix()`/`oklch()` on those literals
8. **No `#fff`** — use `var(--on-accent)` for text on accent-fill surfaces
9. **Self-hosted fonts** — no Google Fonts or CDN font links; use `assets/fonts/fonts.css`
10. **Responsive** — mobile layouts must not scroll horizontally; redesign for small screens rather than squeezing desktop

## 8. Build Workflow

1. Edit `loxaic.css` for token/shell/component changes
2. Edit `loxaic-shared.js` for settings modal / model modal changes
3. Edit surface files (`loxaic-*.html`) for surface-specific content
4. Add `<script src="assets/theme-init.js">` in `<head>` to any new HTML file
5. Use `var(--token)` in inline styles — never raw hex values
6. Run `grep -rn '#[0-9a-fA-F]\{3,8\}' *.html *.css *.js | sort -u` to verify literal discipline
7. Sync to `design/` in your checkout of the repository
