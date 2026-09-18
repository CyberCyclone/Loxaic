import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCompletion, type ChatMessage, type OpenAiTool } from "../provider.ts";
import { __resetMockScenariosForTest } from "../mock-scenarios.ts";

/**
 * The mock has to honour `tool_choice: "none"`, because a check-in answered
 * with "answer now" is the one path that depends on it and the mock lane is
 * where that path is tested — e2e included. A mock that called a tool anyway
 * would make the feature look broken in exactly the place it is asserted.
 *
 * The scenario case is the one that actually needed thought: the instruction
 * that turns tools off is itself a user message, so by the time this request
 * goes out `lastUserIndex` has moved and the mock's step counter is back at
 * zero. Consulted in the usual order, a scenario would restart from step one
 * — an infinite supply of tool calls on the request that is meant to be the
 * last.
 */
const todoTool: OpenAiTool = {
  type: "function",
  function: { name: "todo_write", description: "write todos", parameters: { type: "object" } },
};

async function run(messages: ChatMessage[], options: Parameters<typeof streamCompletion>[2]) {
  let text = "";
  let calls: unknown[] = [];
  for await (const event of streamCompletion("mock-model", messages, options)) {
    if (event.type === "done") {
      text = event.result.text;
      calls = event.result.toolCalls;
    }
  }
  return { text, calls };
}

describe("mockStream and tool_choice", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mock-tool-choice-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("MOCK_INFERENCE", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.MOCK_SCENARIOS_FILE;
    __resetMockScenariosForTest();
  });

  it("still calls a tool when nothing says otherwise", async () => {
    const { calls } = await run([{ role: "user", content: "make a todo list" }], { tools: [todoTool] });
    expect(calls).toHaveLength(1);
  });

  it("calls nothing when told not to, even for a prompt that would trigger one", async () => {
    const { text, calls } = await run([{ role: "user", content: "make a todo list" }], {
      tools: [todoTool],
      toolChoice: "none",
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain("without tools");
  });

  it("beats a scenario that still has steps to give", async () => {
    // A scenario step ignores the usual one-call-per-turn rule — that bypass
    // is the whole reason scenarios exist — so it is the one thing that could
    // still produce a tool call on a request that asked for none. The match is
    // written to hit the *nudge* so a scenario really is live at this point;
    // in the ordinary case it would simply not match and the question would
    // never arise.
    const file = path.join(dir, "scenarios.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          match: "final answer",
          steps: [
            { tool: "todo_write", args: { todos: [{ id: "1", text: "one", status: "pending" }] } },
            { tool: "todo_write", args: { todos: [{ id: "1", text: "two", status: "pending" }] } },
          ],
          finalText: "[Mock] walked it.\n",
        },
      ]),
    );
    process.env.MOCK_SCENARIOS_FILE = file;
    __resetMockScenariosForTest();

    const messages: ChatMessage[] = [
      { role: "user", content: "walk the scenario" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "todo_write", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Todo list updated:" },
      { role: "user", content: "Please stop using tools and give your best final answer now." },
    ];

    // Unconstrained, this scenario does fire — which is what makes the
    // assertion below mean something rather than pass by accident.
    expect((await run(messages, { tools: [todoTool] })).calls).toHaveLength(1);
    expect((await run(messages, { tools: [todoTool], toolChoice: "none" })).calls).toHaveLength(0);
  });
});
