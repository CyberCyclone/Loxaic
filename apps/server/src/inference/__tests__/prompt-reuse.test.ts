import { beforeEach, describe, expect, it } from "vitest";
import {
  fingerprintPrompt,
  measureReuse,
  recordPrompt,
  resetPromptTraces,
} from "../prompt-reuse.ts";
import type { ChatMessage, OpenAiTool } from "../provider.ts";

const TOOLS: OpenAiTool[] = [
  { type: "function", function: { name: "bash", description: "Run a command.", parameters: { type: "object" } } },
];

const sys: ChatMessage = { role: "system", content: "You are Loxaic." };
const user = (t: string): ChatMessage => ({ role: "user", content: t });
const asst = (t: string): ChatMessage => ({ role: "assistant", content: t });

const CONV = "conv-1";

/** Send a prompt: measure what was reusable, then record its measured size. */
function send(messages: ChatMessage[], promptTokens: number, tools = TOOLS, model = "m1") {
  const fp = fingerprintPrompt(model, messages, tools);
  const reuse = measureReuse(CONV, fp);
  recordPrompt(CONV, fp, promptTokens);
  return reuse;
}

describe("prompt reuse measurement", () => {
  beforeEach(resetPromptTraces);

  it("claims nothing on the first request", () => {
    const r = send([sys, user("hi")], 100);
    // Null, not 0: we have no previous request, so we know nothing either way.
    expect(r.tokens).toBeNull();
    expect(r.previousMessages).toBe(0);
  });

  it("reports the previous request's measured size when this prompt extends it", () => {
    send([sys, user("hi")], 100);
    const r = send([sys, user("hi"), asst("hello"), user("more")], 140);
    expect(r.tokens).toBe(100);
    expect(r.sharedMessages).toBe(2);
    expect(r.previousMessages).toBe(2);
  });

  it("keeps reporting reuse across a chain of turns", () => {
    send([sys, user("a")], 100);
    send([sys, user("a"), asst("b"), user("c")], 140);
    const r = send([sys, user("a"), asst("b"), user("c"), asst("d"), user("e")], 180);
    expect(r.tokens).toBe(140);
  });

  it("reports zero when the oldest message changes — the sliding-window failure", () => {
    send([sys, user("m0"), asst("m1"), user("m2")], 300);
    // A window that re-anchors drops m0, so the prompt no longer starts with
    // the same tokens and nothing after the system message can be reused.
    const r = send([sys, asst("m1"), user("m2"), asst("m3")], 280);
    expect(r.tokens).toBe(0);
    expect(r.sharedMessages).toBe(1); // only the system message survived
    expect(r.previousMessages).toBe(4);
  });

  it("reports zero when a message in the middle of the history is rewritten", () => {
    send([sys, user("a"), asst("b"), user("c")], 300);
    // e.g. an older turn losing its image to the attachment budget.
    const r = send([sys, user("a"), asst("CHANGED"), user("c"), asst("d")], 310);
    expect(r.tokens).toBe(0);
    expect(r.sharedMessages).toBe(2);
  });

  it("reports zero when the toolset changes — tools render into the prompt's front", () => {
    send([sys, user("hi")], 100);
    const more: OpenAiTool[] = [
      ...TOOLS,
      { type: "function", function: { name: "grep", description: "Search.", parameters: { type: "object" } } },
    ];
    const r = send([sys, user("hi"), asst("yo"), user("again")], 160, more);
    expect(r.tokens).toBe(0);
    expect(r.sharedMessages).toBe(0);
  });

  it("reports zero when the model changes — a different cache and tokenizer", () => {
    send([sys, user("hi")], 100);
    const r = send([sys, user("hi"), asst("yo"), user("again")], 160, TOOLS, "m2");
    expect(r.tokens).toBe(0);
  });

  it("never reports reuse larger than the prompt it is measuring", () => {
    // Successive tool-loop iterations only ever append, so the recorded size
    // is always ≤ the next prompt; this guards the invariant the UI divides by.
    send([sys, user("a")], 100);
    const r = send([sys, user("a"), asst("b")], 120);
    expect(r.tokens).toBe(100);
    expect(r.tokens ?? 0).toBeLessThanOrEqual(120);
  });

  it("ignores a request the backend reported no size for", () => {
    send([sys, user("a")], 100);
    // A backend that returns no usage must not overwrite the good anchor with
    // a zero we would later hand out as a reuse count.
    send([sys, user("a"), asst("b")], 0);
    const r = send([sys, user("a"), asst("b"), user("c")], 160);
    expect(r.tokens).toBe(100);
  });

  it("distinguishes messages that differ only in a nested field", () => {
    const withCall: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
    };
    const withOther: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
    };
    send([sys, user("a"), withCall], 200);
    const r = send([sys, user("a"), withOther, user("b")], 210);
    expect(r.tokens).toBe(0);
    expect(r.sharedMessages).toBe(2);
  });
});
