import { describe, expect, it, vi } from "vitest";
import { oneSystemMessageFirst, type ChatMessage } from "../provider.ts";

describe("oneSystemMessageFirst", () => {
  it("returns a conforming prompt untouched, the same array", () => {
    for (const messages of [
      [],
      [{ role: "user", content: "hi" }],
      [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
    ] as ChatMessage[][]) {
      expect(oneSystemMessageFirst(messages)).toBe(messages);
    }
  });

  it("merges every system message, in order, into one at the front", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      oneSystemMessageFirst([
        { role: "system", content: "S" },
        { role: "user", content: "a" },
        { role: "system", content: "T" },
        { role: "assistant", content: "b" },
      ]),
    ).toEqual([
      { role: "system", content: "S\n\nT" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    // A system message that is not first at all moves to the front.
    expect(oneSystemMessageFirst([{ role: "user", content: "a" }, { role: "system", content: "T" }])).toEqual([
      { role: "system", content: "T" },
      { role: "user", content: "a" },
    ]);
    // Said, so a caller that skipped promptFront shows up in the log.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
