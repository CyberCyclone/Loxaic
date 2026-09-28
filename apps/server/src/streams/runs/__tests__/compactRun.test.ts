import { describe, expect, it } from "vitest";
import {
  compactionHasRoom,
  compactionRequest,
  computeCompactionStats,
  stripImagesForCompaction,
  summaryHeadroomTokens,
} from "../compactRun.ts";
import type { ChatMessage } from "../../../inference/provider.ts";

/**
 * `saved = before - after`, floored at 0. `after` is exact whenever the
 * backend reported a real completion count; `before` is exact whenever a
 * prior usage record existed to read it from. Either side falling back to an
 * estimate sets `before_estimated` — the UI's honesty flag, not a per-field one.
 */
describe("computeCompactionStats", () => {
  const base = {
    messagesCompacted: 12,
    instructionTokens: 150,
    summaryText: "a".repeat(400), // 400 chars / 4.0 chars-per-token = 100 estimated tokens
  };

  it("the exact path: a real prior usage record and a real completion count", () => {
    const stats = computeCompactionStats({
      ...base,
      lastTurnTokens: 5000,
      promptTokens: 5300, // irrelevant here — before comes from lastTurnTokens, not this
      completionTokens: 600,
    });
    expect(stats).toEqual({
      messages_compacted: 12,
      before_tokens: 5000,
      after_tokens: 600,
      saved_tokens: 4400,
      before_estimated: false,
    });
  });

  it("estimates `before` from prompt_tokens minus the instruction cost when no usage record exists", () => {
    const stats = computeCompactionStats({
      ...base,
      lastTurnTokens: null,
      promptTokens: 1000,
      completionTokens: 250,
    });
    expect(stats.before_tokens).toBe(1000 - 150); // 850
    expect(stats.after_tokens).toBe(250); // completion count is still real
    expect(stats.before_estimated).toBe(true); // one estimated side is enough to flag the whole stat
  });

  it("estimates `after` from the summary's own length when the backend reports no completion count", () => {
    const stats = computeCompactionStats({
      ...base,
      lastTurnTokens: 5000,
      promptTokens: 5300,
      completionTokens: 0,
    });
    expect(stats.before_tokens).toBe(5000); // still exact
    expect(stats.after_tokens).toBe(100); // 400 chars / 4.0
    expect(stats.before_estimated).toBe(true);
  });

  it("floors `before` at 0 rather than going negative when the instruction outweighs the prompt", () => {
    const stats = computeCompactionStats({
      ...base,
      lastTurnTokens: null,
      promptTokens: 100,
      completionTokens: 50,
      instructionTokens: 500,
    });
    expect(stats.before_tokens).toBe(0);
    expect(stats.saved_tokens).toBe(0); // 0 - 50 would be negative — floored
  });

  it("floors `saved_tokens` at 0 when the summary comes out longer than what it replaced", () => {
    const stats = computeCompactionStats({
      ...base,
      lastTurnTokens: 100,
      promptTokens: 100,
      completionTokens: 900, // a bigger completion than the "before" it's replacing
    });
    expect(stats.before_tokens).toBe(100);
    expect(stats.after_tokens).toBe(900);
    expect(stats.saved_tokens).toBe(0);
  });

  it("carries guidance through only when given", () => {
    const withGuidance = computeCompactionStats({
      ...base,
      lastTurnTokens: 100,
      promptTokens: 100,
      completionTokens: 50,
      guidance: "make sure to include the repro steps",
    });
    expect(withGuidance.guidance).toBe("make sure to include the repro steps");

    const without = computeCompactionStats({
      ...base,
      lastTurnTokens: 100,
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(without).not.toHaveProperty("guidance");
  });

  it("passes messages_compacted through untouched", () => {
    const stats = computeCompactionStats({
      ...base,
      messagesCompacted: 47,
      lastTurnTokens: 100,
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(stats.messages_compacted).toBe(47);
  });
});

/**
 * A text-only model choking on stray image parts is exactly the failure this
 * guards against — the summary call must never see one, regardless of what
 * the surface's own history loader handed it.
 */
describe("stripImagesForCompaction", () => {
  it("collapses an image-carrying user message to its text, images before text or not", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          { type: "text", text: "what is this" },
        ],
      },
      { role: "assistant", content: "reply" },
    ];
    expect(stripImagesForCompaction(messages)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "what is this" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("collapses an image-only user message to an empty string, not left as an array", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
    ];
    const [stripped] = stripImagesForCompaction(messages);
    expect(typeof stripped.content).toBe("string");
    expect(stripped.content).toBe("");
  });

  it("leaves a plain-string user message, and non-user roles, untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "just text" },
      { role: "assistant", content: "reply" },
    ];
    expect(stripImagesForCompaction(messages)).toEqual(messages);
  });
});

