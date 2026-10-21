/**
 * Taking the server away from inside the page, on web and Electron.
 *
 * The web lane's server also serves the page, so stopping it would take the
 * app with it: requests to the API fail as a network error would, and sockets
 * are pointed at a port nothing listens on. Native lanes freeze the real
 * process instead (helpers/server.ts). Always `restoreServer()` in an
 * `afterEach`.
 */
import { browser } from '@wdio/globals';

/** Every request to the API fails as a dead network would, and every socket
 * goes to a port with nothing on it. */
export async function cutServer(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __realFetch?: typeof fetch;
      __RealWebSocket?: typeof WebSocket;
    };
    w.__realFetch ??= window.fetch.bind(window);
    w.__RealWebSocket ??= window.WebSocket;
    const realFetch = w.__realFetch;
    const RealWebSocket = w.__RealWebSocket;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (/^\/(v1|api|health)(\/|$)/.test(path)) return Promise.reject(new TypeError('Failed to fetch'));
      return realFetch(input, init);
    };
    class DeadSocket extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(String(url).includes('/ws/') ? 'ws://127.0.0.1:9/' : url, protocols);
      }
    }
    window.WebSocket = DeadSocket;
    // Replace the socket that is open now, as a return to the app does.
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

export async function restoreServer(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __realFetch?: typeof fetch; __RealWebSocket?: typeof WebSocket };
    if (w.__realFetch) window.fetch = w.__realFetch;
    if (w.__RealWebSocket) window.WebSocket = w.__RealWebSocket;
  });
}

/** Requests to one API route fail as a dead network would; everything else,
 * the health probe included, still answers. A single screen's load failing
 * while the server is otherwise fine. Undone by `restoreServer()`. */
export async function failRequestsTo(pathPrefix: string): Promise<void> {
  await browser.execute((prefix: string) => {
    const w = window as unknown as { __realFetch?: typeof fetch };
    w.__realFetch ??= window.fetch.bind(window);
    const realFetch = w.__realFetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname.startsWith(prefix)) return Promise.reject(new TypeError('Failed to fetch'));
      return realFetch(input, init);
    };
  }, pathPrefix);
}
