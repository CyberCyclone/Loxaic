import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCompletion } from "../provider.ts";

/**
 * MOCK_MODE in provider.ts is read at call time (`() =>
 * process.env.MOCK_INFERENCE === "true"`), not cached at module load — so a
 * plain vi.stubEnv per test is enough; no module reset or dynamic re-import
 * needed to see it take effect.
 */
describe("mockStream (via streamCompletion, MOCK_INFERENCE=true)", () => {
  beforeEach(() => {
    vi.stubEnv("MOCK_INFERENCE", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("acknowledges image parts in its reply — proves the full attachment path without a vision GGUF", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } },
          { type: "text" as const, text: "describe it" },
        ],
      },
    ];

    let finalText = "";
    for await (const event of streamCompletion("mock-model", messages, {})) {
      if (event.type === "done") finalText = event.result.text;
    }

    expect(finalText).toContain("Received 1 image(s)");
    expect(finalText).toContain("describe it");
  });

  it("says nothing about images for a plain text-only message", async () => {
    const messages = [{ role: "user" as const, content: "hello" }];

    let finalText = "";
    for await (const event of streamCompletion("mock-model", messages, {})) {
      if (event.type === "done") finalText = event.result.text;
    }

    expect(finalText).not.toContain("image(s)");
    expect(finalText).toContain("hello");
  });
});
