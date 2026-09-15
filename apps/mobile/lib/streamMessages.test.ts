import { describe, expect, it } from 'vitest';
import type { ApiMessage, StreamSnapshot } from '@loxaic/api-client';
import { applyEventToMsgs, applySnapshotToMsgs, reconstructMessages } from './streamMessages';
import type { Message } from './types';

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

  it('never on a completed history row', () => {
    const [m] = reconstructMessages([row({ content: [{ kind: 'text', text: 'fine' }] })]);
    expect(m.error).toBe(false);
    expect(m.errorText).toBeUndefined();
  });
});
