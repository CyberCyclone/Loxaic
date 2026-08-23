import { Platform } from 'react-native';
import { setApiBaseUrl } from '@shannon/api-client';
import { getItem } from './storage';

/**
 * Endpoint resolution for native apps (Expo / Electron shell).
 *
 * Candidates, in order of preference:
 *   1. Settings override (`shannon-endpoint`) — always wins, no probing.
 *   2. Electron bridge (`window.shannon.apiBaseUrl`) — see below.
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

/** The bridge apps/desktop/src/preload.cjs exposes; absent on every other platform. */
type ElectronWindow = Window & { shannon?: { platform: 'electron'; apiBaseUrl: string | null } };

const PROBE_TIMEOUT_MS = 1500;

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
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

  const override = getItem('shannon-endpoint');
  if (override) {
    resolved = override;
    setApiBaseUrl(override);
    return override;
  }

  const electronUrl = typeof window !== 'undefined' ? (window as ElectronWindow).shannon?.apiBaseUrl : null;
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
    const best = remote || candidates[0];
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
