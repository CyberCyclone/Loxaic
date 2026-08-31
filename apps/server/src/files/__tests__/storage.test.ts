import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { MAX_EXTRACTED_BYTES } from "@shannon/types";
import {
  MAX_HISTORY_IMAGE_BYTES,
  attachmentContentParts,
  attachmentPath,
  attachmentTextPath,
  isValidRef,
  readAsDataUri,
  selectAffordableAttachments,
  sniffMime,
} from "../storage.ts";

describe("isValidRef", () => {
  it("accepts a well-formed uuid", () => {
    expect(isValidRef(uuid())).toBe(true);
  });

  it.each(["../../etc/passwd", "not-a-uuid", "", "12345678-1234-1234-1234-12345678901"])(
    "rejects %j — including path-traversal attempts",
    (ref) => {
      expect(isValidRef(ref)).toBe(false);
    },
  );

  // `RegExp.test` stringifies its argument, so a single-element array of a
  // valid uuid coerces straight back to that uuid and would otherwise pass —
  // and `refs: string[]` off a socket is a claim, not a fact. Without the
  // typeof guard this reached the uuid-typed query and surfaced a raw
  // Postgres error to the client.
  it.each([
    [[uuid()]],
    [[[uuid()]]],
    [{ toString: () => uuid() }],
    [null],
    [undefined],
    [42],
    [{}],
  ])("rejects the non-string value %j rather than coercing it", (ref) => {
    expect(isValidRef(ref)).toBe(false);
  });
});

describe("attachmentPath", () => {
  it("throws rather than joining an invalid ref onto the uploads dir", () => {
    expect(() => attachmentPath("../../etc/passwd")).toThrow();
  });
});

