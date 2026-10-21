import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny website for web_fetch's browser fallback (#281), on loopback.
 *
 * The server's address guard refuses loopback, so standup lets exactly this
 * host:port through with `LOXAIC_E2E_FETCH_ALLOW`, which the server honours
 * only with the mock backend. Every page tells a plain fetch from a browser by
 * its user agent: web_fetch's own request says `Loxaic-Agent`, the browser's
 * says `Chrome/`.
 *
 * - `/walled`: 403 to anything that is not a browser, the bot wall the
 *   fallback exists for.
 * - `/script`: a page whose text only exists once its script has run.
 * - `/set-cookie`: walled; sets a cookie and says so.
 * - `/cookie`: walled; echoes the cookie the browser sent, or "none". Read in
 *   a second conversation, it shows whether browsers are shared.
 */

export const WALLED_TEXT = 'Past the wall: this page only answers browsers.';
export const SCRIPT_TEXT = 'Drawn by script: the fallback ran this page.';

export interface MockWeb {
  url: string;
  hostPort: string;
  stop: () => Promise<void>;
}

function isBrowser(userAgent: string | undefined): boolean {
  return (userAgent ?? '').includes('Chrome/');
}

const page = (body: string, title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

export async function startMockWeb(): Promise<MockWeb> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const browser = isBrowser(req.headers['user-agent']);
    const walled = url.pathname === '/walled' || url.pathname === '/set-cookie' || url.pathname === '/cookie';
    if (walled && !browser) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end(page('<p>Access denied. Please enable JavaScript and cookies.</p>', 'Blocked'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    switch (url.pathname) {
      case '/walled':
        res.end(page(`<p id="text">${WALLED_TEXT}</p>`, 'Walled page'));
        return;
      case '/script':
        res.end(page(
          `<div id="app"></div><script>document.getElementById('app').textContent = ${JSON.stringify(SCRIPT_TEXT)};</script>`,
          'Script page',
        ));
        return;
      case '/set-cookie':
        res.setHeader('set-cookie', `loxaic_e2e=${String(Date.now())}; Path=/`);
        res.end(page('<p>The cookie is set.</p>', 'Cookie set'));
        return;
      case '/cookie': {
        const cookie = /loxaic_e2e=\d+/.exec(req.headers.cookie ?? '')?.[0];
        res.end(page(`<p>Cookie seen: ${cookie ?? 'none'}</p>`, 'Cookie echo'));
        return;
      }
      default:
        res.writeHead(404);
        res.end(page('<p>Not here.</p>', 'Not found'));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    hostPort: `127.0.0.1:${String(port)}`,
    stop: () => new Promise<void>((resolve) => server.close(() => { resolve(); })),
  };
}

/** Mock scenarios that call web_fetch on this site, by prompt. */
export function webFetchScenarios(base: string): unknown[] {
  const fetchStep = (path: string, extra: Record<string, unknown> = {}) => ({
    tool: 'web_fetch',
    args: { url: `${base}${path}`, ...extra },
  });
  return [
    { match: 'read the walled page', steps: [fetchStep('/walled')], finalText: '[Mock] Read the walled page.' },
    { match: 'read the script page', steps: [fetchStep('/script')], finalText: '[Mock] Read the script page.' },
    { match: 'screenshot the script page', steps: [fetchStep('/script', { screenshot: true })], finalText: '[Mock] Took a screenshot.' },
    { match: 'visit the cookie setter', steps: [fetchStep('/set-cookie')], finalText: '[Mock] Set the cookie.' },
    { match: 'check the cookie echo', steps: [fetchStep('/cookie')], finalText: '[Mock] Checked the cookie.' },
  ];
}
