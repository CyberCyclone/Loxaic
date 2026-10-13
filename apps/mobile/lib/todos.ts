import type { Todo } from '@loxaic/types';
import type { Message } from '@/lib/types';

/**
 * The agent's newest todo list among the messages loaded: its latest
 * `todo_write` call that the tool did not refuse. Null when none is loaded.
 *
 * Read from the messages rather than kept as a run's state, which is what the
 * list used to be: it went blank on the next turn that did not write one, on
 * switching threads, and after a reload once the run had ended. A call with no
 * result yet counts — the tool accepts a list in milliseconds, and refuses only
 * one with no array, which `ToolCall.todos` never holds.
 */
export function todosInMessages(msgs: readonly Message[]): Todo[] | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const tools = msgs[i].tools ?? [];
    for (let j = tools.length - 1; j >= 0; j--) {
      const call = tools[j];
      if (call.todos && call.ok !== false) return call.todos;
    }
  }
  return null;
}

/**
 * What the server said about the list (`GET /v1/conversations/:id/todos`).
 * `unasked` when nothing needed asking (useServerTodos asks only when no list
 * is loaded and there is history the client does not have, or for an id the
 * server has never seen); `failed` when it could not be asked — the server
 * unreachable, the read refused, an older server.
 */
export type ServerTodos =
  | { status: 'unasked' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'known'; todos: Todo[] | null };

/** What the Inspector shows: a list (empty for none), or why there is none to show. */
export type TodoView = { status: 'list'; todos: Todo[] } | { status: 'loading' } | { status: 'failed' };

/**
 * Whether the server has to be asked for the list: none is loaded, and the
 * history loaded is not all of it — the call that wrote one can be on a page
 * nobody has scrolled back to. With the whole history loaded, no list loaded
 * is the answer, and asking would only cost a query.
 */
export function needsServerTodos(fromMessages: Todo[] | null, historyComplete: boolean): boolean {
  return fromMessages === null && !historyComplete;
}

/**
 * The newest list loaded, else the server's. History arrives newest first, so
 * a loaded list is never older than one on an unloaded page. "Could not ask"
 * stays its own state, never "no list": shown as none, it told someone offline
 * that the agent had no list when it had one.
 */
export function displayedTodos(fromMessages: Todo[] | null, fromServer: ServerTodos): TodoView {
  if (fromMessages) return { status: 'list', todos: fromMessages };
  switch (fromServer.status) {
    case 'known':
      return { status: 'list', todos: fromServer.todos ?? [] };
    case 'unasked':
      return { status: 'list', todos: [] };
    case 'loading':
      return { status: 'loading' };
    case 'failed':
      return { status: 'failed' };
  }
}

/** A server answer, kept with the thread it answers (useServerTodos). */
export interface ServerTodosEntry {
  /** The conversation and how many rewinds it had seen when asked. */
  identity: string;
  value: ServerTodos;
}

/** What to show for `identity` from the answer in hand: another thread's
 * answer, or one from before a rewind, is never this one's. */
export function serverTodosFor(entry: ServerTodosEntry | null, identity: string | null): ServerTodos {
  if (!identity) return { status: 'unasked' };
  return entry?.identity === identity ? entry.value : { status: 'loading' };
}

/** A read that failed. One that already has an answer for the same thread
 * keeps it: the list does not stop existing because the server went away. */
export function afterTodosFailure(entry: ServerTodosEntry | null, identity: string): ServerTodosEntry {
  return entry?.identity === identity && entry.value.status === 'known' ? entry : { identity, value: { status: 'failed' } };
}

/**
 * The Inspector button's badge: how many of the list's items are done. It was
 * the count of changed files, in red, which read as tasks — "8" for a list
 * with one item started. Null when there is no list, so no badge is shown.
 */
export function todoProgress(view: TodoView): { done: number; total: number; label: string } | null {
  if (view.status !== 'list' || view.todos.length === 0) return null;
  const { todos } = view;
  const done = todos.filter((t) => t.status === 'completed').length;
  return { done, total: todos.length, label: `${String(done)}/${String(todos.length)}` };
}
