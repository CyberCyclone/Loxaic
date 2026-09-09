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

  it("aborts the slow path the way a real backend's fetch does, rather than replying in full", async () => {
    // The signal used to only cut the sleep short; the whole reply then
    // streamed and the turn ended *complete* — the user got the answer they
    // asked to stop, and the mock lane could not observe cancellation.
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 100);
    const started = Date.now();
    const events: string[] = [];
    await expect(
      (async () => {
        for await (const event of streamCompletion("mock-model", [{ role: "user" as const, content: "take your time" }], {
          signal: controller.signal,
        })) {
          events.push(event.type);
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(events).not.toContain("done");
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
