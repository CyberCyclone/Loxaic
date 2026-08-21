# Open-Shannon — Design Notes

## Source info
- Font: Public Sans (OFL) self-hosted (3 weights: 400/500/600)
- License: Public Sans = OFL

## Tech stack
- Pure HTML/CSS/JS — no framework, no build step
- Shared `shannon.css` (tokens + shell + components)
- 6 files: `index.html` (launcher) + 5 surface files
- Fonts: `assets/fonts/fonts.css` (self-hosted woff2)
- Theme: `assets/theme-init.js` (blocking system/dark/light resolution)
- Node: v24.15.0 (runtime only, not required to view)

## Design mode
- Complexity: L2 (static dashboard layout, no WebGL/SPA logic)
- Mode: Original Shannon UI with analytics dashboard layout reference
- Stats surface grid (4 KPI cards → chart rows → table rows) follows standard analytics dashboard patterns
- Chat/Agent/Routines/Settings are original Shannon designs
- No third-party branding, no tracking scripts, no MUI components

## Run
```bash
# Any static server works
npx serve .  # or: python3 -m http.server 8799
```

## Design decisions
- **Palette:** Dark-first (zinc neutrals + aqua accent) with full light mode support
- **Content:** Shannon usage data (tokens, cache %, TTFT, tok/s)
- **Charts:** Hand-rolled inline SVG (filled area/bar/line) — no chart library dependency
- **Layout:** 260px sidebar + 280px thread list + analytics grid for Stats
- **Shell:** Shannon AppShell (chat/agent/routines/stats/settings nav)
- **Theme:** Dark/light/system with no FOUC, cross-tab sync, chart re-render on themechange

## Score
- Source evidence: 4/5 (standard analytics patterns + CSS extraction)
- Structure fidelity: 4/5 (grid + 260px sidebar + card pattern)
- Visual fidelity: 4/5 (dark + light themes, hand-rolled SVG charts)
- Interaction: 4/5 (range tabs, model menu, forks, mode selector, cron builder, settings persistence, theme switching)
- Responsive: 4/5 (1024/768 breakpoints, mobile drawer/cards)
- Feature completeness: 5/5 (all 5 surfaces with working interactions)
- Content replacement: 5/5 (fully Shannon-branded)
- Legal/deploy: 5/5 (no third-party branding; Public Sans OFL; no tracking)
- Overall: 4.3/5

## Token compliance
- Color literals: 11 hexes only (zinc 6 + aqua 2 + danger + success + white) — verified programmatically
- Radii: {6,10,16,9999}px — verified
- Font: Public Sans self-hosted (400/500/600) + system fallback
- All `#fff` replaced with `var(--on-accent)`
- Code blocks use `var(--code-bg)` (subtle gray in light mode)

## Files
```
index.html              — Launcher/overview
shannon-chat.html       — Chat (model selector, forks, context panel, attachments, streaming sim)
shannon-agent.html      — Agent console (tool calls, mode selector, permission bar, inspector)
shannon-routines.html   — Routines (cron builder, run history, localStorage persistence)
shannon-stats.html      — Stats (analytics layout, SVG charts, range tabs, theme-aware re-render)
shannon.css             — Shared tokens + shell + components (+ light/dark theme blocks)
shannon-shared.js       — Settings modal, model modal v2, smart routing, location badges
assets/theme-init.js    — Blocking theme bootstrap (system resolution, no FOUC, cross-tab sync)
assets/fonts/           — Public Sans woff2 (400/500/600) + fonts.css
docs/design-system.md   — Design system documentation
AGENTS.md               — Agent instructions for working on the Shannon UI
NOTES.md                — This file
```

## Verification
- [x] All 6 pages serve HTTP 200
- [x] All color literals within locked 11-hex set
- [x] All radii within {6,10,16,9999}px
- [x] Public Sans self-hosted (3 woff2 files + @font-face)
- [x] No tracking scripts (no GA, Clarity, gtag)
- [x] No third-party branding in output
- [x] Theme switching works (light/dark/system) — Playwright-verified
- [x] Charts re-render on themechange — 15 SVGs before and after
- [x] Zero console errors on all 5 pages — Playwright-verified

## Known gaps
- Model names are placeholders (TODO user: supply real model_registry roster)
- Charts are hand-rolled SVG (no chart library) — filled encodings, not empty outlines
- Agent console uses fixture playback (no real streaming)
