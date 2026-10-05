import { describe, expect, it } from 'vitest';
import { approvalStreamId, localDeadline, toPendingApproval, toPendingCheckin } from './pendingWaits';

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

  it('carries the asking run\'s mode and whose grant it would be', () => {
    expect(
      toPendingApproval({ call_id: 'c', tool: 'bash', args: {}, mode: 'auto', granter_user_id: 'u1' }, 0),
    ).toEqual({ callId: 'c', tool: 'bash', args: {}, mode: 'auto', granterUserId: 'u1' });
  });
});

describe('which run an approval answer names', () => {
  it('records the stream a prompt arrived on', () => {
    expect(toPendingApproval({ call_id: 'c', tool: 'bash', args: {} }, 0, undefined, 'stream-1')).toEqual({
      callId: 'c',
      tool: 'bash',
      args: {},
      streamId: 'stream-1',
    });
  });

  it('names the run that asked, so another thread\'s run holding the same call id is not answered', () => {
    const pending = toPendingApproval({ call_id: 'call_0', tool: 'fs_write', args: {} }, 0, undefined, 'stream-b');
    expect(approvalStreamId(pending, 'call_0', 'stream-tracked')).toBe('stream-b');
  });

  it('falls back to the conversation\'s tracked run, and names none only when neither is known', () => {
    const noStream = toPendingApproval({ call_id: 'call_0', tool: 'fs_write', args: {} }, 0);
    expect(approvalStreamId(noStream, 'call_0', 'stream-tracked')).toBe('stream-tracked');
    // A prompt for a different call is not this answer's.
    const other = toPendingApproval({ call_id: 'call_9', tool: 'bash', args: {} }, 0, undefined, 'stream-x');
    expect(approvalStreamId(other, 'call_0', 'stream-tracked')).toBe('stream-tracked');
    expect(approvalStreamId(null, 'call_0', undefined)).toBeUndefined();
  });
});
