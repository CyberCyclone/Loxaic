import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { MAX_CACHED_EXTRACTION_BYTES, MAX_EXTRACTED_BYTES } from "@loxaic/types";
import { extractText, readExtractedText, removeExtractedText } from "../extract.ts";
import { attachmentPath } from "../storage.ts";

/**
 * Unit coverage for extractText/removeExtractedText/readExtractedText —
 * previously untested. Mirrors storage.test.ts's own setup: a real mkdtemp
 * UPLOADS_DIR, real files written with writeFileSync at attachmentPath(ref),
 * restored in afterAll.
 */
describe("extractText", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-extract-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(() => {
    process.env.UPLOADS_DIR = dir;
  });

  afterAll(() => {
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips plain text verbatim", async () => {
    const ref = uuid();
    const text = "line one\nline two\nline three\n";
    writeFileSync(attachmentPath(ref), text, "utf8");

    const result = await extractText({ ref, mime: "text/plain", filename: "whatever.txt", userId: "test-user" });

    expect(result.status).toBe("ok");
    expect(await readExtractedText(ref)).toBe(text);
  });

  it("strips tags and scripts from HTML, keeping only the visible text", async () => {
    const ref = uuid();
    const html = "<html><body><script>alert(1)</script><p>Visible text here</p></body></html>";
    writeFileSync(attachmentPath(ref), html, "utf8");

    const result = await extractText({ ref, mime: "text/html", filename: "whatever.html", userId: "test-user" });

    expect(result.status).toBe("ok");
    const cached = await readExtractedText(ref);
    expect(cached).toContain("Visible text here");
    expect(cached).not.toContain("alert(1)");
    expect(cached).not.toContain("<");
  });

  it("caches at MAX_CACHED_EXTRACTION_BYTES, not at the smaller prompt-facing MAX_EXTRACTED_BYTES", async () => {
    // 1 MB: well beyond MAX_EXTRACTED_BYTES (256 KB) but comfortably under
    // MAX_CACHED_EXTRACTION_BYTES (4 MB) — exactly the shape a large
    // document's cached sidecar can now take (regression test for fb0540d).
    const oneMb = 1024 * 1024;
    const ref = uuid();
    writeFileSync(attachmentPath(ref), "x".repeat(oneMb), "utf8");

    const result = await extractText({ ref, mime: "text/plain", filename: "big.txt", userId: "test-user" });

    expect(result.status).toBe("ok");
    expect(result.bytes).toBeGreaterThan(MAX_EXTRACTED_BYTES);
    expect(result.bytes).toBe(oneMb);
    const cached = await readExtractedText(ref);
    expect(Buffer.byteLength(cached ?? "", "utf8")).toBe(oneMb);

    // 5 MB: beyond MAX_CACHED_EXTRACTION_BYTES itself — the cache must be
    // capped at (at most) that ceiling, not left unbounded.
    const fiveMb = 5 * 1024 * 1024;
    const ref2 = uuid();
    writeFileSync(attachmentPath(ref2), "y".repeat(fiveMb), "utf8");

    const result2 = await extractText({ ref: ref2, mime: "text/plain", filename: "huge.txt", userId: "test-user" });

    expect(result2.status).toBe("ok");
    expect(result2.bytes).toBeLessThanOrEqual(MAX_CACHED_EXTRACTION_BYTES);
    const cached2 = await readExtractedText(ref2);
    expect(Buffer.byteLength(cached2 ?? "", "utf8")).toBeLessThanOrEqual(MAX_CACHED_EXTRACTION_BYTES);
  });

  it("fails gracefully on whitespace-only extraction", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), "   \n\n  ", "utf8");

    const result = await extractText({ ref, mime: "text/plain", filename: "blank.txt", userId: "test-user" });

    expect(result).toEqual({ status: "failed", bytes: 0 });
  });

  it("fails gracefully, never throws, when the source file doesn't exist", async () => {
    const ref = uuid(); // never written

    await expect(
      extractText({ ref, mime: "text/plain", filename: "missing.txt", userId: "test-user" }),
    ).resolves.toEqual({ status: "failed", bytes: 0 });
  });

  it("fails gracefully when a document mime has no sandbox available (SANDBOX_MODE=off)", async () => {
    const prevMode = process.env.SANDBOX_MODE;
    process.env.SANDBOX_MODE = "off";
    try {
      const ref = uuid();
      writeFileSync(attachmentPath(ref), "not really a pdf, doesn't matter — sandbox is never reached");

      await expect(
        extractText({ ref, mime: "application/pdf", filename: "doc.pdf", userId: "test-user" }),
      ).resolves.toEqual({ status: "failed", bytes: 0 });
    } finally {
      if (prevMode === undefined) delete process.env.SANDBOX_MODE;
      else process.env.SANDBOX_MODE = prevMode;
    }
  });

  it("is a no-op for image mimes — no sidecar written", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await extractText({ ref, mime: "image/png", filename: "pic.png", userId: "test-user" });

    expect(result).toEqual({ status: "none", bytes: 0 });
    expect(await readExtractedText(ref)).toBeNull();
  });

  it("is a no-op for an unrecognized mime", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), "whatever bytes");

    const result = await extractText({ ref, mime: "application/x-bogus-unknown", filename: "x.bin", userId: "test-user" });

    expect(result).toEqual({ status: "none", bytes: 0 });
    expect(await readExtractedText(ref)).toBeNull();
  });

  it("removeExtractedText / readExtractedText round trip, and a missing sidecar doesn't throw", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), "some content to extract", "utf8");
    await extractText({ ref, mime: "text/plain", filename: "notes.txt", userId: "test-user" });

    expect(await readExtractedText(ref)).toBe("some content to extract");

    await removeExtractedText(ref);
    expect(await readExtractedText(ref)).toBeNull();

    // Removing again (no sidecar left) must resolve cleanly, not throw.
    await expect(removeExtractedText(ref)).resolves.toBeUndefined();
  });
});
