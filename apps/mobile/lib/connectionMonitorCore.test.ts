import { describe, expect, it } from 'vitest';
import {
  CONNECT_GRACE_MS,
  HEARTBEAT_MS,
  OFFLINE_AFTER_FAILURES,
  RESUME_GRACE_MS,
  STUCK_CONNECTING_MS,
  backoffMs,
  derive,
  initialMonitorState,
  reduce,
  type MonitorEffect,
  type MonitorEvent,
  type MonitorState,
} from './connectionMonitorCore';

/** Feeds events through the reducer, keeping every effect. */
function run(events: [MonitorEvent, number][], from: MonitorState = initialMonitorState()) {
  let state = from;
  const effects: MonitorEffect[] = [];
  for (const [event, now] of events) {
    const r = reduce(state, event, now);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const probes = (effects: MonitorEffect[]) => effects.filter((e) => e.type === 'probe');

/** A running monitor that has heard from the server. */
function online(now = 0): MonitorState {
  return run([[{ type: 'start' }, now], [{ type: 'probeResult', ok: true, epoch: 0 }, now]]).state;
}

/** A failed probe at the current epoch, as the controller would report it. */
const fail = (s: MonitorState, now: number) => run([[{ type: 'probeResult', ok: false, epoch: s.epoch }, now]], s);

describe('the connection monitor', () => {
  it('says nothing outside the signed-in shell', () => {
    expect(derive(initialMonitorState(), 0)).toBe('online');
  });

  it('starts silent and probes, then is online once the server answers', () => {
    const started = run([[{ type: 'start' }, 0]]);
    expect(probes(started.effects)).toHaveLength(1);
    expect(derive(started.state, 0)).toBe('resuming');
    expect(derive(online(), 0)).toBe('online');
  });

  it('treats any REST answer as the server being there', () => {
    const s = run([[{ type: 'start' }, 0], [{ type: 'answered' }, 10]]).state;
    expect(derive(s, 10)).toBe('online');
  });

  it('holds a newly connecting socket silent, then says so if it never opens', () => {
    const s = run([[{ type: 'socket', key: 'agent', status: 'connecting' }, 100]], online()).state;
    expect(derive(s, 100)).toBe('resuming');
    expect(derive(s, 100 + CONNECT_GRACE_MS - 1)).toBe('resuming');
    expect(derive(s, 100 + CONNECT_GRACE_MS)).toBe('reconnecting');
  });

  it('is online the moment the socket opens inside its grace period', () => {
    const s = run(
      [[{ type: 'socket', key: 'agent', status: 'connecting' }, 0], [{ type: 'socket', key: 'agent', status: 'open' }, 200]],
      online(),
    ).state;
    expect(derive(s, 200)).toBe('online');
  });

  it('is not online while one socket is open and another is still connecting (the Chat → Agent race)', () => {
    const s = run(
      [
        [{ type: 'socket', key: 'chat', status: 'open' }, 0],
        [{ type: 'socket', key: 'agent', status: 'connecting' }, 0],
      ],
      online(),
    ).state;
    expect(derive(s, 0)).not.toBe('online');
  });

  it('forgets a socket whose screen unmounted (the Chat → Settings staleness)', () => {
    const s = run(
      [[{ type: 'socket', key: 'chat', status: 'closed' }, 0], [{ type: 'untrack', key: 'chat' }, 10]],
      online(),
    ).state;
    expect(derive(s, 10)).toBe('online');
  });

  it('ends the grace early, and probes, when a socket closes without opening', () => {
    const r = run(
      [[{ type: 'socket', key: 'chat', status: 'connecting' }, 0], [{ type: 'socket', key: 'chat', status: 'closed' }, 50]],
      online(),
    );
    expect(derive(r.state, 50)).toBe('reconnecting');
    expect(probes(r.effects)).toHaveLength(1);
  });

  it('probes a socket stuck connecting against a server that answers nothing', () => {
    const s = run([[{ type: 'socket', key: 'chat', status: 'connecting' }, 0]], online()).state;
    expect(probes(run([[{ type: 'tick' }, STUCK_CONNECTING_MS - 1]], s).effects)).toHaveLength(0);
    expect(probes(run([[{ type: 'tick' }, STUCK_CONNECTING_MS]], s).effects)).toHaveLength(1);
  });

  it('does not start a fresh grace for a socket replaced mid-reconnect', () => {
    // Already reconnecting, then the hook's effect re-runs: cleanup lets the
    // socket go and the body tracks a new one in the same moment. That used
    // to buy another silent 1.5 s, and the banner vanished while nothing had
    // connected.
    const s = run([[{ type: 'socket', key: 'chat', status: 'connecting' }, 0]], online()).state;
    expect(derive(s, CONNECT_GRACE_MS + 100)).toBe('reconnecting');
    const replaced = run(
      [
        [{ type: 'untrack', key: 'chat' }, CONNECT_GRACE_MS + 100],
        [{ type: 'socket', key: 'chat', status: 'connecting' }, CONNECT_GRACE_MS + 101],
      ],
      s,
    ).state;
    expect(derive(replaced, CONNECT_GRACE_MS + 101)).toBe('reconnecting');
    expect(replaced.sockets.chat.since).toBe(0);
  });

  it('checks the session, not the server, when a socket is refused for it', () => {
    const r = run([[{ type: 'socket', key: 'chat', status: 'closed', code: 4001 }, 0]], online());
    expect(r.effects).toContainEqual({ type: 'checkSession' });
    expect(probes(r.effects)).toHaveLength(0);
    expect(r.state.server).toBe('ok');
  });

  describe('a resume', () => {
    it('with sockets: silent for the resume grace, then reconnecting unless they reopen', () => {
      const withSocket = run([[{ type: 'socket', key: 'chat', status: 'open' }, 0]], online()).state;
      // Well after start-up, whose own grace would otherwise still be running.
      const at = 60_000;
      const r = run([[{ type: 'resume' }, at]], withSocket);
      expect(r.effects).toContainEqual({ type: 'reconnectSockets' });
      expect(probes(r.effects)).toHaveLength(1);
      expect(r.state.epoch).toBe(withSocket.epoch + 1);
      expect(derive(r.state, at)).toBe('resuming');
      expect(derive(r.state, at + RESUME_GRACE_MS)).toBe('reconnecting');

      const reopened = run([[{ type: 'socket', key: 'chat', status: 'open' }, at + 100]], r.state).state;
      expect(derive(reopened, at + 100)).toBe('online');
    });

    it('with no socket: stays online and only probes, so a settings screen does not grey out', () => {
      const r = run([[{ type: 'resume' }, 1_000]], online());
      expect(derive(r.state, 1_000)).toBe('online');
      expect(probes(r.effects)).toHaveLength(1);
      expect(r.effects).not.toContainEqual({ type: 'reconnectSockets' });
    });

    it('ignores a probe that was armed before it', () => {
      const before = online();
      const resumed = run([[{ type: 'resume' }, 1_000]], before).state;
      const stale = run([[{ type: 'probeResult', ok: false, epoch: before.epoch }, 1_001]], resumed).state;
      expect(stale.failedProbes).toBe(0);
      expect(stale.server).toBe('ok');
    });
  });

  describe('suspicion and probes', () => {
    it('does not change the state on a failed request alone, only probes once', () => {
      const r = run([[{ type: 'suspect' }, 0], [{ type: 'suspect' }, 1], [{ type: 'stalled' }, 2]], online());
      expect(derive(r.state, 2)).toBe('online');
      expect(probes(r.effects)).toHaveLength(1);
    });

    it('goes reconnecting on a failed probe, and offline after enough of them', () => {
      let s = run([[{ type: 'suspect' }, 0]], online()).state;
      for (let i = 1; i < OFFLINE_AFTER_FAILURES; i += 1) {
        s = fail(s, i).state;
        expect(derive(s, i)).toBe('reconnecting');
      }
      s = fail(s, 10).state;
      expect(derive(s, 10)).toBe('offline');
    });

    it('backs off 1, 2, 4, 8 seconds, then every 10', () => {
      expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
      const r = fail(run([[{ type: 'suspect' }, 0]], online()).state, 5);
      expect(r.effects).toContainEqual({ type: 'probeIn', ms: 1_000, epoch: r.state.epoch });
    });

    it('does not believe a socket that says open through a failed probe', () => {
      const s = run([[{ type: 'socket', key: 'chat', status: 'open' }, 0], [{ type: 'suspect' }, 1]], online()).state;
      const r = fail(s, 2);
      expect(derive(r.state, 2)).toBe('reconnecting');
      expect(r.effects).toContainEqual({ type: 'reconnectSockets' });
    });

    it('recovers on a good probe, and has the sockets reconnect now', () => {
      let s = run([[{ type: 'socket', key: 'chat', status: 'closed' }, 0]], online()).state;
      s = fail(s, 1).state;
      const r = run([[{ type: 'probeResult', ok: true, epoch: s.epoch }, 2]], s);
      expect(r.state.failedProbes).toBe(0);
      expect(r.effects).toContainEqual({ type: 'reconnectSockets' });
      expect(r.effects).toContainEqual({ type: 'recovered' });
    });

    it('never interrupts a socket that is still connecting when a probe succeeds', () => {
      // A slow relay: connecting past the stuck threshold, the probe answers.
      const s = run([[{ type: 'socket', key: 'chat', status: 'connecting' }, 0]], online()).state;
      const stuck = run([[{ type: 'tick' }, STUCK_CONNECTING_MS]], s);
      expect(probes(stuck.effects)).toHaveLength(1);
      const r = run([[{ type: 'probeResult', ok: true, epoch: stuck.state.epoch }, STUCK_CONNECTING_MS + 10]], stuck.state);
      expect(r.effects).not.toContainEqual({ type: 'reconnectSockets' });
    });

    it('keeps a heartbeat only while in the foreground', () => {
      const r = run([[{ type: 'start' }, 0], [{ type: 'probeResult', ok: true, epoch: 0 }, 0]]);
      expect(r.effects).toContainEqual({ type: 'probeIn', ms: HEARTBEAT_MS, epoch: 0 });
      const away = run([[{ type: 'background' }, 1], [{ type: 'suspect' }, 2]], r.state);
      expect(probes(away.effects)).toHaveLength(0);
    });

    it('probes at once on Retry, and reconnects the sockets', () => {
      const s = fail(run([[{ type: 'suspect' }, 0]], online()).state, 1).state;
      const r = run([[{ type: 'retry' }, 2]], s);
      expect(probes(r.effects)).toHaveLength(1);
      expect(r.effects).toContainEqual({ type: 'reconnectSockets' });
    });

    it('forgets what it knew when the server changes', () => {
      let s = run([[{ type: 'suspect' }, 0]], online()).state;
      for (let i = 0; i < OFFLINE_AFTER_FAILURES; i += 1) s = fail(s, i).state;
      const r = run([[{ type: 'reset' }, 50]], s);
      expect(r.state.failedProbes).toBe(0);
      expect(derive(r.state, 50)).toBe('resuming');
      expect(probes(r.effects)).toHaveLength(1);
    });
  });
});
