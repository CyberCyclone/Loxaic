import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConversations,
  getHealth,
  isUnreachableError,
  setAuthToken,
  setReachabilityObserver,
  ServerUnreachableError,
  type ReachabilityEvent,
} from '@loxaic/api-client';

/**
 * What every request tells the connection monitor (api-client's serverFetch).
 * Evidence, not a verdict — but the classification is what the monitor's
 * decisions rest on, so it is pinned here.
 */
describe('what a request reports about the server', () => {
  let events: ReachabilityEvent[];

  beforeEach(() => {
    // Without a token the client first asks /api/auth/token for one — a
    // second request, and a second event, in every case below.
    setAuthToken('test-token');
    events = [];
    setReachabilityObserver((e) => { events.push(e); });
  });
  afterEach(() => {
    setReachabilityObserver(null);
    setAuthToken(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const respond = (status: number) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status }))));
  };

  it.each([200, 404, 500])('%i: the server answered', async (status) => {
    respond(status);
    await getConversations().catch(() => undefined);
    expect(events).toEqual([{ kind: 'answered', status }]);
  });

  it.each([502, 503, 504])('%i: suspect — what a proxy answers for a server that is gone', async (status) => {
    respond(status);
    await getConversations().catch(() => undefined);
    expect(events).toEqual([{ kind: 'suspect', status }]);
  });

  it('no response: suspect, and an error callers can recognise', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const err = await getConversations().catch((e: unknown) => e);
    expect(events).toEqual([{ kind: 'suspect' }]);
    expect(err).toBeInstanceOf(ServerUnreachableError);
    expect(isUnreachableError(err)).toBe(true);
    // login.tsx still recognises it by its message.
    expect((err as Error).message).toBe('Failed to fetch');
  });

  it('a server that said no is not unreachable', async () => {
    respond(404);
    const err = await getConversations().catch((e: unknown) => e);
    expect(isUnreachableError(err)).toBe(false);
  });

  it('an aborted request says nothing', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abort)));
    await getConversations().catch(() => undefined);
    expect(events).toEqual([]);
  });

  it('reports a stall without giving up on the request', async () => {
    vi.useFakeTimers();
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const pending = getConversations();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([{ kind: 'stalled' }]);
    resolve(new Response('[]', { status: 200 }));
    await expect(pending).resolves.toEqual([]);
    expect(events).toEqual([{ kind: 'stalled' }, { kind: 'answered', status: 200 }]);
  });

  it('the health probe never counts as its own evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await getHealth().catch(() => undefined);
    expect(events).toEqual([]);
  });
});
