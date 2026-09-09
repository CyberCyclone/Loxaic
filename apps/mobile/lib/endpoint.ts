import { Platform } from 'react-native';
import { setApiBaseUrl } from '@loxaic/api-client';
import { getItem } from './storage';

/**
 * Endpoint resolution for native apps (Expo / Electron shell).
 *
 * Candidates, in order of preference:
 *   1. Settings override (`loxaic-endpoint`) — always wins, no probing.
 *   2. Electron bridge (`window.loxaic.apiBaseUrl`) — see below.
 *   3. LAN URL (EXPO_PUBLIC_LAN_API_URL) — fastest when at home.
 *   4. Public/tailnet URL (EXPO_PUBLIC_API_URL) — works anywhere on the tailnet.
 *   5. Platform dev default (localhost / 10.0.2.2).
 *
 * Candidates 3-4 are probed in parallel via GET /health with a short timeout;
 * the first responder (in preference order) wins. Web builds skip probing —
 * they are same-origin with the API (or use the Settings override).
 *
 * Electron is a special case: its renderer is `Platform.OS === 'web'` (it
 * loads the same static Expo web build), but there is no server at its
 * origin to be same-origin with — dev loads from Metro (localhost:8081, same
 * as this file's own web branch already handles) and prod loads from a
 * bundled app:// scheme. Electron's main process resolves the real API URL
 * itself (it can probe LAN/tailnet candidates and start the embedded
 * Tailscale sidecar — see apps/desktop/src/main.js) and hands it to this
 * renderer via a contextBridge global, since a static bundle has no other
 * way to learn it.
 */

/** Everything the desktop main process can be asked to do, plus the launch
 * URL. See apps/desktop/src/preload.cjs — absent on every other platform. */
export interface InstanceState {
  mode: 'solo' | 'host' | 'client' | null;
  apiBaseUrl: string | null;
  needsOnboarding: boolean;
  defaultHostName: string;
  defaultPort: number;
  lanAddress: string | null;
  /** This machine's executor id — the same id it registers under, so the
   * chooser can tell "this machine" from the user's others. */
  instanceId: string;
  error?: string;
}

/** The local executor as the main process reports it. `roots` is the list
 * the user chose in the native folder dialog; `unavailable` means the
 * install has no executor payload (a dev launch without build:server). */
export interface ExecutorState {
  state: 'starting' | 'online' | 'connecting' | 'offline' | 'unauthorized' | 'unavailable';
  reason: string | null;
  executorId: string;
  name: string;
  roots: string[];
}

export interface LoxaicBridge {
  platform: 'electron';
  apiBaseUrl: string | null;
  executor: {
    setSession: (token: string | null) => Promise<ExecutorState>;
    getState: () => Promise<ExecutorState>;
    /** Opens the OS folder dialog. Resolves with the chosen folder (now a
     * root), or `canceled`. Takes no path — that is the whole point. */
    pickDirectory: () => Promise<{ path: string; roots: string[] } | { canceled: true }>;
    removeRoot: (dir: string) => Promise<ExecutorState>;
    onState: (cb: (state: ExecutorState) => void) => () => void;
  };
  instance: {
    getState: () => Promise<InstanceState>;
    setMode: (config: unknown) => Promise<InstanceState>;
    probeEngine: () => Promise<{ ok: boolean; engine?: string; reason?: string }>;
    probeHost: (url: string) => Promise<{
      ok: boolean;
      url?: string;
      reason?: string;
      cluster?: { id: string; name: string };
      hosts?: { id: string; name: string; online: boolean }[];
    }>;
    testDb: (input: { url: string; password?: string }) => Promise<{ ok: boolean; url?: string; reason?: string }>;
    detach: () => Promise<InstanceState>;
    onStackState: (cb: (state: InstanceState) => void) => () => void;
  };
}

type ElectronWindow = Window & { loxaic?: LoxaicBridge };

