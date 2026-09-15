import { describe, expect, it } from 'vitest';
import type { ApiMessage, StreamSnapshot } from '@loxaic/api-client';
import { applyEventToMsgs, applySnapshotToMsgs, reconstructMessages } from './streamMessages';
import type { Message } from './types';
import { compactionCardState } from '@/components/chat/compactionState';

/**
 * A failed turn has to say why on all three routes a message reaches the
 * screen: live (`message.end`), catching up on a running stream (the
 * snapshot), and a cold reload (history). The reload path is the one that was
 * silently empty — it never set `error` at all.
 */
const REASON = 'Failed to load model "qwen3.8-27b@q5_k_xl". Error: out of memory';

function row(overrides: Partial<ApiMessage>): ApiMessage {
  return {
    id: 'a1',
    conversationId: 'c1',
    parentId: null,
    authorType: 'assistant',
    authorUserId: null,
    origin: 'server',
    deviceId: null,
    model: 'm',
    lamport: 1,
    content: [],
    status: 'complete',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    usage: null,
    ...overrides,
  };
}

describe('failed turns carry their reason', () => {
  it('from message.end', () => {
    const msgs: Message[] = [{ id: 'a1', role: 'assistant', text: '' }];
    const [m] = applyEventToMsgs(msgs, { kind: 'message.end', message_id: 'a1', status: 'error', error: REASON });
    expect(m.error).toBe(true);
    expect(m.errorText).toBe(REASON);
  });

  it('not from a cancelled message.end, which stays a stop', () => {
    const msgs: Message[] = [{ id: 'a1', role: 'assistant', text: 'partial' }];
    const [m] = applyEventToMsgs(msgs, { kind: 'message.end', message_id: 'a1', status: 'cancelled' });
    expect(m.error).toBe(false);
    expect(m.errorText).toBeUndefined();
    expect(m.stopped).toBe(true);
  });

  it('from a stream snapshot', () => {
    const snapshot: StreamSnapshot = {
      messages: [
        {
          message_id: 'a1',
          author_type: 'assistant',
          parent_id: null,
          text: 'partial',
          thinking: '',
          tool_calls: [],
          status: 'error',
          error: REASON,
        },
      ],
    } as unknown as StreamSnapshot;
    const [m] = applySnapshotToMsgs([], snapshot);
    expect(m.error).toBe(true);
    expect(m.errorText).toBe(REASON);
    expect(m.text).toBe('partial');
  });

  it('from history, with partial text kept', () => {
    const [m] = reconstructMessages([
      row({ status: 'error', error: REASON, content: [{ kind: 'text', text: 'partial' }] }),
    ]);
    expect(m.error).toBe(true);
    expect(m.errorText).toBe(REASON);
    expect(m.text).toBe('partial');
  });

  it('from history rows that predate the column: flagged, with no invented reason', () => {
    const [m] = reconstructMessages([row({ status: 'error', error: null })]);
    expect(m.error).toBe(true);
    expect(m.errorText).toBeUndefined();
  });

  it('a failed compaction reloads as failed, not as a card still compacting', () => {
    // A failed summary row never gets a compaction block, and "no stats" used
    // to be all it took to render the live spinner.
    const [m] = reconstructMessages([
      row({ authorType: 'summary', status: 'error', error: REASON, content: [{ kind: 'text', text: 'partial sum' }] }),
    ]);
    expect(m.role).toBe('summary');
    expect(m.error).toBe(true);
    expect(m.errorText).toBe(REASON);
    expect(m.compaction).toBeUndefined();
    expect(compactionCardState(m.compaction, m.error)).toBe('failed');
  });

  it('a summary still streaming is live, and a finished one is not', () => {
    const [streaming] = reconstructMessages([row({ authorType: 'summary', status: 'streaming', content: [] })]);
    expect(compactionCardState(streaming.compaction, streaming.error)).toBe('live');
    const [done] = reconstructMessages([
      row({
        authorType: 'summary',
        content: [
          { kind: 'text', text: 'summary' },
          { kind: 'compaction', messages_compacted: 2, before_tokens: 10, after_tokens: 2, saved_tokens: 8, before_estimated: false },
        ],
      }),
    ]);
    expect(compactionCardState(done.compaction, done.error)).toBe('done');
  });

  it('never on a completed history row', () => {
    const [m] = reconstructMessages([row({ content: [{ kind: 'text', text: 'fine' }] })]);
    expect(m.error).toBe(false);
    expect(m.errorText).toBeUndefined();
  });
});
