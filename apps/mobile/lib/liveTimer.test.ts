import { describe, expect, it } from 'vitest';
import type { StreamSnapshot } from '@loxaic/api-client';
import { isEmptyGenerating, liveCounterStart, typingIndicatorFor } from './liveTimer';
import { applyEventToMsgs, applySnapshotToMsgs } from './streamMessages';
import type { Message } from './types';

const RUN = 1_000_000;

describe('what the live counter counts from', () => {
  it('the newest message, not the run — an agent turn is many messages', () => {
    // Fifty iterations in, the newest reply began seconds ago: it used to read
    // the whole turn's age ("Thinking… 1955s").
    expect(liveCounterStart({ role: 'assistant', startedAt: RUN + 1_950_000 }, RUN)).toBe(RUN + 1_950_000);
  });

  it('the run, before the turn has a reply of its own', () => {
    expect(liveCounterStart({ role: 'user', startedAt: RUN + 5 }, RUN)).toBe(RUN);
    expect(liveCounterStart(undefined, RUN)).toBe(RUN);
  });

  it('the run, for a message whose start nobody reported (an older server)', () => {
    expect(liveCounterStart({ role: 'assistant' }, RUN)).toBe(RUN);
  });

  it('never before the run began: a previous turn\'s reply cannot make it jump back', () => {
    expect(liveCounterStart({ role: 'assistant', startedAt: RUN - 60_000 }, RUN)).toBe(RUN);
  });

  it('nothing, when nothing is running', () => {
    expect(liveCounterStart({ role: 'assistant', startedAt: RUN }, null)).toBeNull();
  });
});

describe('a reply with nothing to show yet', () => {
  it('is one with no thinking, no text and no tool calls', () => {
    expect(isEmptyGenerating({ role: 'assistant', text: '' })).toBe(true);
    expect(isEmptyGenerating({ role: 'assistant', text: '', thinking: 'hm' })).toBe(false);
    expect(isEmptyGenerating({ role: 'assistant', text: 'hi' })).toBe(false);
  });

  it('is not one that is only a tool call — its card used to hide behind "Processing prompt…"', () => {
    expect(
      isEmptyGenerating({ role: 'assistant', text: '', tools: [{ tool: 'subagent', summary: 'Look', result: '' }] }),
    ).toBe(false);
  });

  it('is never someone\'s message', () => {
    expect(isEmptyGenerating({ role: 'user', text: '' })).toBe(false);
    expect(isEmptyGenerating(undefined)).toBe(false);
  });
});

describe('when the typing indicator speaks for the newest message', () => {
  const toolOnly = { role: 'assistant' as const, text: '', tools: [{ tool: 'fs_write', summary: 'a.txt', result: '' }] };
  const idle = { queuePosition: null, loadingModel: false };

  it('before anything is written: model load and prefill', () => {
    expect(typingIndicatorFor(undefined, idle)).toBe(true);
    expect(typingIndicatorFor({ role: 'user', text: 'hi' }, idle)).toBe(true);
    expect(typingIndicatorFor({ role: 'assistant', text: '' }, idle)).toBe(true);
  });

  it('not once the reply has thinking or text of its own', () => {
    expect(typingIndicatorFor({ role: 'assistant', text: '', thinking: 'hm' }, idle)).toBe(false);
    expect(typingIndicatorFor({ role: 'assistant', text: 'ok' }, { queuePosition: 2 })).toBe(false);
  });

  it('not while a tool-only reply\'s tools run: its cards say so, and "Processing prompt…" would not be true', () => {
    expect(typingIndicatorFor(toolOnly, idle)).toBe(false);
  });

  it('for a tool-only reply whose run went back in the queue after an approval — the only place Chat says "Queued"', () => {
    expect(typingIndicatorFor(toolOnly, { queuePosition: 2 })).toBe(true);
    expect(typingIndicatorFor(toolOnly, { loadingModel: true })).toBe(true);
    // And the row stays: the two decisions are separate.
    expect(isEmptyGenerating(toolOnly)).toBe(false);
  });

  it('never for a compaction, whose card is its face', () => {
    expect(typingIndicatorFor({ role: 'summary', text: '' }, { queuePosition: 1 })).toBe(false);
  });
});

