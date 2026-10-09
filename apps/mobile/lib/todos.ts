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
 * What the Inspector shows: the newest list loaded, or the server's newest
 * (`latest_todos`) when none is — the call that wrote it can be on a history
 * page nobody has scrolled back to. History arrives newest first, so a loaded
 * list is never older than one on an unloaded page.
 */
export function displayedTodos(fromMessages: Todo[] | null, fromServer: Todo[] | null | undefined): Todo[] {
  return fromMessages ?? fromServer ?? [];
}

/**
 * The Inspector button's badge: how many of the list's items are done. It was
 * the count of changed files, in red, which read as tasks — "8" for a list
 * with one item started. Null when there is no list, so no badge is shown.
 */
export function todoProgress(todos: readonly Todo[]): { done: number; total: number; label: string } | null {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return { done, total: todos.length, label: `${String(done)}/${String(todos.length)}` };
}
