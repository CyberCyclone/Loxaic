import type { Todo } from "./stream-protocol";

/**
 * Appended by the server to a tool result when the run's todo list has gone
 * stale: unfinished items, and ten tool iterations without a `todo_write`
 * (apps/server/src/streams/runs/todo-staleness.ts). A model wrote its list once
 * with item 1 in progress, then did four more items without touching it, and
 * the person watching read item 1 as the one being worked on.
 *
 * On a tool result rather than a new message, so the prompt that carries it is
 * the one stored and replayed — the prefix the backend caches never changes
 * under it. Fixed text, never interpolated, so the client can strip it from the
 * tool card exactly: the person never asked for it and it says nothing about
 * the tool.
 */
export const TODO_STALE_REMINDER =
  "\n\n<todo-reminder>Your todo list has not changed in a while and still has unfinished items. If you have " +
  "started or finished any of them since, update it with todo_write before you carry on.</todo-reminder>";

/** A tool result as the person should see it: without the reminder above. */
export function stripTodoReminder(output: string): string {
  return output.endsWith(TODO_STALE_REMINDER) ? output.slice(0, -TODO_STALE_REMINDER.length) : output;
}

/**
 * The list a `todo_write` call's arguments describe, or null when they do not
 * describe one (no `todos` array — the call the tool refuses). The executor
 * accepts a call with exactly this function, and the client reads a stored
 * call with it, so the list on screen is always the one the agent was told it
 * wrote: an entry without an id is numbered by position, a number or boolean
 * as its text is written out, and a status that is not one of the three reads
 * as pending.
 */
export function parseTodoList(args: unknown): Todo[] | null {
  const raw = args && typeof args === "object" ? (args as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(raw)) return null;
  return raw.map((t: unknown, i) => {
    const item = (t ?? {}) as Record<string, unknown>;
    const status = item.status;
    return {
      id: typeof item.id === "string" ? item.id : String(i + 1),
      text:
        typeof item.text === "string" ? item.text
        : typeof item.text === "number" || typeof item.text === "boolean" ? String(item.text)
        : "",
      status: status === "completed" || status === "in_progress" ? status : "pending",
    };
  });
}

/** Whether a list still has work in it. */
export function hasUnfinishedTodos(todos: readonly Todo[]): boolean {
  return todos.some((t) => t.status !== "completed");
}
