import { describe, expect, it } from "vitest";
import { countImageParts, textOfContent, visionErrorMessage } from "../provider.ts";

describe("textOfContent", () => {
  it("returns a string unchanged", () => {
    expect(textOfContent("hello")).toBe("hello");
  });

  it("joins the text parts of a content-part array, ignoring images", () => {
    const content = [
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } },
      { type: "text" as const, text: "what is this" },
    ];
    expect(textOfContent(content)).toBe("what is this");
  });

  it("returns empty string for null/undefined/no-text-parts", () => {
    expect(textOfContent(null)).toBe("");
    expect(textOfContent(undefined)).toBe("");
    expect(textOfContent([{ type: "image_url", image_url: { url: "x" } }])).toBe("");
  });
});

describe("countImageParts", () => {
  it("counts image_url parts in a content array", () => {
    const content = [
      { type: "image_url" as const, image_url: { url: "a" } },
      { type: "image_url" as const, image_url: { url: "b" } },
      { type: "text" as const, text: "t" },
    ];
    expect(countImageParts(content)).toBe(2);
  });

  it("is 0 for a plain string (or absent) content", () => {
    expect(countImageParts("hello")).toBe(0);
    expect(countImageParts(undefined)).toBe(0);
  });
});

describe("visionErrorMessage", () => {
  it("returns a friendly message when the backend error mentions image support", () => {
    expect(visionErrorMessage("this model does not support image input")).toMatch(/can't see images/i);
    expect(visionErrorMessage("multimodal projector not loaded")).toMatch(/can't see images/i);
    expect(visionErrorMessage("mmproj required for this request")).toMatch(/can't see images/i);
  });

  it("returns null for an unrelated backend error", () => {
    expect(visionErrorMessage("connection refused")).toBeNull();
    expect(visionErrorMessage("context window exceeded")).toBeNull();
  });
});
