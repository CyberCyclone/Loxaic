import { describe, expect, it } from 'vitest';
import { localDeadline, toPendingApproval, toPendingCheckin } from './pendingWaits';

describe('localDeadline', () => {
  it('counts a live event from now', () => {
    expect(localDeadline({ timeout_ms: 600_000, expires_at: 9e12 }, 1_000)).toEqual({ deadlineAt: 601_000, timeoutMs: 600_000 });
  });

  it('corrects a snapshot for clock skew', () => {
    // Server says 5 minutes remain; this device is an hour ahead.
    const serverNow = 1_000_000;
    const d = localDeadline({ timeout_ms: 600_000, expires_at: serverNow + 300_000 }, serverNow + 3_600_000, serverNow);
    expect(d?.deadlineAt).toBe(serverNow + 3_600_000 + 300_000);
  });

  it('is absent when the server sent no deadline', () => {
    expect(localDeadline({}, 1)).toBeUndefined();
  });
});

describe('toPending*', () => {
  it('carries the ladder on a check-in', () => {
    expect(
      toPendingCheckin(
        { n: 3, max: 100, reason: 'loop', timeout_ms: 1000, timeout_basis: 'adaptive', on_timeout: 'continue', unattended: 1, auto_continues: 2 },
        0,
      ),
    ).toEqual({
      n: 3,
      max: 100,
      reason: 'loop',
      deadline: { deadlineAt: 1000, timeoutMs: 1000, basis: 'adaptive' },
      onTimeout: 'continue',
      unattended: 1,
      autoContinues: 2,
    });
  });

  it('keeps an older server\'s approval exactly as it was', () => {
    expect(toPendingApproval({ call_id: 'c', tool: 'bash', args: {} }, 0)).toEqual({ callId: 'c', tool: 'bash', args: {} });
  });
});