describe('a message learns when it began', () => {
  const start = (started_at?: number) =>
    ({
      kind: 'message.start',
      message_id: 'a1',
      author_type: 'assistant',
      parent_id: null,
      ...(started_at === undefined ? {} : { started_at }),
    }) as const;

  it('from a live start: its arrival, since a live event carries no server clock', () => {
    const [m] = applyEventToMsgs([], start(5), RUN + 30_000);
    expect(m.startedAt).toBe(RUN + 30_000);
  });

  it('keeps it as the reply streams in', () => {
    let msgs: Message[] = applyEventToMsgs([], start(5), RUN);
    msgs = applyEventToMsgs(msgs, { kind: 'thinking.delta', message_id: 'a1', text: 'hm' }, RUN + 9_000);
    msgs = applyEventToMsgs(msgs, { kind: 'text.delta', message_id: 'a1', text: 'ok' }, RUN + 9_500);
    expect(msgs[0].startedAt).toBe(RUN);
  });

  it('not from an older server\'s live start, which says nothing', () => {
    const [m] = applyEventToMsgs([], start(), RUN);
    expect('startedAt' in m).toBe(false);
  });

  const snapshot = (started_at?: number): StreamSnapshot =>
    ({
      messages: [
        {
          message_id: 'a1',
          author_type: 'assistant',
          parent_id: null,
          ...(started_at === undefined ? {} : { started_at }),
          text: '',
          thinking: 'still thinking',
          tool_calls: [],
          status: 'streaming',
        },
      ],
    }) as unknown as StreamSnapshot;

  it('from a snapshot: corrected by the server\'s clock, so a reconnect mid-reply is not reset', () => {
    // The server says the message began 40 s before it sent the snapshot; this
    // device's clock is an hour off. The start lands 40 s before now, here.
    const [m] = applySnapshotToMsgs([], snapshot(10_000), { serverNow: 50_000, now: RUN + 3_600_000 });
    expect(m.startedAt).toBe(RUN + 3_600_000 - 40_000);
  });

  it('keeps a start it already has: a slow resync after a fast one must not move the counter back', () => {
    // First sync: generated at the server's 50 s, start 40 s before → now - 40 s.
    let msgs = applySnapshotToMsgs([], snapshot(10_000), { serverNow: 50_000, now: RUN });
    expect(msgs[0].startedAt).toBe(RUN - 40_000);
    // Second, for the same message: generated at 55 s, delivered 3 s late at
    // RUN + 8 s. Recomputed, it would read RUN + 8 s - 45 s = RUN - 37 s.
    msgs = applySnapshotToMsgs(msgs, snapshot(10_000), { serverNow: 55_000, now: RUN + 8_000 });
    expect(msgs[0].startedAt).toBe(RUN - 40_000);
  });

  it('keeps a live start through the snapshot that follows it', () => {
    let msgs = applyEventToMsgs([], start(10_000), RUN);
    msgs = applySnapshotToMsgs(msgs, snapshot(10_000), { serverNow: 50_000, now: RUN + 3_000 });
    expect(msgs[0].startedAt).toBe(RUN);
  });

  it('not from a snapshot without the server\'s clock, which would time it from now', () => {
    const [m] = applySnapshotToMsgs([], snapshot(10_000), { now: RUN });
    expect('startedAt' in m).toBe(false);
  });

  it('not from an older server\'s snapshot', () => {
    const [m] = applySnapshotToMsgs([], snapshot(), { serverNow: 50_000, now: RUN });
    expect('startedAt' in m).toBe(false);
  });
});
