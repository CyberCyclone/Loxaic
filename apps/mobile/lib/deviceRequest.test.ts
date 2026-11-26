import { describe, expect, it } from 'vitest';
import {
  answerFor,
  answerWasLost,
  deviceRequestKey,
  locationAction,
  reasonFromError,
  roundForSending,
  sendWhenOpen,
  toPendingDeviceRequest,
  type PendingDeviceRequest,
} from './deviceRequest';

const pending = (over: Partial<PendingDeviceRequest> = {}): PendingDeviceRequest => ({
  callId: 'c1',
  streamId: 's1',
  ask: true,
  userId: 'me',
  ...over,
});

describe('toPendingDeviceRequest', () => {
  it('takes a live event as just sent, and a snapshot by the server clock', () => {
    const live = toPendingDeviceRequest({ call_id: 'c1', ask: true, user_id: 'me', reason: 'weather', timeout_ms: 60_000, expires_at: 9_000_000 }, 1_000, 's1');
    expect(live).toEqual({ callId: 'c1', streamId: 's1', ask: true, userId: 'me', reason: 'weather', deadline: { deadlineAt: 61_000, timeoutMs: 60_000 } });
    // A snapshot 20 s after the request: 40 s left, by this device's clock.
    const synced = toPendingDeviceRequest({ call_id: 'c1', ask: false, user_id: 'me', timeout_ms: 60_000, expires_at: 160_000 }, 5_000, 's1', 120_000);
    expect(synced.deadline?.deadlineAt).toBe(45_000);
    expect(synced.reason).toBeUndefined();
  });
});

describe('locationAction', () => {
  it('asks the sender, answers alone under Always allow, and tells anyone else it waits', () => {
    const none = new Set<string>();
    expect(locationAction({ pending: pending(), me: 'me', answered: none })).toBe('prompt');
    expect(locationAction({ pending: pending({ ask: false }), me: 'me', answered: none })).toBe('answerSilently');
    expect(locationAction({ pending: pending(), me: 'someone else', answered: none })).toBe('waitingForOther');
    expect(locationAction({ pending: null, me: 'me', answered: none })).toBe('none');
  });

  it('shows nothing, and answers nothing, until it knows who is signed in', () => {
    // A cold start: the sender must not be told they wait on someone else.
    for (const me of [null, undefined]) {
      expect(locationAction({ pending: pending(), me, answered: new Set() })).toBe('none');
      expect(locationAction({ pending: pending({ ask: false }), me, answered: new Set() })).toBe('none');
    }
  });

  it('does nothing about a request this device already answered', () => {
    const p = pending({ ask: false });
    expect(locationAction({ pending: p, me: 'me', answered: new Set([deviceRequestKey(p)]) })).toBe('none');
    // Another run's call with the same id is a different request.
    expect(locationAction({ pending: { ...p, streamId: 's2' }, me: 'me', answered: new Set([deviceRequestKey(p)]) })).toBe('answerSilently');
  });
});

describe('answerWasLost', () => {
  const first = {};
  const second = {};
  it('is lost when it went out on a socket since replaced', () => {
    expect(answerWasLost(first, second)).toBe(true);
    expect(answerWasLost(first, null)).toBe(true);
  });
  it('may still be on its way on the socket in use, and was never sent when there is none', () => {
    expect(answerWasLost(first, first)).toBe(false);
    expect(answerWasLost(undefined, second)).toBe(false);
  });
});

describe('reasonFromError', () => {
  const ok = { secureContext: true, supported: true };
  it('reads the platform errors', () => {
    expect(reasonFromError({ code: 1, message: 'User denied Geolocation' }, ok)).toBe('permission_denied');
    expect(reasonFromError(new Error('Location permission not granted'), ok)).toBe('permission_denied');
    expect(reasonFromError({ code: 3 }, ok)).toBe('timeout');
    expect(reasonFromError(new Error('Location request timed out'), ok)).toBe('timeout');
    expect(reasonFromError({ code: 2 }, ok)).toBe('unsupported');
    expect(reasonFromError(new Error('Location services are disabled'), ok)).toBe('unsupported');
    expect(reasonFromError(new Error('something else'), ok)).toBe('error');
  });

  it('says why before reading any error: no geolocation, or not a secure page', () => {
    expect(reasonFromError(null, { secureContext: true, supported: false })).toBe('unsupported');
    expect(reasonFromError({ code: 1 }, { secureContext: false, supported: true })).toBe('insecure_origin');
  });
});

describe('answerFor', () => {
  const at = { ok: true as const, lat: -27.46794, lon: 153.02809 };
  it('shares a position rounded to about a kilometre, with the zone', () => {
    expect(roundForSending(-27.46794, 153.02809)).toEqual({ lat: -27.47, lon: 153.03 });
    expect(answerFor('once', at, 'Australia/Brisbane')).toEqual({ outcome: 'shared', location: { lat: -27.47, lon: 153.03 }, tz: 'Australia/Brisbane' });
    expect(answerFor('always', at, undefined)).toEqual({ outcome: 'shared', location: { lat: -27.47, lon: 153.03 }, always: true });
  });

  it('says why when there is no position, and never shares on a refusal', () => {
    expect(answerFor('once', { ok: false, reason: 'permission_denied' }, undefined)).toEqual({ outcome: 'unavailable', reason: 'permission_denied' });
    expect(answerFor('deny', at, 'Australia/Brisbane')).toEqual({ outcome: 'declined', tz: 'Australia/Brisbane' });
    expect(answerFor('once', null, undefined)).toEqual({ outcome: 'unavailable', reason: 'error' });
  });
});

describe('sendWhenOpen', () => {
  it('sends on the socket that replaced a closing one', async () => {
    let clock = 0;
    const closing = { readyState: 2 };
    const fresh = { readyState: 1 };
    let current: { readyState: number } = closing;
    const sentOn: unknown[] = [];
    const sent = await sendWhenOpen(
      () => current,
      (ws) => { sentOn.push(ws); return true; },
      { now: () => clock, sleep: (ms) => { clock += ms; if (clock >= 500) current = fresh; return Promise.resolve(); } },
    );
    expect(sent).toBe(true);
    expect(sentOn).toEqual([fresh]);
  });

  it('gives up when no socket opens in time, sending nothing', async () => {
    let clock = 0;
    const sentOn: unknown[] = [];
    const sent = await sendWhenOpen(
      () => null,
      (ws) => { sentOn.push(ws); return true; },
      { waitMs: 1_000, now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); } },
    );
    expect(sent).toBe(false);
    expect(sentOn).toEqual([]);
  });
});
