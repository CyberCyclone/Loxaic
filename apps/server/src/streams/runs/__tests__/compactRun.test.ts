import { describe, expect, it } from "vitest";
import { computeCompactionStats, stripImagesForCompaction } from "../compactRun.ts";
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
