import { describe, expect, it } from 'vitest';
import type { ServerMessage, StreamEventKind, StreamSnapshot } from '@loxaic/api-client';
import type { Message } from './types';
import { applyEventToMsgs, reconstructMessages, snapshotMessageToMessage } from './streamMessages';
import {
  EMPTY_TRANSCRIPT,
  applyChildEnd,
  applyChildEvent,
  applyChildSync,
  historyAsked,
  withChildHistory,
} from './subAgentTranscript';

const CHILD = '11111111-1111-4111-8111-111111111111';
const STREAM = 'stream-1';
const NOW = 500_000;

const sync = (over: Partial<Extract<ServerMessage, { type: 'stream.sync' }>> = {}): Extract<ServerMessage, { type: 'stream.sync' }> => ({
  type: 'stream.sync',
  stream_id: STREAM,
  conversation_id: CHILD,
  seq: 3,
  status: 'active',
  snapshot: {
    messages: [
      { message_id: 'u1', author_type: 'user', parent_id: null, lamport: 1, text: 'the task', thinking: '', tool_calls: [], status: 'complete' },
      { message_id: 'a1', author_type: 'assistant', parent_id: 'u1', lamport: 2, model: 'child-model', text: 'work', thinking: '', tool_calls: [], status: 'streaming' },
    ],
  } satisfies StreamSnapshot,
  ...over,
});

const event = (inner: StreamEventKind, seq = 4, streamId = STREAM): Extract<ServerMessage, { type: 'stream.event' }> => ({
  type: 'stream.event',
  stream_id: streamId,
  conversation_id: CHILD,
  seq,
  event: inner,
});

describe('a sub-agent\'s transcript', () => {
  it('fills from a snapshot, timed from the run\'s real start', () => {
    const t = applyChildSync(EMPTY_TRANSCRIPT, sync({ started_at: 4_000, server_now: 10_000 }), NOW);
    expect(t.msgs.map((m) => m.text)).toEqual(['the task', 'work']);
    expect(t.live).toMatchObject({ streamId: STREAM, model: 'child-model', responseStartedAt: NOW - 6_000, loadingModel: false });
  });

  it('streams the reply with the thread\'s own fold', () => {
    let t = applyChildSync(EMPTY_TRANSCRIPT, sync(), NOW);
    t = applyChildEvent(t, event({ kind: 'text.delta', message_id: 'a1', text: ' in progress' }));
    expect(t.msgs.at(-1)?.text).toBe('work in progress');
    // The same bytes the parent's thread would have built from that event.
    expect(t.msgs).toEqual(applyEventToMsgs(applyChildSync(EMPTY_TRANSCRIPT, sync(), NOW).msgs, { kind: 'text.delta', message_id: 'a1', text: ' in progress' }));
  });

  it('shows the prompt line until the reply starts, and the load until it is over', () => {
    let t = applyChildSync(EMPTY_TRANSCRIPT, sync(), NOW);
    t = applyChildEvent(t, event({ kind: 'model.loading', message_id: 'a2' }));
    expect(t.live?.loadingModel).toBe(true);
    t = applyChildEvent(t, event({ kind: 'prompt.stats', message_id: 'a2', prompt_tokens_est: 900, est_basis: 'estimate', reusable_tokens: null, window_tokens: 8_192, eta_ms: null, started_at: 1 }, 5));
    expect(t.live?.promptStats?.prompt_tokens_est).toBe(900);
    expect(t.live?.loadingModel).toBe(true);
    t = applyChildEvent(t, event({ kind: 'text.delta', message_id: 'a2', text: 'x' }, 6));
    expect(t.live?.promptStats).toBeNull();
    expect(t.live?.loadingModel).toBe(false);
  });

  it('puts the stored history in front of what the live run has written, never instead of it', () => {
    let t = applyChildSync(EMPTY_TRANSCRIPT, sync(), NOW);
    t = applyChildEvent(t, event({ kind: 'text.delta', message_id: 'a1', text: ' — live' }));
    const stored: Message[] = [
      { id: 'u1', role: 'user', text: 'the task' },
      { id: 'a1', role: 'assistant', text: 'work' },
    ];
    t = withChildHistory(t, stored);
    expect(t.historyLoaded).toBe(true);
    // The live copy of `a1` is the newer one.
    expect(t.msgs.map((m) => m.text)).toEqual(['the task', 'work — live']);
  });

  it('is the stored history alone for a child that finished before the panel opened', () => {
    const stored: Message[] = [{ id: 'u1', role: 'user', text: 'the task' }, { id: 'a1', role: 'assistant', text: 'the report' }];
    const t = withChildHistory(EMPTY_TRANSCRIPT, stored);
    expect(t.msgs).toEqual(stored);
    expect(t.live).toBeNull();
  });

  it('counts a failed history fetch as asked, so the panel stops waiting for it', () => {
    expect(historyAsked(EMPTY_TRANSCRIPT).historyLoaded).toBe(true);
    const loaded = withChildHistory(EMPTY_TRANSCRIPT, []);
    expect(historyAsked(loaded)).toBe(loaded);
  });

  it('ends on its own stream\'s end, and on a finished snapshot', () => {
    const live = applyChildSync(EMPTY_TRANSCRIPT, sync(), NOW);
    const end = { type: 'stream.end', stream_id: STREAM, conversation_id: CHILD, seq: 9, status: 'complete' } as const;
    expect(applyChildEnd(live, end).live).toBeNull();
    // Another stream's end is not this run's.
    expect(applyChildEnd(live, { ...end, stream_id: 'other' })).toBe(live);
    expect(applyChildSync(live, sync({ status: 'cancelled' }), NOW).live).toBeNull();
  });

  it('ignores events from a stream it is not tracking for its live line', () => {
    const live = applyChildSync(EMPTY_TRANSCRIPT, sync(), NOW);
    const t = applyChildEvent(live, event({ kind: 'model.loading', message_id: 'zz' }, 4, 'other-stream'));
    expect(t.live?.loadingModel).toBe(false);
  });
});

