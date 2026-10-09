import { describe, expect, it } from 'vitest';
import type { StreamSnapshot } from '@loxaic/api-client';
import { isEmptyGenerating, liveCounterStart } from './liveTimer';
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

  it('not from a snapshot without the server\'s clock, which would time it from now', () => {
    const [m] = applySnapshotToMsgs([], snapshot(10_000), { now: RUN });
    expect('startedAt' in m).toBe(false);
  });

  it('not from an older server\'s snapshot', () => {
    const [m] = applySnapshotToMsgs([], snapshot(), { serverNow: 50_000, now: RUN });
    expect('startedAt' in m).toBe(false);
  });
});