describe("readAsDataUri / attachmentContentParts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shannon-uploads-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(() => {
    process.env.UPLOADS_DIR = dir;
  });

  afterAll(() => {
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips stored bytes as a base64 data URI", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), Buffer.from("hello image bytes"));

    const dataUri = await readAsDataUri(ref, "image/png");
    expect(dataUri).toBe(`data:image/png;base64,${Buffer.from("hello image bytes").toString("base64")}`);
  });

  it("builds content parts with images first, then trailing text", async () => {
    const ref1 = uuid();
    const ref2 = uuid();
    writeFileSync(attachmentPath(ref1), Buffer.from("a"));
    writeFileSync(attachmentPath(ref2), Buffer.from("b"));

    const parts = await attachmentContentParts(
      [{ ref: ref1, mime: "image/jpeg" }, { ref: ref2, mime: "image/png" }],
      "what is this",
    );

    expect(parts).toEqual([
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("a").toString("base64")}` } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("b").toString("base64")}` } },
      { type: "text", text: "what is this" },
    ]);
  });

  it("degrades a missing file to a text marker instead of failing the whole run", async () => {
    const parts = await attachmentContentParts([{ ref: uuid(), mime: "image/png" }], "");
    expect(parts).toEqual([{ type: "text", text: "[image unavailable]" }]);
  });

  it("omits the text part entirely for an image-only message", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), Buffer.from("x"));
    const parts = await attachmentContentParts([{ ref, mime: "image/png" }], "");
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("image_url");
  });

  it("collapses a repeated ref to one part — the same image twice costs 2x for nothing", async () => {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), Buffer.from("dup"));
    const parts = await attachmentContentParts(
      [{ ref, mime: "image/png" }, { ref, mime: "image/png" }, { ref, mime: "image/png" }],
      "",
    );
    expect(parts).toHaveLength(1);
  });

  it("replaces a ref outside the budget with a marker instead of reading it", async () => {
    const kept = uuid();
    const dropped = uuid();
    writeFileSync(attachmentPath(kept), Buffer.from("keep"));
    writeFileSync(attachmentPath(dropped), Buffer.from("drop"));

    const parts = await attachmentContentParts(
      [{ ref: dropped, mime: "image/png" }, { ref: kept, mime: "image/png" }],
      "hi",
      new Set([kept]),
    );

    expect(parts).toEqual([
      { type: "text", text: "[image omitted: over this prompt's image budget]" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("keep").toString("base64")}` } },
      { type: "text", text: "hi" },
    ]);
  });
});

describe("attachmentContentParts — document truncation and overflow handling", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shannon-doc-truncation-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(() => {
    process.env.UPLOADS_DIR = dir;
  });

  afterAll(() => {
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeExtraction(bytes: number): { ref: string; text: string } {
    const ref = uuid();
    const text = "x".repeat(bytes);
    writeFileSync(attachmentTextPath(ref), text, "utf8");
    return { ref, text };
  }

  it("truncates a document's text to MAX_EXTRACTED_BYTES before wrapping it", async () => {
    const { ref } = writeExtraction(MAX_EXTRACTED_BYTES + 1000);
    const parts = await attachmentContentParts([{ ref, mime: "application/pdf", name: "big.pdf" }], "");
    expect(parts).toHaveLength(1);
    const part = parts[0] as { type: "text"; text: string };
    expect(part.type).toBe("text");
    // The body between the markers must be capped at MAX_EXTRACTED_BYTES,
    // not the full on-disk cache.
    expect(Buffer.byteLength(part.text, "utf8")).toBeLessThan(MAX_EXTRACTED_BYTES + 1000);
    expect(part.text).toContain("truncated at");
  });

  it("does not truncate and never calls onOverflow when the text fits", async () => {
    const { ref, text } = writeExtraction(100);
    const onOverflow = vi.fn();
    const parts = await attachmentContentParts(
      [{ ref, mime: "application/pdf", name: "small.pdf" }],
      "",
      undefined,
      onOverflow,
    );
    const part = parts[0] as { type: "text"; text: string };
    expect(part.text).toContain(text);
    expect(part.text).not.toContain("truncated at");
    expect(onOverflow).toHaveBeenCalledTimes(0);
  });

  it("calls onOverflow with the FULL untruncated text and includes its returned path in the note", async () => {
    const { ref, text } = writeExtraction(MAX_EXTRACTED_BYTES + 5000);
    const onOverflow = vi.fn().mockResolvedValue("./attachments/abc-big.pdf.txt");
    const parts = await attachmentContentParts(
      [{ ref, mime: "application/pdf", name: "big.pdf" }],
      "",
      undefined,
      onOverflow,
    );
    expect(onOverflow).toHaveBeenCalledTimes(1);
    const [, fullTextArg] = onOverflow.mock.calls[0] as [unknown, string];
    expect(fullTextArg.length).toBe(text.length);
    const part = parts[0] as { type: "text"; text: string };
    expect(part.text).toContain("./attachments/abc-big.pdf.txt");
  });

  it("when overflowed with no onOverflow given, the note has no path", async () => {
    const { ref } = writeExtraction(MAX_EXTRACTED_BYTES + 5000);
    const parts = await attachmentContentParts([{ ref, mime: "application/pdf", name: "big.pdf" }], "");
    const part = parts[0] as { type: "text"; text: string };
    expect(part.text).toContain("truncated at");
    expect(part.text).not.toContain("Full text is at");
  });
});

/**
 * The per-prompt image budget. Without it, HISTORY_LIMIT (50) multiplies the
 * per-send caps: a thread of image-bearing turns makes every later send
 * re-read and base64 the lot into one JSON body, which is heap exhaustion on
 * demand for the price of one WebSocket frame.
 */
describe("selectAffordableImages", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shannon-budget-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(() => {
    process.env.UPLOADS_DIR = dir;
  });

  afterAll(() => {
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function write(bytes: number): string {
    const ref = uuid();
    writeFileSync(attachmentPath(ref), Buffer.alloc(bytes, 1));
    return ref;
  }

  it("admits everything when the whole history fits", async () => {
    const a = write(16);
    const b = write(16);
    const allowed = await selectAffordableAttachments([
      [{ ref: a, mime: "image/png" }],
      [{ ref: b, mime: "image/png" }],
    ]);
    expect(allowed).toEqual(new Set([a, b]));
  });

  it("spends the budget newest-first, so the turn being asked about survives", async () => {
    const oldRef = write(MAX_HISTORY_IMAGE_BYTES);
    const newRef = write(MAX_HISTORY_IMAGE_BYTES);
    // Oldest-first input, mirroring prompt assembly order.
    const allowed = await selectAffordableAttachments([
      [{ ref: oldRef, mime: "image/png" }],
      [{ ref: newRef, mime: "image/png" }],
    ]);
    expect(allowed.has(newRef)).toBe(true);
    expect(allowed.has(oldRef)).toBe(false);
  });

  it("skips an oversized image rather than ending the walk, so smaller older ones still fit", async () => {
    const small = write(32);
    const huge = write(MAX_HISTORY_IMAGE_BYTES + 1);
    const allowed = await selectAffordableAttachments([
      [{ ref: small, mime: "image/png" }],
      [{ ref: huge, mime: "image/png" }],
    ]);
    expect(allowed).toEqual(new Set([small]));
  });

  it("charges a repeated ref once", async () => {
    const ref = write(MAX_HISTORY_IMAGE_BYTES);
    const allowed = await selectAffordableAttachments([
      [{ ref, mime: "image/png" }],
      [{ ref, mime: "image/png" }],
    ]);
    expect(allowed).toEqual(new Set([ref]));
  });

  it("leaves an unreadable ref out, to degrade downstream as [image unavailable]", async () => {
    const allowed = await selectAffordableAttachments([[{ ref: uuid(), mime: "image/png" }]]);
    expect(allowed.size).toBe(0);
  });
});

/**
 * Two document-budget fixes, covered together because the second only shows
 * up correctly once the first is in place.
 *
 * (1) selectAffordableAttachments used to stat the full cached sidecar
 * directly. Now that extraction caches up to MAX_CACHED_EXTRACTION_BYTES
 * (4 MB) instead of MAX_EXTRACTED_BYTES (256 KB), budgeting against the raw
 * file size would wildly overestimate a document's prompt cost. The fix caps
 * the byte count fed to estimateTokens at MAX_EXTRACTED_BYTES, since that's
 * all attachmentContentParts ever actually sends.
 *
 * (2) MAX_HISTORY_DOCUMENT_TOKENS was a flat 24,000 — smaller than a single
 * document at MAX_EXTRACTED_BYTES already costs (~65,536 est. tokens). Fix
 * (1) alone would have made that worse, not better: capping the measurement
 * at the per-document ceiling doesn't help when the *whole-history* budget is
 * already below that ceiling — every document at or near the cap would still
 * be excluded, including the one from the turn that just sent it. Both fixes
 * together are what makes "a single document at the cap always survives"
 * true, mirroring MAX_HISTORY_IMAGE_BYTES's own property for images. The
 * budget is now MAX_SINGLE_DOCUMENT_TOKENS * 3, so it takes several
 * max-sized documents across a history — not one — to start losing anything,
 * and the walk being newest-first means what gets dropped is always the
 * oldest one.
 */
describe("selectAffordableAttachments — documents", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shannon-doc-budget-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(() => {
    process.env.UPLOADS_DIR = dir;
  });

  afterAll(() => {
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeExtraction(bytes: number): string {
    const ref = uuid();
    writeFileSync(attachmentTextPath(ref), "x".repeat(bytes), "utf8");
    return ref;
  }

  it("admits a single document even when its cached sidecar is far larger than MAX_EXTRACTED_BYTES", async () => {
    // Well beyond MAX_EXTRACTED_BYTES (256 KB) but under MAX_CACHED_EXTRACTION_BYTES
    // (4 MB) — exactly the shape a large document's sidecar can now take.
    // Its *measured* cost is capped at one document's worth, which the budget
    // is sized to always clear on its own — this is the regression guard for
    // both fixes at once: an uncapped measurement here would exceed the
    // budget by roughly 16x, and a budget still sized at the old flat 24,000
    // would reject this even after capping.
    const ref = writeExtraction(MAX_EXTRACTED_BYTES * 4);
    const allowed = await selectAffordableAttachments([[{ ref, mime: "application/pdf" }]]);
    expect(allowed.has(ref)).toBe(true);
  });

  it("admits a small document unaffected by the cap either way", async () => {
    const ref = writeExtraction(1000);
    const allowed = await selectAffordableAttachments([[{ ref, mime: "application/pdf" }]]);
    expect(allowed.has(ref)).toBe(true);
  });

  it("drops the oldest document once several turns' worth exceed the whole-history budget", async () => {
    // Four documents each at the per-document cap cost roughly 4x
    // MAX_SINGLE_DOCUMENT_TOKENS, comfortably over the 3x budget — so exactly
    // one must be dropped, and the newest-first walk means it's the oldest.
    const refs = [writeExtraction(MAX_EXTRACTED_BYTES), writeExtraction(MAX_EXTRACTED_BYTES),
      writeExtraction(MAX_EXTRACTED_BYTES), writeExtraction(MAX_EXTRACTED_BYTES)];
    const allowed = await selectAffordableAttachments(
      refs.map((ref) => [{ ref, mime: "application/pdf" }]),
    );
    expect(allowed.has(refs[0])).toBe(false);
    expect(allowed.has(refs[1])).toBe(true);
    expect(allowed.has(refs[2])).toBe(true);
    expect(allowed.has(refs[3])).toBe(true);
  });
});

describe("sniffMime", () => {
  it("recognizes JPEG, PNG, GIF, and WebP magic bytes", () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffMime(Buffer.concat([Buffer.from("RIFF____"), Buffer.from("WEBP")]))).toBe("image/webp");
  });

  it("recognizes a PDF header", () => {
    expect(sniffMime(Buffer.from("%PDF-1.4"))).toBe("application/pdf");
  });

  it("returns null for anything without a recognized signature", () => {
    expect(sniffMime(Buffer.from("<svg></svg>"))).toBeNull();
    // Text formats have no magic bytes at all, so they are deliberately not
    // sniffable — verifyStoredBytes decides those by decoding instead.
    expect(sniffMime(Buffer.from("name,total\n"))).toBeNull();
    expect(sniffMime(Buffer.from("# heading"))).toBeNull();
  });
});
