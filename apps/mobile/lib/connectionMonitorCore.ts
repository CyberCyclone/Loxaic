import type { ConnectionState } from './connection';

/**
 * Whether the app can reach its server — one answer for the whole app.
 *
 * It used to be written by whichever screen happened to be open: the chat and
 * agent socket hooks each set it, and expo-router's Slot mounts only the
 * focused screen, so the answer went stale the moment someone navigated to a
 * screen with no socket (every settings page), and read "online" on the agent
 * screen while its socket was still connecting. Nothing ever asked the server
 * itself, so a hung one (accepting connections, answering nothing) was never
 * noticed at all.
 *
 * Now there are three kinds of evidence and one authority:
 * - every REST request reports what it learned (api-client's serverFetch);
 * - each screen's socket reports connecting / open / closed;
 * - a `GET /health` probe, which is the only thing that can call the server
 *   down. A failed request is only a reason to probe: our own server answers
 *   502 when GitHub is down, and a rejected upload can be a file that failed
 *   to encode.
 *
 * This is the pure core, so every rule below is a unit test; the controller
 * (lib/connectionMonitor.ts) only owns timers, AppState and the probe.
 */

export type SocketStatus = 'connecting' | 'open' | 'closed';

/** A resume replaces the sockets on purpose; a healthy reconnect fits well
 * inside this, so an ordinary app switch shows nothing. */
export const RESUME_GRACE_MS = 300;
/** A socket a screen has just opened. Longer than a resume's: a first
 * connect over a tailnet relay routinely takes more than 300 ms, and a banner
 * on every navigation would teach people to ignore it. */
export const CONNECT_GRACE_MS = 1_500;
/** A socket still connecting after this long is worth a probe: a stopped
 * server completes the TCP handshake from its backlog and then says nothing,
 * so no failure event ever arrives. */
export const STUCK_CONNECTING_MS = 3_000;
/** Each probe gives up after this long. Not the endpoint picker's 1.5 s: a
 * tailnet relay can take longer than that to answer a healthy server. */
export const PROBE_TIMEOUT_MS = 4_000;
/** While online and in the foreground: the one thing that notices a server
 * that went quiet without closing anything. */
export const HEARTBEAT_MS = 25_000;
/** A socket tracked again this soon after being let go of is the same one
 * being replaced, not a new screen's. */
export const REPLACED_WITHIN_MS = 50;
/** Failed probes in a row before "reconnecting" becomes "can't reach". */
export const OFFLINE_AFTER_FAILURES = 3;

/** 1, 2, 4, 8 s, then every 10 s. */
export function backoffMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), 10_000);
}

export interface MonitorState {
  running: boolean;
  foreground: boolean;
  server: 'unknown' | 'ok' | 'failing';
  failedProbes: number;
  sockets: Record<string, { status: SocketStatus; since: number }>;
  /** Until when a not-yet-online state says nothing (a grace period). */
  silentUntil: number;
  /** Bumped on every resume and reset. A probe or timer armed before one
   * belongs to a world that no longer exists: iOS freezes JS in the
   * background, so a probe's timeout fires the instant the app returns and
   * would read as a failure. */
  epoch: number;
  probeInFlight: boolean;
  /** The socket a screen let go of last, so one replaced in the same moment
   * (an effect re-running: cleanup, then the body) carries on where it was
   * instead of starting a fresh grace period mid-reconnect. */
  released: { key: string; status: SocketStatus; since: number; at: number } | null;
}

export type MonitorEvent =
  | { type: 'start' }
  | { type: 'stop' }
  /** What a REST request learned (api-client's ReachabilityEvent). */
  | { type: 'answered' }
  | { type: 'suspect' }
  | { type: 'stalled' }
  | { type: 'probeResult'; ok: boolean; epoch: number }
  | { type: 'probeDue'; epoch: number }
  | { type: 'tick' }
  | { type: 'socket'; key: string; status: SocketStatus; code?: number }
  | { type: 'untrack'; key: string }
  | { type: 'resume' }
  | { type: 'background' }
  | { type: 'retry' }
  | { type: 'reset' };

