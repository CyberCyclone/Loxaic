import { useSyncExternalStore } from 'react';

/**
 * Whether the app can currently reach its server.
 *
 * There was no such thing before: the chat and agent sockets each lived inside
 * a `useEffect` closure, so nothing outside those hooks could know the
 * connection had dropped. A reconnect loop ran forever, silently, while the
 * UI carried on looking live — and a send during that window painted an
 * optimistic bubble and then dropped the message, because every caller
 * ignored `trySend`'s `false` return.
 *
 * Deliberately not a network-reachability check. "Can we reach *this server*"
 * is the question that matters for a self-hosted app: a phone with perfect
 * signal and a host that is switched off is offline for our purposes, and
 * NetInfo would cheerfully report otherwise.
 */
export type ConnectionState =
  /** A socket is open, or the session bootstrap reached the server. */
  | 'online'
  /** The server didn't answer. Cached content is shown read-only. */
  | 'offline'
  /** Reconnecting after a drop — distinct from `offline` so the banner can
   * say "reconnecting" rather than flapping between two states on every
   * retry. */
  | 'reconnecting';

let state: ConnectionState = 'online';
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setConnectionState(next: ConnectionState): void {
  if (state === next) return;
  state = next;
  emit();
}

export function connectionState(): ConnectionState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnection(): ConnectionState {
  return useSyncExternalStore(subscribe, connectionState, connectionState);
}

/** True when a send would be dropped rather than delivered. */
export function isOffline(): boolean {
  return state !== 'online';
}

/** Test seam: module state outlives a single test otherwise. */
export function __resetConnectionForTest(): void {
  state = 'online';
  listeners.clear();
}