describe("compactionRequest", () => {
  const shape = {
    model: "m",
    system: "You are Loxaic.",
    tools: [{ type: "function" as const, function: { name: "fs_read", description: "Read", parameters: {} } }],
  };
  const imageTurn: ChatMessage = {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      { type: "text", text: "what is this" },
    ],
  };
  const history = { messages: [imageTurn, { role: "assistant", content: "a cat" } as ChatMessage], summaryText: "Earlier." };

  it("sends the last run's front, the history as replayed, then the instruction — tools kept, not callable", () => {
    const r = compactionRequest({ shape, model: "m", history, instruction: "Summarize.", hasRoom: true });
    expect(r.reusesPrefix).toBe(true);
    expect(r.messages[0]).toEqual({ role: "system", content: "You are Loxaic." });
    expect(r.messages[1]).toMatchObject({ role: "system" }); // the previous summary
    // Images stay: stripping them would rewrite every message after the first.
    expect(r.messages[2]).toBe(imageTurn);
    expect(r.messages.at(-1)).toEqual({ role: "user", content: "Summarize." });
    expect(r.tools).toBe(shape.tools);
    expect(r.toolChoice).toBe("none");
  });

  it("falls back to the stripped request for another model, no shape, or no room for the summary", () => {
    for (const r of [
      compactionRequest({ shape, model: "other", history, instruction: "S", hasRoom: true }),
      compactionRequest({ shape: undefined, model: "m", history, instruction: "S", hasRoom: true }),
      compactionRequest({ shape, model: "m", history, instruction: "S", hasRoom: false }),
    ]) {
      expect(r.reusesPrefix).toBe(false);
      expect(r.tools).toBeUndefined();
      expect(r.messages.some((m) => m.role === "system" && m.content === "You are Loxaic.")).toBe(false);
      expect(r.messages[1]).toEqual({ role: "user", content: "what is this" });
    }
  });

  it("sends no tool choice when the run offered no tools", () => {
    const r = compactionRequest({ shape: { ...shape, tools: [] }, model: "m", history, instruction: "S", hasRoom: true });
    expect(r.tools).toBeUndefined();
    expect(r.toolChoice).toBeUndefined();
  });
});

describe("summaryHeadroomTokens", () => {
  it("is a quarter of the window, up to 8k", () => {
    expect(summaryHeadroomTokens(4096)).toBe(1024);
    expect(summaryHeadroomTokens(32_768)).toBe(8192);
    expect(summaryHeadroomTokens(262_144)).toBe(8192);
  });
});

describe("compactionHasRoom", () => {
  it("has room when the last turn, the instruction and a summary fit the window", () => {
    expect(compactionHasRoom({ windowTokens: 32_768, before: 20_000, instructionTokens: 500 })).toBe(true);
  });

  it("has none when the summary would not fit after them", () => {
    // 8k of headroom for a 32k window: 25k + 500 + 8192 > 32768.
    expect(compactionHasRoom({ windowTokens: 32_768, before: 25_000, instructionTokens: 500 })).toBe(false);
  });

  it("claims none when either figure is unknown — the stripped request is the one more likely to fit", () => {
    // A conversation with no usage row is exactly what every thread on the
    // llama.cpp router was until usage rows stopped failing to write.
    expect(compactionHasRoom({ windowTokens: 32_768, before: null, instructionTokens: 500 })).toBe(false);
    expect(compactionHasRoom({ windowTokens: null, before: 1_000, instructionTokens: 500 })).toBe(false);
  });
});
