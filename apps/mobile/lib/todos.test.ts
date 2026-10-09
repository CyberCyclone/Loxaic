import { describe, expect, it } from 'vitest';
import type { ApiMessage, StreamSnapshot } from '@loxaic/api-client';
import { TODO_STALE_REMINDER } from '@loxaic/types';
import { applyEventToMsgs, applySnapshotToMsgs, reconstructMessages } from './streamMessages';
import { displayedTodos, todoProgress, todosInMessages } from './todos';
import type { Message, ToolCall } from './types';

const OPEN = [
  { id: '1', text: 'Schema', status: 'completed' as const },
  { id: '2', text: 'Routes', status: 'in_progress' as const },
  { id: '3', text: 'Client', status: 'pending' as const },
];
const call = (over: Partial<ToolCall>): ToolCall => ({ tool: 'todo_write', summary: '', result: '', ...over });
const msg = (tools: ToolCall[]): Message => ({ role: 'assistant', text: '', tools });

describe('the list the Inspector shows', () => {
  it('is the newest todo_write in the loaded messages', () => {
    const older = [{ id: '1', text: 'Old', status: 'pending' as const }];
    expect(todosInMessages([msg([call({ todos: older })]), msg([call({ tool: 'bash' })]), msg([call({ todos: OPEN })])])).toEqual(OPEN);
  });

  it('passes over a call the tool refused', () => {
    expect(todosInMessages([msg([call({ todos: OPEN })]), msg([call({ todos: [], ok: false })])])).toEqual(OPEN);
  });

  it('is the last call in a message that wrote twice', () => {
    const first = [{ id: '1', text: 'First', status: 'pending' as const }];
    expect(todosInMessages([msg([call({ todos: first }), call({ todos: OPEN })])])).toEqual(OPEN);
  });

  it('falls back to the server\'s when none is loaded, and is empty when neither has one', () => {
    expect(todosInMessages([msg([call({ tool: 'bash' })])])).toBeNull();
    expect(displayedTodos(null, OPEN)).toEqual(OPEN);
    expect(displayedTodos(null, null)).toEqual([]);
    expect(displayedTodos(null, undefined)).toEqual([]);
    // A loaded list is never older than the server's: history loads newest first.
    expect(displayedTodos([OPEN[0]], OPEN)).toEqual([OPEN[0]]);
  });
});

describe('the Inspector button\'s badge', () => {
  it('counts the items done, not the files changed', () => {
    expect(todoProgress(OPEN)?.label).toBe('1/3');
    expect(todoProgress(OPEN.map((t) => ({ ...t, status: 'completed' as const })))?.label).toBe('3/3');
  });

  it('is not shown without a list', () => {
    expect(todoProgress([])).toBeNull();
  });
});

describe('a todo_write call and the stale reminder, from every path', () => {
  const args = { todos: [{ id: '1', text: 'Schema', status: 'in_progress' }] };
  const output = `Fetched page${TODO_STALE_REMINDER}`;

  it('live: the call carries its list, and the reminder is not in the card', () => {
    let msgs = applyEventToMsgs([], { kind: 'message.start', message_id: 'a1', author_type: 'assistant', parent_id: null });
    msgs = applyEventToMsgs(msgs, { kind: 'tool.call', message_id: 'a1', call_id: 'c1', tool: 'todo_write', args });
    msgs = applyEventToMsgs(msgs, { kind: 'tool.call', message_id: 'a1', call_id: 'c2', tool: 'web_fetch', args: { url: 'x' } });
    msgs = applyEventToMsgs(msgs, { kind: 'tool.result', message_id: 'a1', call_id: 'c2', tool: 'web_fetch', output, ok: false });
    expect(todosInMessages(msgs)).toEqual([{ id: '1', text: 'Schema', status: 'in_progress' }]);
    expect(msgs[0].tools?.[1].result).toBe('Fetched page');
  });

  it('from a snapshot', () => {
    const snapshot = {
      messages: [
        {
          message_id: 'a1',
          author_type: 'assistant',
          parent_id: null,
          text: '',
          thinking: '',
          tool_calls: [
            { call_id: 'c1', tool: 'todo_write', args, output: 'Todo list updated', ok: true },
            { call_id: 'c2', tool: 'web_fetch', args: { url: 'x' }, output, ok: false },
          ],
          status: 'complete',
        },
      ],
    } as unknown as StreamSnapshot;
    const msgs = applySnapshotToMsgs([], snapshot);
    expect(todosInMessages(msgs)?.[0].text).toBe('Schema');
    expect(msgs[0].tools?.[1].result).toBe('Fetched page');
  });

  it('from history', () => {
    const rows = [
      {
        id: 'a1', conversationId: 'c', parentId: null, authorType: 'assistant', model: 'm', lamport: 1,
        content: [
          { kind: 'tool_call', call_id: 'c1', tool: 'todo_write', args },
          { kind: 'tool_call', call_id: 'c2', tool: 'web_fetch', args: { url: 'x' } },
        ],
        status: 'complete', createdAt: '2026-10-10T00:00:00Z',
      },
      {
        id: 't1', conversationId: 'c', parentId: 'a1', authorType: 'tool', model: null, lamport: 2,
        content: [
          { kind: 'tool_result', call_id: 'c1', output: 'Todo list updated', ok: true },
          { kind: 'tool_result', call_id: 'c2', output, ok: false },
        ],
        status: 'complete', createdAt: '2026-10-10T00:00:01Z',
      },
    ] as unknown as ApiMessage[];
    const msgs = reconstructMessages(rows);
    expect(todosInMessages(msgs)?.[0].text).toBe('Schema');
    expect(msgs[0].tools?.[1].result).toBe('Fetched page');
  });
});