export type MonitorEffect =
  | { type: 'probe'; epoch: number }
  | { type: 'probeIn'; ms: number; epoch: number }
  | { type: 'tickIn'; ms: number }
  | { type: 'reconnectSockets' }
  | { type: 'checkSession' };

/**
 * What an AppState change means to the monitor. Only a return from
 * `background` is a resume. `inactive` suspends nothing — Control Center, a
 * call banner — and iOS passes through it on the way into and out of the
 * background anyway; locking the phone even flips `inactive → active →
 * inactive → background` within a second and a half, and treating that
 * instant of `active` as a return replaced every socket as the app went to
 * sleep. Measured on the simulator.
 */
export function appStateEvent(
  backgrounded: boolean,
  next: string,
): { event: 'background' | 'resume' | null; backgrounded: boolean } {
  if (next === 'background') return { event: backgrounded ? null : 'background', backgrounded: true };
  if (next === 'active') return { event: backgrounded ? 'resume' : null, backgrounded: false };
  return { event: null, backgrounded };
}

export function initialMonitorState(): MonitorState {
  return {
    running: false,
    foreground: true,
    server: 'unknown',
    failedProbes: 0,
    sockets: {},
    silentUntil: 0,
    epoch: 0,
    probeInFlight: false,
    released: null,
  };
}

/** A socket closed with this was refused for its session (ws/chat.ts,
 * ws/agent.ts): the server is fine, the sign-in is not. */
const CLOSE_UNAUTHORIZED = 4001;

