import { describe, expect, it } from 'vitest';
import { CHECKIN_ANSWER_NUDGE, type ApiMessage, type StreamSnapshot } from '@loxaic/api-client';
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

/**
 * Who settled a check-in has to survive every route too. The client used to
 * drop it on all three, so the transcript said "You asked" whatever happened.
 */
describe('check-in provenance', () => {
  const nudge = (authorUserId: string | null) =>
    row({ id: 'n1', authorType: 'user', authorUserId, model: null, content: [{ kind: 'text', text: CHECKIN_ANSWER_NUDGE }] });

  it('from history: null means nobody, an id means that person', () => {
    expect(reconstructMessages([nudge(null)])[0]).toHaveProperty('authorUserId', null);
    expect(reconstructMessages([nudge('u1')])[0].authorUserId).toBe('u1');
  });

  it('from history: an ordinary user message carries none', () => {
    const typed = row({ id: 'u2', authorType: 'user', authorUserId: 'u1', content: [{ kind: 'text', text: 'hello' }] });
    expect(reconstructMessages([typed])[0]).not.toHaveProperty('authorUserId');
  });

  it('from message.start, keeping silence distinct from null', () => {
    const withNull = applyEventToMsgs([], {
      kind: 'message.start',
      message_id: 'n1',
      author_type: 'user',
      parent_id: null,
      text: CHECKIN_ANSWER_NUDGE,
      author_user_id: null,
    });
    expect(withNull[0]).toHaveProperty('authorUserId', null);
    const silent = applyEventToMsgs([], {
      kind: 'message.start',
      message_id: 'n1',
      author_type: 'user',
      parent_id: null,
      text: CHECKIN_ANSWER_NUDGE,
    });
    expect(silent[0]).not.toHaveProperty('authorUserId');
  });

  it('from a snapshot, with the timed-out decision on its turn', () => {
    const snapshot: StreamSnapshot = {
      messages: [
        {
          message_id: 'a1',
          author_type: 'assistant',
          parent_id: null,
          text: '',
          thinking: '',
          tool_calls: [],
          status: 'complete',
          checkin_decision: { decision: 'continue', by: 'timeout', n: 3, unattended: 1, auto_continues: 2 },
        },
        {
          message_id: 'n1',
          author_type: 'user',
          parent_id: 'a1',
          text: CHECKIN_ANSWER_NUDGE,
          thinking: '',
          tool_calls: [],
          status: 'complete',
          author_user_id: null,
        },
      ],
    };
    const msgs = applySnapshotToMsgs([], snapshot);
    expect(msgs[0].checkinDecision).toMatchObject({ decision: 'continue', by: 'timeout', n: 3 });
    expect(msgs[1]).toHaveProperty('authorUserId', null);
  });

  it('live: a timed-out decision lands on the newest assistant turn, and a person\'s does not', () => {
    const msgs: Message[] = [
      { id: 'a1', role: 'assistant', text: '' },
      { id: 'u1', role: 'user', text: 'x' },
      { id: 'a2', role: 'assistant', text: '' },
    ];
    const timed = applyEventToMsgs(msgs, { kind: 'steps.decision', decision: 'continue', by: 'timeout', n: 4, unattended: 1, auto_continues: 2 });
    expect(timed[2].checkinDecision).toEqual({ decision: 'continue', by: 'timeout', n: 4, unattended: 1, auto_continues: 2 });
    expect(timed[0].checkinDecision).toBeUndefined();
    expect(applyEventToMsgs(msgs, { kind: 'steps.decision', decision: 'continue', by: 'user', n: 4 })).toBe(msgs);
  });
});

describe('usage arrives per request (#193)', () => {
  const turn = {
    prompt_tokens: 1200,
    completion_tokens: 30,
    total_tokens: 1230,
    prompt_tps: null,
    gen_tps: 40,
    total_ms: 900,
    context: {
      used_tokens: 1230,
      parts: [{ category: 'history' as const, tokens: 1230 }],
      history_messages: 2,
      history_limit: 50,
      history_truncated: false,
      window_tokens: 8192,
    },
  };

  it('sets usage from message.usage, on that message only, before its message.end', () => {
    const msgs: Message[] = [
      { id: 'a0', role: 'assistant', text: 'earlier' },
      { id: 'a1', role: 'assistant', text: '' },
    ];
    const next = applyEventToMsgs(msgs, { kind: 'message.usage', message_id: 'a1', usage: turn });
    expect(next[0].usage).toBeUndefined();
    expect(next[1].usage?.in).toBe(1200);
    expect(next[1].usage?.context?.window_tokens).toBe(8192);
    // The message is not ended by it — only told what its request cost.
    expect(next[1].error).toBeUndefined();
    expect(next[1].stopped).toBeUndefined();
  });

  it('keeps it through a message.end from a server that sent none there', () => {
    const withUsage = applyEventToMsgs([{ id: 'a1', role: 'assistant', text: '' }], {
      kind: 'message.usage',
      message_id: 'a1',
      usage: turn,
    });
    const [m] = applyEventToMsgs(withUsage, { kind: 'message.end', message_id: 'a1', status: 'complete' });
    expect(m.usage?.in).toBe(1200);
  });
});
