import { describe, expect, it } from 'vitest';
import type { ApiMessage, StreamSnapshot } from '@loxaic/api-client';
import { TODO_STALE_REMINDER } from '@loxaic/types';
import { applyEventToMsgs, applySnapshotToMsgs, reconstructMessages } from './streamMessages';
import { afterTodosFailure, displayedTodos, needsServerTodos, serverTodosFor, todoProgress, todosInMessages } from './todos';
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
    expect(displayedTodos(null, { status: 'known', todos: OPEN })).toEqual({ status: 'list', todos: OPEN });
    expect(displayedTodos(null, { status: 'known', todos: null })).toEqual({ status: 'list', todos: [] });
    // Nothing needed asking: the whole history is loaded and holds none.
    expect(displayedTodos(null, { status: 'unasked' })).toEqual({ status: 'list', todos: [] });
    // A loaded list is never older than the server's: history loads newest first.
    expect(displayedTodos([OPEN[0]], { status: 'known', todos: OPEN })).toEqual({ status: 'list', todos: [OPEN[0]] });
  });

  it('keeps "could not ask" apart from "none"', () => {
    expect(displayedTodos(null, { status: 'failed' })).toEqual({ status: 'failed' });
    expect(displayedTodos(null, { status: 'loading' })).toEqual({ status: 'loading' });
    // A loaded list needs no server.
    expect(displayedTodos(OPEN, { status: 'failed' })).toEqual({ status: 'list', todos: OPEN });
  });
});

describe('asking the server for the list', () => {
  it('only when none is loaded and the history loaded is not all of it', () => {
    expect(needsServerTodos(null, false)).toBe(true);
    expect(needsServerTodos(null, true)).toBe(false);
    expect(needsServerTodos(OPEN, false)).toBe(false);
  });

  it('shows an answer only for the thread, and the rewind count, it was asked for', () => {
    const entry = { identity: 'c1|0', value: { status: 'known' as const, todos: OPEN } };
    expect(serverTodosFor(entry, 'c1|0')).toEqual(entry.value);
    // After a rewind the old answer may be a list the rewind removed.
    expect(serverTodosFor(entry, 'c1|1')).toEqual({ status: 'loading' });
    expect(serverTodosFor(entry, 'c2|0')).toEqual({ status: 'loading' });
    expect(serverTodosFor(entry, null)).toEqual({ status: 'unasked' });
  });

  it('keeps an answer in hand when a later read fails, and says so when there is none', () => {
    const known = { identity: 'c1|0', value: { status: 'known' as const, todos: OPEN } };
    expect(afterTodosFailure(known, 'c1|0')).toBe(known);
    expect(afterTodosFailure(known, 'c1|1')).toEqual({ identity: 'c1|1', value: { status: 'failed' } });
    expect(afterTodosFailure(null, 'c1|0')).toEqual({ identity: 'c1|0', value: { status: 'failed' } });
  });
});

describe('the Inspector button\'s badge', () => {
  it('counts the items done, not the files changed', () => {
    expect(todoProgress({ status: 'list', todos: OPEN })?.label).toBe('1/3');
    expect(todoProgress({ status: 'list', todos: OPEN.map((t) => ({ ...t, status: 'completed' as const })) })?.label).toBe('3/3');
  });

  it('is not shown without a list', () => {
    expect(todoProgress({ status: 'list', todos: [] })).toBeNull();
    expect(todoProgress({ status: 'failed' })).toBeNull();
    expect(todoProgress({ status: 'loading' })).toBeNull();
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
