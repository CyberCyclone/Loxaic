import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOT_SENT_RECONNECTING,
  __resetConnectionForTest,
  disconnectedCopy,
  isOffline,
  publishConnectionState,
  requireServer,
  showsDisconnected,
} from './connection';

afterEach(() => { __resetConnectionForTest(); });

describe('what the app says about its connection', () => {
  it('shows nothing during a grace period, but still blocks input', () => {
    publishConnectionState('resuming');
    expect(isOffline()).toBe(true);
    expect(showsDisconnected('resuming')).toBe(false);
  });

  it('never calls a reconnect "offline"', () => {
    const reconnecting = disconnectedCopy('reconnecting');
    for (const line of [reconnecting.banner, reconnecting.note('answer'), reconnecting.readOnly('run')]) {
      expect(line).not.toMatch(/offline|can't reach/i);
    }
    expect(reconnecting.notSent).toBe(NOT_SENT_RECONNECTING);
  });

  it('names the thing that has to wait', () => {
    expect(disconnectedCopy('offline').note('decide on this plan')).toContain('decide on this plan');
  });

  it('refuses a press while not online, and says why', () => {
    const toast = vi.fn();
    expect(requireServer(toast)).toBe(true);
    publishConnectionState('offline');
    expect(requireServer(toast)).toBe(false);
    expect(toast).toHaveBeenCalledWith(disconnectedCopy('offline').notSent, 4000);
  });
});
