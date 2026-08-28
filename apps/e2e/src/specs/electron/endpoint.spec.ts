/**
 * Electron-only: the endpoint-resolution path that no other platform has.
 *
 * Web, iOS and Android all derive their API base URL inside the renderer —
 * same-origin on web, a probe on native. Electron can't: the window loads from
 * `app://`, where no server exists. The main process resolves the URL and hands
 * it to the renderer through a contextBridge preload, and if that bridge breaks
 * the app doesn't fail loudly — it quietly falls back to localhost:4000 and
 * looks fine on the developer's machine while being broken for everyone whose
 * server is elsewhere. Hence an explicit test.
 */
import { browser } from '@wdio/globals';
import { BASE_URL } from '../../../scripts/standup.ts';

describe('electron endpoint resolution', () => {
  it('exposes the main process API base URL to the renderer', async () => {
    const bridge = await browser.execute(
      () => (window as unknown as { shannon?: { platform: string; apiBaseUrl: string | null } }).shannon,
    );

    expect(bridge).toBeDefined();
    expect(bridge?.platform).toBe('electron');
    // In self-contained mode (E2E_SELF_CONTAINED=1) BASE_URL is a per-run free
    // port the embedded stack was told to serve on, so this equality is strict:
    // it proves the supervisor's stack is what the renderer was handed. In
    // external-server mode it proves the EXPO_PUBLIC_API_URL probe won — though
    // on the default port 4000 it can't tell "resolved" from "dev fallback",
    // which is why the second test checks the URL is live rather than equal.
    expect(bridge?.apiBaseUrl).toBe(BASE_URL);
  });

  it('resolves to an endpoint that actually serves the API', async () => {
    // The window's own origin is the app:// scheme, with no server behind it,
    // so reaching the API at all depends entirely on the bridged URL.
    const origin = await browser.execute(() => window.location.origin);
    expect(origin).not.toContain('http://localhost');

    // Deliberately fetched through the bridge's own value rather than through
    // BASE_URL: hitting BASE_URL directly would pass even if the bridge handed
    // the renderer something useless, which is the failure this exists to catch.
    const health = await browser.execute(async () => {
      const url = (window as unknown as { shannon?: { apiBaseUrl: string | null } }).shannon
        ?.apiBaseUrl;
      if (!url) return null;
      const res = await fetch(`${url}/health`);
      return (await res.json()) as { services: { inference: string } };
    });

    expect(health).not.toBeNull();
    expect(health?.services.inference).toBe('mock');
  });
});
