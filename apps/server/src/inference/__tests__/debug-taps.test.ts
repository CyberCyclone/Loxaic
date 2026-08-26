import { beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage, OpenAiTool, StreamOptions } from "../provider.ts";

/**
 * The mock inference path has to emit the same debug taps a live backend
 * would, or dev mode would be untestable without a GGUF. MOCK_MODE is read at
 * module load, so the provider is imported dynamically after the env is set.
 */
let streamCompletion: (
  model: string,
  messages: ChatMessage[],
  options?: StreamOptions,
) => AsyncGenerator<{ type: string }, void, unknown>;

beforeAll(async () => {
  process.env.MOCK_INFERENCE = "true";
  ({ streamCompletion } = await import("../provider.ts"));
});

const ECHO_TOOL: OpenAiTool = {
  type: "function",
  function: { name: "mockmcp__echo", description: "echo", parameters: { type: "object", properties: {} } },
};

async function drain(messages: ChatMessage[], options: StreamOptions) {
  for await (const _event of streamCompletion("mock", messages, options)) {
    // consumed for its side effects
  }
}

describe("mock inference debug taps", () => {
  it("reports the request body once, including tools", async () => {
    const bodies: unknown[] = [];
    await drain([{ role: "user", content: "hello there" }], {
      tools: [ECHO_TOOL],
      onRequest: (b) => bodies.push(b),
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { messages: ChatMessage[]; tools?: OpenAiTool[]; tool_choice?: string };
    expect(body.messages).toHaveLength(1);
    expect(body.tools?.[0].function.name).toBe("mockmcp__echo");
    expect(body.tool_choice).toBe("auto");
  });

  it("omits tool fields when no tools are offered, matching the live path", async () => {
    const bodies: Record<string, unknown>[] = [];
    await drain([{ role: "user", content: "plain chat" }], {
      onRequest: (b) => bodies.push(b as Record<string, unknown>),
    });
    expect(bodies[0].tools).toBeUndefined();
    expect(bodies[0].tool_choice).toBeUndefined();
  });

  it("emits raw SSE lines for content and terminates with [DONE]", async () => {
    const lines: string[] = [];
    await drain([{ role: "user", content: "hello there" }], { onRawLine: (l) => lines.push(l) });

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.startsWith("data: "))).toBe(true);
    expect(lines.at(-1)).toBe("data: [DONE]");
    const first = JSON.parse(lines[0].slice(6));
    expect(first.choices[0].delta).toHaveProperty("content");
  });

  it("emits a tool_calls frame when the mock decides to call a tool", async () => {
    const lines: string[] = [];
    await drain([{ role: "user", content: "please use mcp echo" }], {
      tools: [ECHO_TOOL],
      onRawLine: (l) => lines.push(l),
    });

    const toolFrame = lines
      .filter((l) => l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)))
      .find((f) => f.choices[0].delta.tool_calls);
    expect(toolFrame).toBeDefined();
    expect(toolFrame.choices[0].delta.tool_calls[0].function.name).toBe("mockmcp__echo");
  });

  it("is inert when no callbacks are supplied", async () => {
    await expect(drain([{ role: "user", content: "hi" }], {})).resolves.toBeUndefined();
  });
});