/** The desktop bridge, or null on web/native. */
export function electronBridge(): LoxaicBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as ElectronWindow).loxaic ?? null;
}

const PROBE_TIMEOUT_MS = 1500;

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let resolved: string | null = null;

/**
 * Resolve the best API endpoint and configure the api-client with it.
 * Cached for the session; call `resolveEndpoint(true)` to force a re-probe
 * (e.g. after a connection failure).
 */
export async function resolveEndpoint(force = false): Promise<string> {
  if (resolved && !force) return resolved;

  const override = getItem('loxaic-endpoint');
  if (override) {
    resolved = override;
    setApiBaseUrl(override);
    return override;
  }

  const electronUrl = typeof window !== 'undefined' ? (window as ElectronWindow).loxaic?.apiBaseUrl : null;
  if (electronUrl) {
    resolved = electronUrl;
    setApiBaseUrl(electronUrl);
    return electronUrl;
  }

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // Metro dev server → API on the same host, default port; otherwise
    // same-origin. Using window.location.hostname (not a hardcoded
    // "localhost") matters as soon as Metro itself is reached remotely —
    // e.g. a browser opening http://<tailscale-ip>:8081 needs the API at
    // that same tailscale-ip:4000, not at its own machine's localhost.
    const url =
      window.location.port === '8081'
        ? `${window.location.protocol}//${window.location.hostname}:4000`
        : window.location.origin;
    resolved = url;
    setApiBaseUrl(url);
    return url;
  }

  const lan = process.env.EXPO_PUBLIC_LAN_API_URL;
  const remote = process.env.EXPO_PUBLIC_API_URL;
  const fallback =
    Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';

  const candidates = [lan, remote].filter((u): u is string => !!u);
  if (candidates.length > 0) {
    const results = await Promise.all(candidates.map(probe));
    const winner = candidates.find((_, i) => results[i]);
    if (winner) {
      resolved = winner;
      setApiBaseUrl(winner);
      return winner;
    }
    // Nothing reachable right now — prefer the remote URL (most likely to
    // start working once the tailnet reconnects) and let callers re-probe.
    const best = remote ?? candidates[0];
    resolved = best;
    setApiBaseUrl(best);
    return best;
  }

  resolved = fallback;
  setApiBaseUrl(fallback);
  return fallback;
}

/** Currently resolved endpoint, if resolution has run. */
export function currentEndpoint(): string | null {
  return resolved;
}

type EndpointListener = (url: string | null) => void;
const listeners = new Set<EndpointListener>();

/**
 * Point the app at `url` now, and tell everything holding a socket.
 *
 * This is the seam that makes an endpoint change take effect without an app
 * restart. Writing storage alone was never enough: the api-client keeps its
 * own base URL and the chat/agent sockets are opened from a URL captured when
 * their effect last ran, so both have to be told.
 *
 * `null` clears the resolution — the caller has removed the override and the
 * next `resolveEndpoint()` should start over.
 */
export function setEndpoint(url: string | null): void {
  resolved = url;
  if (url) setApiBaseUrl(url);
  for (const listener of listeners) listener(url);
}

/** Subscribe to endpoint changes. Returns an unsubscribe function. */
export function onEndpointChange(listener: EndpointListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Keeps the renderer following the desktop main process. A mode switch or a
 * detach changes where the API lives, and the app must follow it in place —
 * the alternative is telling the user to restart, for a change they made
 * inside the app.
 *
 * No-op off Electron.
 */
export function subscribeToDesktopEndpoint(): () => void {
  const bridge = electronBridge();
  if (!bridge) return () => undefined;
  return bridge.instance.onStackState((state) => {
    // A Settings override outranks the bridge (it always has), so a user who
    // pinned an endpoint keeps it across a mode change they didn't make.
    if (getItem('loxaic-endpoint')) return;
    setEndpoint(state.apiBaseUrl);
  });
}
