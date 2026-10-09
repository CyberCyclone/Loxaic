import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../inference/provider.ts";
import { TODO_REMINDER_EVERY, TodoStaleness } from "../todo-staleness.ts";

const open = [{ id: "1", text: "Schema", status: "in_progress" as const }, { id: "2", text: "Routes", status: "pending" as const }];
const done = [{ id: "1", text: "Schema", status: "completed" as const }];

/** Runs `n` iterations of ordinary tool work. */
function work(s: TodoStaleness, n: number): void {
  for (let i = 0; i < n; i++) {
    expect(s.due(["bash"])).toBe(false);
    s.endIteration();
  }
}

const call = (name: string, args: unknown): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `c-${name}-${String(Math.random())}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

describe("a stale todo list", () => {
  it("is due after ten tool iterations without a write, while items are unfinished", () => {
    const s = new TodoStaleness();
    s.wrote(open);
    s.endIteration();
    work(s, TODO_REMINDER_EVERY - 1);
    s.endIteration();
    expect(s.due(["fs_edit"])).toBe(true);
  });

  it("is not due again for another ten once reminded", () => {
    const s = new TodoStaleness({ open: true, since: TODO_REMINDER_EVERY });
    expect(s.due(["bash"])).toBe(true);
    s.reminded();
    s.endIteration();
    work(s, TODO_REMINDER_EVERY - 1);
    expect(s.due(["bash"])).toBe(true);
  });

  it("is never due when every item is done, or when there is no list", () => {
    const s = new TodoStaleness();
    work(s, 30);
    s.wrote(done);
    s.endIteration();
    work(s, 30);
  });

  it("starts again from any write", () => {
    const s = new TodoStaleness({ open: true, since: TODO_REMINDER_EVERY - 1 });
    s.wrote(open);
    s.endIteration();
    work(s, TODO_REMINDER_EVERY - 1);
  });

  it("is not owed by an iteration that writes the list itself", () => {
    const s = new TodoStaleness({ open: true, since: 50 });
    expect(s.due(["bash", "todo_write"])).toBe(false);
  });
});

describe("seeded from the replay", () => {
  it("counts the tool iterations since the newest list, across turns", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      call("todo_write", { todos: open }),
      { role: "tool", content: "Todo list updated", tool_call_id: "x" },
      ...Array.from({ length: 4 }, () => call("bash", { command: "ls" })),
      { role: "assistant", content: "done for now" },
      { role: "user", content: "carry on" },
    ];
    const s = TodoStaleness.fromHistory(history);
    work(s, TODO_REMINDER_EVERY - 4 - 1);
    s.endIteration();
    expect(s.due(["bash"])).toBe(true);
  });

  it("reads the newest list's statuses", () => {
    const history = [call("todo_write", { todos: open }), call("todo_write", { todos: done })];
    expect(TodoStaleness.fromHistory(history).due(["bash"])).toBe(false);
    const stale = [call("todo_write", { todos: open }), ...Array.from({ length: TODO_REMINDER_EVERY }, () => call("bash", {}))];
    expect(TodoStaleness.fromHistory(stale).due(["bash"])).toBe(true);
  });

  it("passes over a call the tool refused, to the list before it", () => {
    const history = [
      call("todo_write", { todos: open }),
      ...Array.from({ length: TODO_REMINDER_EVERY - 1 }, () => call("bash", {})),
      call("todo_write", { todos: "not a list" }),
    ];
    expect(TodoStaleness.fromHistory(history).due(["bash"])).toBe(true);
  });

  it("owes nothing for a history with no list", () => {
    expect(TodoStaleness.fromHistory(Array.from({ length: 40 }, () => call("bash", {}))).due(["bash"])).toBe(false);
  });
});
