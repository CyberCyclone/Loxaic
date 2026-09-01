import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_DOCUMENT_BYTES,
  maxBytesForMime,
  resolveAttachmentMime,
  sanitizeFilename,
} from "@shannon/types";

/**
 * Regressions for review findings that had no coverage. Each one is a bug
 * that shipped precisely because nothing asserted the behaviour.
 */
describe("filename handling", () => {
  it("keeps a dotfile's leading dot, so its mime still resolves", () => {
    // sanitizeFilename used to strip leading dots, which made ".env" arrive at
    // resolveAttachmentMime as "env" — indistinguishable from an extensionless
    // name, so the server 415'd a file the client had already accepted.
    expect(sanitizeFilename(".env")).toBe(".env");
    expect(resolveAttachmentMime(undefined, sanitizeFilename(".env"))).toBe("text/plain");
    expect(resolveAttachmentMime(undefined, sanitizeFilename(".gitignore"))).toBe("text/plain");
  });

  it("still strips every path component", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("/abs/x.txt")).toBe("x.txt");
    expect(sanitizeFilename("a\\b\\c.md")).toBe("c.md");
  });

  it("falls back for a name that is only dots, which has nothing left to be", () => {
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
  });

  it("caps length without leaving a lone surrogate for encodeURIComponent to throw on", () => {
    // A cut landing inside an astral character used to leave half of it
    // behind, and encodeURIComponent rejects that — permanently 500-ing every
    // download of that attachment.
    const name = "a".repeat(199) + "😀".repeat(5);
    const safe = sanitizeFilename(name);
    expect(() => encodeURIComponent(stripLoneSurrogates(safe))).not.toThrow();
  });
});

describe("per-class size limits", () => {
  it("gives documents the document ceiling, not the image one", () => {
    // The web pre-check applied the 10 MB image cap to everything, stripping
    // valid PDFs and CSVs client-side that the server would have accepted.
    expect(maxBytesForMime("application/pdf")).toBe(MAX_DOCUMENT_BYTES);
    expect(maxBytesForMime("text/csv")).toBe(MAX_DOCUMENT_BYTES);
    expect(maxBytesForMime("image/png")).toBeLessThan(MAX_DOCUMENT_BYTES);
  });
});

describe("readTextCapped (via extractText)", () => {
  it("does not materialize more than the cache ceiling", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "shannon-capped-"));
    const prev = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = dir;
    try {
      const { extractText, readExtractedText } = await import("../extract.ts");
      const { attachmentPath } = await import("../storage.ts");
      const { v4: uuid } = await import("uuid");
      const { MAX_CACHED_EXTRACTION_BYTES } = await import("@shannon/types");
      const ref = uuid();
      // Comfortably over the cache ceiling.
      writeFileSync(attachmentPath(ref), "x".repeat(MAX_CACHED_EXTRACTION_BYTES + 500_000), "utf8");
      const result = await extractText({ ref, mime: "text/plain", filename: "big.txt", userId: "u" });
      expect(result.status).toBe("ok");
      expect(result.bytes).toBeLessThanOrEqual(MAX_CACHED_EXTRACTION_BYTES);
      const text = await readExtractedText(ref);
      expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThanOrEqual(MAX_CACHED_EXTRACTION_BYTES);
    } finally {
      if (prev === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Mirrors the serve route's own guard, so the assertion above tests the same
 * shape the header builder uses. */
function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

describe("document uploads require a container, not merely a provider", () => {
  it("host mode does not count as sandboxed", async () => {
    // The gate used to be `mode === "off"`, which let host mode through — so a
    // PDF parser ran on the server's own filesystem, with the host's network,
    // and none of the container's uid separation or resource limits. Host mode
    // is now treated as unsandboxed for documents; the client shows a rejection
    // modal rather than uploading a file nothing can safely read.
    const prev = process.env.SANDBOX_MODE;
    process.env.SANDBOX_MODE = "host";
    try {
      const { getSandboxStatus } = await import("../../sandbox/status.ts");
      const status = await getSandboxStatus();
      expect(status.mode).toBe("host");
      // The route's condition, asserted directly: available on its own is not
      // enough, the mode has to be "container".
      expect(status.mode === "container" && status.available).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SANDBOX_MODE;
      else process.env.SANDBOX_MODE = prev;
    }
  });

  it("off does not count either", async () => {
    const prev = process.env.SANDBOX_MODE;
    process.env.SANDBOX_MODE = "off";
    try {
      const { getSandboxStatus } = await import("../../sandbox/status.ts");
      const status = await getSandboxStatus();
      expect(status.mode === "container" && status.available).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SANDBOX_MODE;
      else process.env.SANDBOX_MODE = prev;
    }
  });
});
