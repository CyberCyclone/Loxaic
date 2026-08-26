import { describe, expect, it } from "vitest";
import { addChars, apportion, tallyChatMessages, type ContextTally } from "../context.ts";
import type { ChatMessage, OpenAiTool } from "../provider.ts";

const META = { historyMessages: 4, historyLimit: 50, historyTruncated: false };

const sumParts = (parts: { tokens: number }[]) => parts.reduce((s, p) => s + p.tokens, 0);

describe("apportion", () => {
  it("sums to used_tokens exactly", () => {
    const tally: ContextTally = { system: 500, tools: 4000, history: 12_000, current: 80 };
    const result = apportion(tally, 4096, 512, META);

    expect(result.used_tokens).toBe(4608);
    expect(sumParts(result.parts)).toBe(4608);
  });

  it("sums exactly across fuzzed tallies — the property the UI self-check relies on", () => {
    // Deterministic LCG: a failing case has to be reproducible.
    let seed = 1337;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

    for (let i = 0; i < 500; i++) {
      const tally: ContextTally = {
        system: rand(2000),
        tools: rand(8000),
        history: rand(50_000),
        reasoning: rand(20_000),
        tool_io: rand(40_000),
        current: rand(1000),
      };
      const promptTokens = rand(32_000);
      const completionTokens = rand(4000);

      const result = apportion(tally, promptTokens, completionTokens, META);

      expect(result.used_tokens).toBe(promptTokens + completionTokens);
      expect(sumParts(result.parts)).toBe(result.used_tokens);
      // The residual is folded into the largest part, never into a negative.
      for (const part of result.parts) expect(part.tokens).toBeGreaterThanOrEqual(0);
    }
  });

  it("omits zero-char categories rather than emitting them as 0", () => {
    const result = apportion({ history: 4000, tools: 0, reasoning: 0 }, 1000, 100, META);
    const categories = result.parts.map((p) => p.category);

    expect(categories).toContain("history");
    expect(categories).not.toContain("tools");
    expect(categories).not.toContain("reasoning");
  });

  it("weights dense categories higher than prose for the same char count", () => {
    // Equal characters, but tool JSON tokenises denser than prose, so it must
    // be attributed more tokens. This is the whole reason for the weighting.
    const result = apportion({ history: 10_000, tools: 10_000 }, 5000, 0, META);
    const history = result.parts.find((p) => p.category === "history");
    const tools = result.parts.find((p) => p.category === "tools");
    if (!history || !tools) throw new Error("expected history and tools parts");

    expect(tools.tokens).toBeGreaterThan(history.tokens);
  });

  it("survives an empty tally without dividing by zero", () => {
    const result = apportion({}, 0, 0, META);

    expect(result.parts).toEqual([]);
    expect(result.used_tokens).toBe(0);
  });

  it("keeps used_tokens truthful when the backend reported no prompt usage", () => {
    // Nothing to apportion, but the response was still measured.
    const result = apportion({ history: 4000 }, 0, 250, META);

    expect(result.used_tokens).toBe(250);
    expect(result.parts).toEqual([{ category: "response", tokens: 250 }]);
  });

  it("carries the assembly metadata through", () => {
    const result = apportion({ history: 100 }, 50, 10, {
      historyMessages: 50,
      historyLimit: 50,
      historyTruncated: true,
      windowTokens: 8192,
    });

    expect(result.history_truncated).toBe(true);
    expect(result.history_messages).toBe(50);
    expect(result.window_tokens).toBe(8192);
  });

  it("reports a null window when the backend wouldn't say", () => {
    expect(apportion({ history: 100 }, 50, 10, META).window_tokens).toBeNull();
  });
});

describe("addChars", () => {
  it("accumulates and ignores empty input", () => {
    const tally: ContextTally = {};
    addChars(tally, "history", "hello");
    addChars(tally, "history", " world");
    addChars(tally, "history", null);
    addChars(tally, "history", undefined);
    addChars(tally, "history", "");

    expect(tally.history).toBe(11);
  });
});

describe("tallyChatMessages", () => {
  const tools: OpenAiTool[] = [
    { type: "function", function: { name: "read_file", description: "Read a file", parameters: { a: 1 } } },
  ];

  it("puts the last user message in `current` and earlier ones in `history`", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second-and-last" },
    ];
    const tally = tallyChatMessages(messages);

    expect(tally.current).toBe("second-and-last".length);
    expect(tally.history).toBe("first".length + "reply".length);
  });

  it("counts tool schemas that never appear in `messages`", () => {
    const tally = tallyChatMessages([{ role: "user", content: "hi" }], tools);

    expect(tally.tools).toBe(JSON.stringify(tools).length);
  });

  it("attributes tool calls and tool results to tool_io", () => {
    const toolCalls = [{ id: "c1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }];
    const messages: ChatMessage[] = [
      { role: "system", content: "be helpful" },
      { role: "user", content: "read it" },
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", content: "file contents here", tool_call_id: "c1" },
    ];
    const tally = tallyChatMessages(messages);

    expect(tally.system).toBe("be helpful".length);
    expect(tally.tool_io).toBe(JSON.stringify(toolCalls).length + "file contents here".length);
  });

  it("lands agent tool schemas in a realistic token range", () => {
    // A brand-new agent run: system prompt, one short message, eight tools.
    // The point of the feature is that `tools` is already a large slice before
    // the user has said anything of substance.
    const eightTools: OpenAiTool[] = Array.from({ length: 8 }, (_, i) => ({
      type: "function" as const,
      function: {
        name: `tool_${String(i)}`,
        description: "A tool that does a thing, described in a sentence or two of prose.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Path to operate on" } },
          required: ["path"],
        },
      },
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: "You are an agent.".repeat(20) },
      { role: "user", content: "list the files" },
    ];

    const tally = tallyChatMessages(messages, eightTools);
    const result = apportion(tally, 1600, 40, { ...META, historyMessages: 0 });
    const toolsPart = result.parts.find((p) => p.category === "tools");
    if (!toolsPart) throw new Error("expected a tools part");

    expect(toolsPart.tokens).toBeGreaterThan(1000);
    expect(toolsPart.tokens).toBeLessThan(1500);
  });
});
