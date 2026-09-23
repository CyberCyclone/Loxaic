# AGENTS.md — Loxaic UI

**Read `docs/design-system.md` first.** It is the source of truth for tokens, components, theme system, and rules.

## Project in one line

Loxaic UI — self-hosted AI assistant interface: chat, agent console, routines, usage stats. Built as self-contained HTML files sharing a CSS token system and JS component library.

## Working directory

All files are in `design/` at the repo root (or the Open Design project directory, which mirrors it). The two copies must stay in sync.

## File responsibilities

| File | Role | Lines |
|---|---|---|
| `loxaic.css` | Tokens, shell layout, all component styles | ~316 |
| `loxaic-shared.js` | Settings modal, model modal v2, smart routing, location badges, toast | ~390 |
| `assets/theme-init.js` | Blocking theme bootstrap — system resolution, no FOUC, cross-tab sync | ~60 |
| `assets/fonts/` | Self-hosted Public Sans (3 woff2 weights + fonts.css) | — |
| `loxaic-chat.html` | Chat surface — thread list, messages, composer, context panel | ~900 |
| `loxaic-agent.html` | Agent console — run header, tool calls, permission bar, inspector | ~500 |
| `loxaic-routines.html` | Scheduled recurring agent runs — cron builder, history | ~400 |
| `loxaic-stats.html` | Usage analytics — KPI cards, SVG charts, striped tables | ~450 |
| `index.html` | Launcher — links to all surfaces | ~50 |
| `docs/design-system.md` | Design system documentation (tokens, components, rules) | — |
| `plan.md` | Design plan document — scope, decisions, acceptance checks | — |
| `NOTES.md` | Build notes, scoring, known gaps | — |

## Locked decisions

- **Palette:** zinc neutrals (`#18181b`/`#27272a`/`#3f3f46`/`#f4f4f5`/`#a1a1aa`/`#71717a`) + aqua accent (`#0096ff`/`#1da1f2`) + danger (`#dc2626`) + success (`#16a34a`) + white (`#ffffff`). These 11 hex values are the only color literals allowed anywhere.
- **Typeface:** Public Sans, self-hosted (3 woff2 weights in `assets/fonts/`). Fallback: `system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif`.
- **Radii:** 6px (small), 10px (medium), 16px (large), 9999px (full). No other radius values.
- **Layout:** 260px sidebar, 280px thread list, 56px header. Card UI with 1px borders and 16–24px padding.
- **Theme:** dark-first `:root` + `html[data-theme="light"]` override. Default preference: `system`. `theme-init.js` must load in `<head>` before paint.
- **Charts:** hand-rolled SVG with filled encodings. Re-render on `window.themechange` event.

## Rules

1. Every CSS color literal must be one of the 11 locked hexes. Derive anything else via `color-mix()` or `oklch()` on those literals.
2. Never use `#fff` — use `var(--on-accent)`.
3. Never use raw hex in inline `style=` attributes — use `var(--token)`.
4. One accent color per screen, at most twice (one primary button + one focus ring).
5. One primary CTA per viewport.
6. Every focusable element needs `:focus-visible` with 2px accent outline.
7. Touch targets ≥ 32px (SM: 28px, LG: 40px).
8. Mobile (≤768px) must not scroll horizontally.
9. No Google Fonts or CDN font links — use `assets/fonts/fonts.css`.
10. No emoji as functional icons — use inline SVG with `currentColor`.

## Commands

```bash
# Serve locally for testing
npx http-server -p 8765 -c-1

# Verify hex literal discipline
grep -rn '#[0-9a-fA-F]\{3,8\}' *.html *.css *.js assets/*.js | sort -u

# Verify no banned third-party references
grep -rni 'third-party-product-names' *.html *.css *.js *.md docs/*.md
# (should return nothing)

# Sync to the repository (LOXAIC_REPO = your checkout of it)
cp loxaic.css loxaic-shared.js loxaic-*.html index.html assets/theme-init.js \
   "$LOXAIC_REPO"/design/
cp -r assets/fonts/ "$LOXAIC_REPO"/design/assets/fonts/
cp docs/design-system.md "$LOXAIC_REPO"/design/docs/
cp AGENTS.md "$LOXAIC_REPO"/design/
```

## Gotchas

- **SVG chart colors:** `var(--token)` in SVG presentation attributes resolves dynamically in modern browsers, but chart functions must clear and re-render on `themechange` to be reliable.
- **`color-mix()` support:** requires modern browsers (Chrome 111+, Safari 16.2+, Firefox 113+). The `in oklch` colorspace is the canonical derivation path.
- **Code blocks:** use `var(--code-bg)`, not `var(--bg)` — light mode needs a subtle gray (`#f4f4f5`), not pure white, to distinguish code from page background.
- **`theme-init.js` must be in `<head>`** before `loxaic-shared.js` and before any rendering — it sets `data-theme` synchronously to prevent FOUC.
- **Settings is a modal, not a page** — `loxaic-settings.html` was deleted in Round 1. The settings modal is injected by `loxaic-shared.js` on every surface. The launcher's Settings link opens chat with `?settings=1` which auto-opens the modal.
