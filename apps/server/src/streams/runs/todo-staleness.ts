import { hasUnfinishedTodos, parseTodoList } from "@loxaic/types";
import type { ChatMessage } from "../../inference/provider.ts";

/** Tool iterations without a `todo_write` before a list with unfinished items
 * is called stale, and again between reminders. */
export const TODO_REMINDER_EVERY = 10;

/**
 * Whether the run's todo list has gone stale, and so whether this iteration's
 * first tool result should carry `TODO_STALE_REMINDER`.
 *
 * Stale means: the newest list still has unfinished items, and the agent has
 * run `TODO_REMINDER_EVERY` tool iterations since it last wrote one. Nothing is
 * said about a run that never wrote a list — nobody is reading one — or about a
 * list whose every item is done.
 *
 * Pure, and seeded from the history the run replays, so a list written in an
 * earlier turn still counts: a turn is often where the list was made and the
 * next one where the work happens. The seed only reaches back as far as the
 * replay does (to the newest compaction); a list older than that is in the
 * summary, not in front of the model, and is not reminded about.
 */
export class TodoStaleness {
  private open: boolean;
  private since: number;
  private wroteThisIteration = false;

  constructor(seed: { open: boolean; since: number } = { open: false, since: 0 }) {
    this.open = seed.open;
    this.since = seed.since;
  }

  /** The newest list in `messages` and how many tool iterations have run since
   * it was written, counted in assistant messages that called tools. */
  static fromHistory(messages: readonly ChatMessage[]): TodoStaleness {
    let since = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || !m.tool_calls?.length) continue;
      const writes = m.tool_calls.filter((c) => c.function.name === "todo_write");
      const last = writes.at(-1);
      if (last) {
        const todos = parseTodoList(safeParse(last.function.arguments));
        // A call the tool refused is not a list; keep looking further back.
        if (todos) return new TodoStaleness({ open: hasUnfinishedTodos(todos), since });
      }
      since++;
    }
    return new TodoStaleness();
  }

  /** Whether this iteration should remind — asked before its calls run. An
   * iteration that writes the list itself needs no reminder. */
  due(callNames: readonly string[]): boolean {
    return this.open && this.since >= TODO_REMINDER_EVERY && !callNames.includes("todo_write");
  }

  /** The reminder went out: the count starts again, so it repeats at most
   * every `TODO_REMINDER_EVERY` iterations rather than on every one. */
  reminded(): void {
    this.since = 0;
  }

  /** A `todo_write` the tool accepted. */
  wrote(todos: Parameters<typeof hasUnfinishedTodos>[0]): void {
    this.open = hasUnfinishedTodos(todos);
    this.since = 0;
    this.wroteThisIteration = true;
  }

  /** An iteration's tools have all run. */
  endIteration(): void {
    if (!this.wroteThisIteration) this.since++;
    this.wroteThisIteration = false;
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
