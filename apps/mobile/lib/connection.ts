import { useSyncExternalStore } from 'react';

/**
 * Whether the app can currently reach its server, as decided by
 * `lib/connectionMonitor.ts` — the only writer. Everything else reads it:
 * the one banner in the shell, the sidebar's status line, and every control
 * that needs the server, on every screen.
 *
 * Deliberately not a network-reachability check. "Can we reach *this server*"
 * is the question that matters for a self-hosted app: a phone with perfect
 * signal and a host that is switched off is offline for our purposes, and
 * NetInfo would cheerfully report otherwise.
 */
export type ConnectionState =
  /** The server answered and every open screen's socket is connected. */
  | 'online'
  /** Several probes in a row got no answer. Cached content stays readable. */
  | 'offline'
  /** Not connected, and it has been long enough (or the evidence is clear
   * enough) to say so. */
  | 'reconnecting'
  /** Not connected yet, but inside a grace period: a resume replacing the
   * sockets, or a screen's socket still connecting. Input waits exactly as it
   * does for the states above, but nothing is *said*, because a healthy
   * reconnect finishes before anyone could read a banner about it. */
  | 'resuming';

let state: ConnectionState = 'online';
/** The last state that was not a grace period, for things that should not
 * flicker through one — the sidebar's status line. */
let settled: Exclude<ConnectionState, 'resuming'> = 'online';
const listeners = new Set<() => void>();

/** For the connection monitor only. */
export function publishConnectionState(next: ConnectionState): void {
  if (state === next) return;
  state = next;
  if (next !== 'resuming') settled = next;
  for (const listener of listeners) listener();
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

/** The state, holding the last settled one through a grace period. */
export function useSettledConnection(): Exclude<ConnectionState, 'resuming'> {
  return useSyncExternalStore(subscribe, () => settled, () => settled);
}

/** Whether anything that needs the server may be pressed right now. */
export function useServerReachable(): boolean {
  return useConnection() === 'online';
}

/** True when a send would be dropped rather than delivered. */
export function isOffline(): boolean {
  return state !== 'online';
}

/** Whether to *say* the connection is down: the banner, a read-only
 * composer, a note in a dialog. False during a grace period, when input is
 * blocked but nothing is shown. */
export function showsDisconnected(s: ConnectionState): boolean {
  return s === 'reconnecting' || s === 'offline';
}

/** What a press says when the socket could not carry it. It is always a
 * reconnect in progress (the hooks retry on their own), so the advice is to
 * wait, not to reload. */
export const NOT_SENT_RECONNECTING = 'Reconnecting to your server — that wasn’t sent. Try again in a moment.';

/**
 * Every sentence the app says about being disconnected, in one place, so the
 * banner, a dialog's note and a read-only composer cannot disagree — they
 * used to: the plan panel said "You're offline" while the banner beside it
 * said "Reconnecting".
 */
export function disconnectedCopy(s: ConnectionState) {
  const offline = s === 'offline';
  return {
    banner: offline
      ? "Can't reach your server. You can read what's already loaded; anything that needs the server is off until it's back."
      : 'Reconnecting to your server…',
    /** Inside a dialog or sheet, which covers the banner. */
    note: (what: string) =>
      offline
        ? `Can't reach your server — you can ${what} once it's back.`
        : `Reconnecting to your server — you can ${what} in a moment.`,
    /** In place of a composer. `thing` is "conversation" or "run". */
    readOnly: (thing: string) =>
      offline
        ? `Can't reach your server. This is your saved copy of the ${thing} — sending will work again once it's back.`
        : 'Reconnecting to your server — sending will work again in a moment.',
    /** A press that got through the disabled state and could not be sent. */
    notSent: offline
      ? 'Can’t reach your server — that wasn’t sent. It will work again once the server is back.'
      : NOT_SENT_RECONNECTING,
    /** The sidebar's status line. */
    status: offline ? "Can't reach server" : s === 'reconnecting' ? 'Reconnecting to server' : 'Server connected',
  };
}

/**
 * The guard for a handler that needs the server: false (and a toast saying
 * why) when it would only fail. The button is disabled too; this is for the
 * press that races the state change.
 */
export function requireServer(showToast: (message: string, durationMs?: number) => void): boolean {
  if (!isOffline()) return true;
  showToast(disconnectedCopy(state).notSent, 4000);
  return false;
}

/** Test seam: module state outlives a single test otherwise. */
export function __resetConnectionForTest(): void {
  state = 'online';
  settled = 'online';
  listeners.clear();
}
