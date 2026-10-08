import { describe, expect, it } from 'vitest';
import { CHECKIN_ANSWER_NUDGE } from '@loxaic/api-client';
import { applyRewound, canRewind, filesMessage, isContextFailure, restoreReportLine, retryIndex, rewindMessage, type Rewound } from './rewind';
import type { Message } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n: number, text = `m${String(n)}`): Message => ({ id: id(n), role: 'user', text });
const reply = (n: number): Message => ({ id: id(n), role: 'assistant', text: `r${String(n)}` });

const rewound = (from: number, removed: number[], reason: Rewound['reason'] = 'rewind'): Rewound => ({
  type: 'conversation.rewound',
  conversation_id: 'c',
  from_message_id: id(from),
  removed_ids: removed.map(id),
  removed_stream_ids: [],
  reason,
});

describe('applyRewound', () => {
  it('drops the removed messages and keeps the rest in order', () => {
    const msgs = [user(1), reply(2), user(3), reply(4)];
    expect(applyRewound(msgs, rewound(3, [3, 4]))).toEqual([user(1), reply(2)]);
  });

  it('keeps a retry\'s new reply that arrived before the event', () => {
    // The old reply 4 is replaced by 5; 5 landed first.
    const msgs = [user(1), reply(2), user(3), reply(4), reply(5)];
    expect(applyRewound(msgs, rewound(3, [4], 'retry'))).toEqual([user(1), reply(2), user(3), reply(5)]);
  });

  it('drops a bubble still waiting for its id after the point, never one before it', () => {
    const optimisticBefore: Message = { id: 'local-1', role: 'user', text: 'earlier, still waiting' };
    const optimisticAfter: Message = { id: 'local-2', role: 'user', text: 'sent meanwhile' };
    const msgs = [optimisticBefore, user(1), reply(2), optimisticAfter];
    expect(applyRewound(msgs, rewound(1, [1, 2]))).toEqual([optimisticBefore]);
  });

  it('returns the same array when nothing it holds was removed', () => {
    const msgs = [user(1), reply(2)];
    expect(applyRewound(msgs, rewound(9, [9, 10]))).toBe(msgs);
  });
});

describe('canRewind and retryIndex', () => {
  it('offers rewind only on stored messages a person typed', () => {
    expect(canRewind(user(1))).toBe(true);
    expect(canRewind(reply(2))).toBe(false);
    expect(canRewind({ id: 'local-1', role: 'user', text: 'waiting' })).toBe(false);
    expect(canRewind({ ...user(3), text: CHECKIN_ANSWER_NUDGE })).toBe(false);
    expect(canRewind({ ...user(4), fromAgent: true })).toBe(false);
  });

  it('puts retry on the newest reply to the newest typed message', () => {
    expect(retryIndex([user(1), reply(2), user(3), reply(4)])).toBe(3);
    // A nudge and a later reply in the same turn: still that turn's newest reply.
    expect(retryIndex([user(1), reply(2), { ...user(3), text: CHECKIN_ANSWER_NUDGE }, reply(4)])).toBe(3);
    // The newest message has no reply yet: nothing to retry.
    expect(retryIndex([user(1), reply(2), user(3)])).toBe(-1);
    // A reply still streaming in has no server id yet.
    expect(retryIndex([user(1), { role: 'assistant', text: 'typing' }])).toBe(-1);
    expect(retryIndex([])).toBe(-1);
  });
});

describe('what the dialog says', () => {
  it('counts what goes, names other people\'s messages, and says when admins keep it', () => {
    expect(rewindMessage({ turns: 1, others: 0, retained: false })).toBe(
      'This message and its reply will be removed, and the message comes back to the composer to edit.',
    );
    expect(rewindMessage({ turns: 3, others: 1, retained: true })).toBe(
      'This message, the 2 messages after it, and every reply will be removed. The message comes back to the composer to edit. ' +
        'One of them was sent by someone else in this conversation. Admins can still read what is removed, as this server keeps deleted chats.',
    );
    expect(rewindMessage({ turns: 2, others: 2, retained: false })).toContain('the message after it');
  });

  it('asks about files in the words of the action', () => {
    expect(filesMessage(1, 'retry')).toBe('The agent changed 1 file in this reply. Put it back before answering again?');
    expect(filesMessage(3, 'rewind')).toBe('The agent changed 3 files from here on.');
  });

  it('reports a restore, naming the first file it could not put back', () => {
    expect(restoreReportLine(null)).toBeNull();
    expect(restoreReportLine({ restored: [], skipped: [] })).toBeNull();
    expect(restoreReportLine({ restored: ['/a', '/b'], skipped: [] })).toBe('Put back 2 files.');
    expect(
      restoreReportLine({
        restored: ['/a'],
        skipped: [
          { path: '/repo/big.bin', reason: 'larger than 10 MiB, so no copy was kept' },
          { path: '/repo/link', reason: 'a symbolic link' },
        ],
      }),
    ).toBe('Put back 1 file. Could not put back big.bin and 1 more: larger than 10 MiB, so no copy was kept.');
  });
});

describe('isContextFailure', () => {
  it('is a failed reply whose request could not fit, by either side', () => {
    expect(isContextFailure({ ...reply(1), error: true, errorCode: 'context_cannot_fit' })).toBe(true);
    expect(isContextFailure({ ...reply(1), error: true, errorCode: 'context_overflow' })).toBe(true);
    expect(isContextFailure({ ...reply(1), error: true, errorCode: 'local_model_no_room' })).toBe(false);
    expect(isContextFailure({ ...reply(1), error: true })).toBe(false);
    expect(isContextFailure({ ...reply(1), errorCode: 'context_overflow' })).toBe(false);
  });
});
