import { AppState } from 'react-native';
import { getHealth, setReachabilityObserver } from '@loxaic/api-client';
import { publishConnectionState } from './connection';
import {
  PROBE_TIMEOUT_MS,
  appStateEvent,
  derive,
  initialMonitorState,
  reduce,
  type MonitorEffect,
  type MonitorEvent,
  type SocketStatus,
} from './connectionMonitorCore';
import { electronBridge, onEndpointChange } from './endpoint';

/**
 * The connection monitor's controller: timers, AppState, the health probe, and
 * the API the rest of the app uses. What it decides, and why, is the pure core
 * in lib/connectionMonitorCore.ts.
 */

export type { SocketStatus } from './connectionMonitorCore';


let state = initialMonitorState();
let probeTimer: ReturnType<typeof setTimeout> | null = null;
const tickTimers = new Set<ReturnType<typeof setTimeout>>();
const reconnectListeners = new Set<() => void>();
const recoveredListeners = new Set<() => void>();
let sessionCheck: (() => void) | null = null;
let teardown: (() => void) | null = null;

function publish(): void {
  publishConnectionState(derive(state, Date.now()));
}

function dispatch(event: MonitorEvent): void {
  const result = reduce(state, event, Date.now());
  state = result.state;
  publish();
  for (const effect of result.effects) run(effect);
}

function run(effect: MonitorEffect): void {
  switch (effect.type) {
    case 'probe': {
      const controller = new AbortController();
      const timeout = setTimeout(() => { controller.abort(); }, PROBE_TIMEOUT_MS);
      getHealth({ signal: controller.signal })
        .then(
          () => { dispatch({ type: 'probeResult', ok: true, epoch: effect.epoch }); },
          () => { dispatch({ type: 'probeResult', ok: false, epoch: effect.epoch }); },
        )
        .finally(() => { clearTimeout(timeout); });
      break;
    }
    case 'probeIn':
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = setTimeout(() => {
        probeTimer = null;
        dispatch({ type: 'probeDue', epoch: effect.epoch });
      }, effect.ms);
      break;
    case 'tickIn': {
      const timer = setTimeout(() => {
        tickTimers.delete(timer);
        dispatch({ type: 'tick' });
      }, effect.ms);
      tickTimers.add(timer);
      break;
    }
    case 'reconnectSockets':
      for (const listener of reconnectListeners) listener();
      break;
    case 'checkSession':
      sessionCheck?.();
      break;
    case 'recovered':
      for (const listener of recoveredListeners) listener();
      break;
  }
}

function clearTimers(): void {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  for (const timer of tickTimers) clearTimeout(timer);
  tickTimers.clear();
}

/** Called by the signed-in shell. Idempotent. */
export function startMonitor(): () => void {
  if (teardown) return stopMonitor;
  setReachabilityObserver((event) => { dispatch({ type: event.kind }); });
  let backgrounded = AppState.currentState === 'background';
  const lifecycle = (next: string) => {
    const change = appStateEvent(backgrounded, next);
    backgrounded = change.backgrounded;
    if (change.event === 'background') {
      dispatch({ type: 'background' });
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = null;
    } else if (change.event === 'resume') {
      dispatch({ type: 'resume' });
    }
  };
  const appStateSub = AppState.addEventListener('change', lifecycle);
  // The desktop's version of the same two moments: a Mac sleeping with the
  // window open changes nothing the page can see. A wake only counts while the
  // window is showing — otherwise its own return does the resume.
  const powerUnsub = electronBridge()?.power?.onChange((power) => {
    if (power === 'sleep') lifecycle('background');
    else if (AppState.currentState === 'active') lifecycle('active');
  });
  const endpointUnsub = onEndpointChange(() => { dispatch({ type: 'reset' }); });
  teardown = () => {
    appStateSub.remove();
    powerUnsub?.();
    endpointUnsub();
    setReachabilityObserver(null);
  };
  dispatch({ type: 'start' });
  return stopMonitor;
}

export function stopMonitor(): void {
  teardown?.();
  teardown = null;
  clearTimers();
  dispatch({ type: 'stop' });
}

/** A screen's socket reports itself. Module-level, not context, because a
 * screen's effect runs before the shell's that starts the monitor. */
export function trackSocket(key: string, status: SocketStatus, code?: number): void {
  dispatch({ type: 'socket', key, status, ...(code !== undefined ? { code } : {}) });
}

export function untrackSocket(key: string): void {
  dispatch({ type: 'untrack', key });
}

/** Socket hooks replace their socket now: on a resume, a Retry, a server that
 * came back (skipping their own backoff), or a failed probe against a socket
 * that still claims to be open. */
export function onReconnectRequest(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => { reconnectListeners.delete(listener); };
}

/** The server answered again after failing. */
export function onRecovered(listener: () => void): () => void {
  recoveredListeners.add(listener);
  return () => { recoveredListeners.delete(listener); };
}

/** What to do when a socket is refused for its session (close code 4001). */
export function setSessionCheck(check: (() => void) | null): void {
  sessionCheck = check;
}

export function retryNow(): void {
  dispatch({ type: 'retry' });
}

/** Test seam: module state outlives a single test otherwise. */
export function __resetMonitorForTest(): void {
  teardown?.();
  teardown = null;
  clearTimers();
  reconnectListeners.clear();
  recoveredListeners.clear();
  sessionCheck = null;
  state = initialMonitorState();
}