describe('a sub-agent tool call remembers the message it belongs to', () => {
  // The card finds its child by (message, call id): a model's call ids repeat
  // across messages, so the call id alone would put one child's state on
  // another's card. All three ways a ToolCall is built must agree.
  const args = { description: 'Read the docs', prompt: 'read them' };

  it('from a live tool.call', () => {
    const msgs = applyEventToMsgs([{ id: 'a1', role: 'assistant', text: '' }], { kind: 'tool.call', message_id: 'a1', call_id: 'call_0', tool: 'subagent', args });
    expect(msgs[0].tools?.[0]).toMatchObject({ tool: 'subagent', callId: 'call_0', summary: 'Read the docs', subagent: { description: 'Read the docs', messageId: 'a1' } });
  });

  it('from a snapshot', () => {
    const m = snapshotMessageToMessage({
      message_id: 'a1', author_type: 'assistant', parent_id: null, text: '', thinking: '', status: 'complete',
      tool_calls: [{ call_id: 'call_0', tool: 'subagent', args, output: 'done', ok: true }],
    });
    expect(m.tools?.[0].subagent).toEqual({ description: 'Read the docs', messageId: 'a1' });
  });

  it('from stored history', () => {
    const msgs = reconstructMessages([
      { id: 'a1', conversationId: 'c', parentId: null, authorType: 'assistant', content: [{ kind: 'tool_call', call_id: 'call_0', tool: 'subagent', args }], status: 'complete', lamport: 2 },
    ] as never);
    expect(msgs[0].tools?.[0].subagent).toEqual({ description: 'Read the docs', messageId: 'a1' });
  });

  it('and no other tool grows the field', () => {
    const msgs = applyEventToMsgs([{ id: 'a1', role: 'assistant', text: '' }], { kind: 'tool.call', message_id: 'a1', call_id: 'c', tool: 'bash', args: { command: 'ls' } });
    expect(msgs[0].tools?.[0]).not.toHaveProperty('subagent');
  });
});