export function reduce(
  prev: MonitorState,
  event: MonitorEvent,
  now: number,
): { state: MonitorState; effects: MonitorEffect[] } {
  const state: MonitorState = { ...prev, sockets: { ...prev.sockets } };
  const effects: MonitorEffect[] = [];

  const probe = () => {
    if (!state.running || !state.foreground || state.probeInFlight) return;
    state.probeInFlight = true;
    effects.push({ type: 'probe', epoch: state.epoch });
  };
  const serverAnswered = () => {
    state.server = 'ok';
    state.failedProbes = 0;
  };
  const hold = (ms: number) => {
    state.silentUntil = Math.max(state.silentUntil, now + ms);
    effects.push({ type: 'tickIn', ms });
  };

  switch (event.type) {
    case 'start':
      state.running = true;
      state.foreground = true;
      hold(CONNECT_GRACE_MS);
      probe();
      break;

    case 'stop':
      return { state: { ...initialMonitorState(), epoch: prev.epoch + 1 }, effects: [] };

    case 'answered':
      serverAnswered();
      break;

    case 'suspect':
    case 'stalled':
      probe();
      break;

    case 'probeResult':
      if (event.epoch !== state.epoch) break;
      state.probeInFlight = false;
      if (event.ok) {
        serverAnswered();
        // A socket closed and waiting out its hook's backoff can try now. Never
        // one still connecting: replacing it restarts the connect, and on a
        // relay slower than STUCK_CONNECTING_MS the stuck-socket probe then
        // succeeded, replaced it again, and it could never finish.
        if (Object.values(state.sockets).some((s) => s.status === 'closed')) {
          effects.push({ type: 'reconnectSockets' });
        }
        if (state.foreground) effects.push({ type: 'probeIn', ms: HEARTBEAT_MS, epoch: state.epoch });
      } else {
        state.server = 'failing';
        state.failedProbes += 1;
        // A socket that says "open" through a failed probe is a dead one
        // (Chrome's offline mode and a stopped server both leave it open), so
        // it is replaced rather than believed.
        if (Object.values(state.sockets).some((s) => s.status === 'open')) {
          effects.push({ type: 'reconnectSockets' });
        }
        if (state.foreground) {
          effects.push({ type: 'probeIn', ms: backoffMs(state.failedProbes), epoch: state.epoch });
        }
      }
      break;

    case 'probeDue':
      if (event.epoch !== state.epoch) break;
      probe();
      break;

    case 'tick':
      // Re-derives the state (a grace period may have ended) and looks for a
      // socket stuck connecting against a server that answers nothing.
      if (Object.values(state.sockets).some((s) => s.status === 'connecting' && now - s.since >= STUCK_CONNECTING_MS)) {
        probe();
      }
      break;

    case 'socket': {
      // An index into a Record reads as always present; this one may not be.
      const current = state.sockets[event.key] as MonitorState['sockets'][string] | undefined;
      const { released } = state;
      const carried =
        !current && released?.key === event.key && now - released.at <= REPLACED_WITHIN_MS ? released : null;
      const previous = current ?? carried;
      const before = previous?.status;
      // Still the same attempt to connect: keep when it began, or a socket
      // replaced while stuck would never be noticed as stuck.
      const since = event.status === 'connecting' && before === 'connecting' && previous ? previous.since : now;
      state.sockets[event.key] = { status: event.status, since };
      if (event.status === 'open') {
        serverAnswered();
      } else if (event.status === 'connecting') {
        if (before !== 'connecting') {
          hold(CONNECT_GRACE_MS);
          effects.push({ type: 'tickIn', ms: STUCK_CONNECTING_MS });
        }
      } else if (event.code === CLOSE_UNAUTHORIZED) {
        effects.push({ type: 'checkSession' });
      } else {
        probe();
      }
      break;
    }

    case 'untrack': {
      const { [event.key]: gone, ...rest } = state.sockets as Partial<MonitorState['sockets']>;
      if (gone) state.released = { key: event.key, ...gone, at: now };
      state.sockets = rest as MonitorState['sockets'];
      break;
    }

    case 'resume':
      state.epoch += 1;
      state.foreground = true;
      state.probeInFlight = false;
      if (Object.keys(state.sockets).length > 0) {
        // Every socket is about to be replaced, so none of them counts as open
        // until its replacement is.
        for (const key of Object.keys(state.sockets)) state.sockets[key] = { status: 'connecting', since: now };
        hold(RESUME_GRACE_MS);
        effects.push({ type: 'reconnectSockets' });
        // The replacements report "connecting" into sockets already marked so,
        // which schedules no check of their own: without this, one hanging
        // after the resume probe answered waited for the heartbeat.
        effects.push({ type: 'tickIn', ms: STUCK_CONNECTING_MS });
      }
      // With no socket this only probes, and the state stays as it was: a
      // settings screen must not grey out on every app switch.
      probe();
      break;

    case 'background':
      state.foreground = false;
      break;

    case 'retry':
      probe();
      effects.push({ type: 'reconnectSockets' });
      break;

    case 'reset':
      // A different server, or a different person: nothing learned about the
      // old one applies.
      state.epoch += 1;
      state.server = 'unknown';
      state.failedProbes = 0;
      state.probeInFlight = false;
      hold(CONNECT_GRACE_MS);
      probe();
      break;
  }
  return { state, effects };
}

export function derive(state: MonitorState, now: number): ConnectionState {
  // Outside the signed-in shell nothing is gated on this.
  if (!state.running) return 'online';
  if (state.failedProbes >= OFFLINE_AFTER_FAILURES) return 'offline';
  const sockets = Object.values(state.sockets);
  if (state.server === 'ok' && sockets.every((s) => s.status === 'open')) return 'online';
  // Evidence ends a grace period early: a failed probe, or a socket that
  // closed and has not been replaced yet.
  if (state.server === 'failing' || sockets.some((s) => s.status === 'closed')) return 'reconnecting';
  if (now < state.silentUntil) return 'resuming';
  return 'reconnecting';
}
