// The window a packaged app shows while it starts: the Loxaic mark on the
// dark background, the same splash the iOS and Android apps show. Starting
// the embedded stack (Postgres, migrations, the server) takes seconds, and
// until it answers the real window cannot open — it needs the server's
// address when it is created — so without this the app showed nothing at all.
//
// Colours and the mark come from the Loxaic design system (`background`,
// `primary` and `foreground-muted` in dark; assets/Logos/loxaic-mark.svg),
// the same values as apps/mobile/global.css and lib/designTokens.ts.

export const SPLASH_BACKGROUND = "#13161a";
const MARK_COLOUR = "#a3e635";
const CAPTION_COLOUR = "#8d9399";
const MARK_PATH =
  "M36 59 52 45 36 31 36 39 24 39 24 25.25 18 29.54 12 25.25 12 51 36 51zM24 17.25 18 21.54 12 17.25 12 22.18 18 26.46 24 22.18zM18 11 12 5 12 14.18 18 18.46 24 14.18 24 5z";

/** The splash page as a data: URL — no file to ship, nothing to fetch. */
export function launchSplashPageUrl() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Loxaic</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:${SPLASH_BACKGROUND};-webkit-user-select:none;-webkit-app-region:drag}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
font:500 13px/18px system-ui,-apple-system,"Segoe UI",sans-serif;color:${CAPTION_COLOUR}}
svg{width:88px;height:88px}
</style></head><body data-testid="launchSplash">
<svg viewBox="0 0 64 64" role="img" aria-label="Loxaic"><path fill="${MARK_COLOUR}" d="${MARK_PATH}"/></svg>
<div>Starting Loxaic…</div>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
