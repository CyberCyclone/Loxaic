import { describe, expect, it } from 'vitest';
import { isNoRoom, lostSendNote, noRoomNotice, PendingSends, unsentNote } from './noRoom';

const send = (id: string, over: Partial<{ text: string; localConvId: string | null; hadAttachments: boolean }> = {}) => ({
  text: over.text ?? `text of ${id}`,
  localMsgId: id,
  localConvId: over.localConvId ?? null,
  hadAttachments: over.hadAttachments ?? false,
});

describe('pending sends', () => {
  it('takes back the send a refusal names, not the latest one', () => {
    // Send in A, then in B; A's refusal lands after B went out.
    const sends = new PendingSends();
    sends.remember('a', send('a'));
    sends.remember('b', send('b'));
    expect(sends.take('a')?.localMsgId).toBe('a');
    // B is untouched and still known; A is forgotten once taken.
    expect(sends.take('a')).toBeUndefined();
    expect(sends.take('b')?.localMsgId).toBe('b');
  });

  it('takes nothing for a refusal that names no send', () => {
    const sends = new PendingSends();
    sends.remember('a', send('a'));
    expect(sends.take(undefined)).toBeUndefined();
    expect(sends.take('nope')).toBeUndefined();
  });

  it('keeps only the newest sends', () => {
    const sends = new PendingSends();
    for (let i = 0; i < 30; i++) sends.remember(`s${String(i)}`, send(`s${String(i)}`));
    expect(sends.take('s0')).toBeUndefined();
    expect(sends.take('s29')?.localMsgId).toBe('s29');
  });
});

describe('the no-room notice', () => {
  it('recognises the refusal on both shapes', () => {
    expect(isNoRoom({ type: 'error', code: 'local_model_no_room' })).toBe(true);
    expect(isNoRoom({ type: 'stream.end', error_code: 'local_model_no_room' })).toBe(true);
    expect(isNoRoom({ type: 'error' })).toBe(false);
  });

  it('only says the message is back in the box when there was text to put back', () => {
    expect(unsentNote(noRoomNotice('m', send('a', { text: 'hello' })))).toBe(
      'Your message was not sent. It is back in the message box.',
    );
    // An attachment-only send has no text to return, and its files cannot be.
    expect(unsentNote(noRoomNotice('m', send('a', { text: '', hadAttachments: true })))).toBe(
      'Your message was not sent. Add its attachments again.',
    );
    expect(unsentNote(noRoomNotice('m', send('a', { text: 'hi', hadAttachments: true })))).toBe(
      'Your message was not sent. Its text is back in the message box; add its attachments again.',
    );
  });

  it('says nothing about a message when the refusal came mid-run or for an unknown send', () => {
    expect(unsentNote({ message: 'm', text: null, hadAttachments: false })).toBeNull();
    expect(unsentNote(noRoomNotice('m', undefined))).toBeNull();
  });
});

describe('a send whose answer was lost with its socket', () => {
  it('finds the send that created a local conversation, and only that one', () => {
    const sends = new PendingSends();
    sends.remember('s1', send('s1', { localConvId: null }));
    sends.remember('s2', send('s2', { localConvId: 'c100' }));
    sends.remember('s3', send('s3', { localConvId: null }));
    expect(sends.refFor('c100')).toBe('s2');
    expect(sends.refFor('c999')).toBeUndefined();
  });

  it('no longer finds one that has been taken', () => {
    const sends = new PendingSends();
    sends.remember('s2', send('s2', { localConvId: 'c100' }));
    sends.take('s2');
    expect(sends.refFor('c100')).toBeUndefined();
  });

  it('says the message may not have been sent, and what came back', () => {
    expect(lostSendNote(send('a', { text: 'hello' }))).toBe(
      'The connection dropped before the server confirmed your message, so it may not have been sent. It is back in the message box.',
    );
    expect(lostSendNote(send('a', { text: '', hadAttachments: true }))).toBe(
      'The connection dropped before the server confirmed your message, so it may not have been sent. Add its attachments again.',
    );
    expect(lostSendNote(send('a', { text: 'hi', hadAttachments: true }))).toBe(
      'The connection dropped before the server confirmed your message, so it may not have been sent. Its text is back in the message box; add its attachments again.',
    );
  });
});
