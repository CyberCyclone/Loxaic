import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { MAX_EXTRACTED_BYTES } from "@loxaic/types";
import {
  MAX_HISTORY_IMAGE_BYTES,
  attachmentContentParts,
  attachmentPath,
  attachmentTextPath,
  isDecodableText,
  isValidRef,
  readAsDataUri,
  selectAffordableAttachments,
  sniffMime,
  verifyStoredBytes,
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
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-uploads-test-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-doc-truncation-test-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-budget-test-"));
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

  it("keeps the just-sent image even when an older one has already filled the budget", async () => {
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

  it("admits an unreadable ref so it degrades as [image unavailable], not as a budget drop", async () => {
    // The name this test always had, now actually true. It used to assert the
    // opposite — that a missing file is left *out* of the allowed set — which
    // sent it down attachmentContentParts' `!allowed.has(ref)` branch and told
    // the model "over this prompt's image budget" about a file that is not on
    // disk. It never reached the "[image unavailable]" the name promised.
    //
    // It matters more now that the same verdict is shown to the user, where
    // the accompanying advice is given in the imperative and cannot help. The
    // document branch has always drawn this distinction; this is the image
    // branch catching up. Admitting costs no budget — there are no bytes to
    // charge — so it cannot crowd out a file that is really there.
    const ref = uuid();
    const allowed = await selectAffordableAttachments([[{ ref, mime: "image/png" }]]);
    expect(allowed.has(ref)).toBe(true);
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
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-doc-budget-test-"));
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

  it("drops from the middle once several turns' worth exceed the whole-history budget", async () => {
    // Four documents each at the per-document cap cost roughly 4x
    // MAX_SINGLE_DOCUMENT_TOKENS, over the 3x budget — so one must go.
    //
    // It is deliberately not the oldest. Dropping by recency requires a new
    // attachment to evict an older one, which rewrites a message the model has
    // already been shown and throws away the backend's cached prefix from that
    // message onward. History is therefore spent oldest-first (turns 0 and 1
    // fill the 2x history pool, turn 2 no longer fits) while the just-sent
    // turn keeps its own reserve.
    const refs = [writeExtraction(MAX_EXTRACTED_BYTES), writeExtraction(MAX_EXTRACTED_BYTES),
      writeExtraction(MAX_EXTRACTED_BYTES), writeExtraction(MAX_EXTRACTED_BYTES)];
    const allowed = await selectAffordableAttachments(
      refs.map((ref) => [{ ref, mime: "application/pdf" }]),
    );
    expect(allowed.has(refs[0])).toBe(true);
    expect(allowed.has(refs[1])).toBe(true);
    expect(allowed.has(refs[2])).toBe(false);
    expect(allowed.has(refs[3])).toBe(true);
  });

  it("never revises an older turn's verdict when a new turn arrives", async () => {
    // The invariant the whole oldest-first split exists for. Growing the
    // conversation one attachment-bearing turn at a time must only ever *add*
    // to what the earlier turns contributed — anything else rewrites a message
    // the model already saw, and the backend re-evaluates the prompt from that
    // point on. Under the old newest-first walk this failed at the third turn.
    const refs = Array.from({ length: 6 }, () => writeExtraction(MAX_EXTRACTED_BYTES));
    const turns = refs.map((ref) => [{ ref, mime: "application/pdf" }]);

    let previous: Set<string> | null = null;
    for (let n = 1; n <= turns.length; n++) {
      const allowed = await selectAffordableAttachments(turns.slice(0, n));
      if (previous) {
        // Every turn before the newest two keeps exactly the verdict it had.
        // The second-newest is the one exception by design: it moves from the
        // current-turn reserve into the history pool, which is a single
        // message at the very end of the prompt.
        for (let i = 0; i < n - 2; i++) {
          expect(allowed.has(refs[i])).toBe(previous.has(refs[i]));
        }
      }
      // The just-sent turn always survives — that is what the reserve buys.
      expect(allowed.has(refs[n - 1])).toBe(true);
      previous = allowed;
    }
  });

  it("keeps a newly-sent document even when the history budget is already full", async () => {
    const old = Array.from({ length: 4 }, () => writeExtraction(MAX_EXTRACTED_BYTES));
    const fresh = writeExtraction(MAX_EXTRACTED_BYTES);
    const allowed = await selectAffordableAttachments([
      ...old.map((ref) => [{ ref, mime: "application/pdf" }]),
      [{ ref: fresh, mime: "application/pdf" }],
    ]);
    expect(allowed.has(fresh)).toBe(true);
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

/**
 * The fail-closed gate the upload route uses to confirm a file's bytes
 * actually match its declared class — images/PDF by magic bytes, text by
 * UTF-8-decodability. Real temp files, same pattern as the rest of this
 * file's suites.
 */
describe("isDecodableText / verifyStoredBytes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loxaic-verify-bytes-test-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;

  beforeAll(() => {
    process.env.UPLOADS_DIR = dir;
  });

  afterAll(() => {
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTemp(name: string, data: Buffer | string): string {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, data);
    return filePath;
  }

  describe("isDecodableText", () => {
    it("accepts valid multi-byte UTF-8", async () => {
      const filePath = writeTemp("multibyte.txt", Buffer.from("héllo wörld 日本語", "utf8"));
      await expect(isDecodableText(filePath)).resolves.toBe(true);
    });

    it("rejects a file containing a NUL byte, even amid otherwise valid UTF-8", async () => {
      const filePath = writeTemp(
        "nul.txt",
        Buffer.concat([Buffer.from("before", "utf8"), Buffer.from([0x00]), Buffer.from("after", "utf8")]),
      );
      await expect(isDecodableText(filePath)).resolves.toBe(false);
    });

    it("rejects an invalid UTF-8 byte sequence", async () => {
      // A lone continuation/leading byte with nothing completing a valid
      // sequence — TextDecoder({ fatal: true }) throws on this.
      const filePath = writeTemp("invalid-utf8.bin", Buffer.from([0xc0]));
      await expect(isDecodableText(filePath)).resolves.toBe(false);
    });
  });

  describe("verifyStoredBytes", () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdfBytes = Buffer.from("%PDF-1.4\n%âãÏÓ\n");

    it("accepts a real PNG's magic bytes declared as image/png", async () => {
      const filePath = writeTemp("real.png", pngBytes);
      await expect(verifyStoredBytes(filePath, "image/png")).resolves.toBe(true);
    });

    it("rejects the same PNG bytes declared under a mismatched mime", async () => {
      const filePath = writeTemp("mismatched.jpg", pngBytes);
      await expect(verifyStoredBytes(filePath, "image/jpeg")).resolves.toBe(false);
    });

    it("accepts a real PDF header declared as application/pdf", async () => {
      const filePath = writeTemp("real.pdf", pdfBytes);
      await expect(verifyStoredBytes(filePath, "application/pdf")).resolves.toBe(true);
    });

    it("accepts valid UTF-8 text declared as text/plain", async () => {
      const filePath = writeTemp("real.txt", Buffer.from("just some ordinary text", "utf8"));
      await expect(verifyStoredBytes(filePath, "text/plain")).resolves.toBe(true);
    });

    it("rejects a NUL-containing file declared as text/plain", async () => {
      const filePath = writeTemp("binary.txt", Buffer.concat([Buffer.from("abc"), Buffer.from([0x00]), Buffer.from("def")]));
      await expect(verifyStoredBytes(filePath, "text/plain")).resolves.toBe(false);
    });

    it("fails closed for an unrecognized mime, rather than silently returning true", async () => {
      const filePath = writeTemp("unknown.bin", Buffer.from("whatever bytes"));
      await expect(verifyStoredBytes(filePath, "application/x-bogus-unknown")).resolves.toBe(false);
    });

    // Office/ebook formats are all zip containers and are indistinguishable
    // from each other at the header, so the check for those is "is this
    // genuinely a zip" — enough to stop a renamed binary from reaching an
    // extractor, with the extractor itself (in the sandbox) as the real test
    // of whether it is the specific format claimed.
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    it.each([
      DOCX,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/epub+zip",
    ])("accepts a zip header declared as %s", async (mime) => {
      const filePath = writeTemp(`zip-${mime.replace(/\W/g, "")}.bin`, zipHeader);
      await expect(verifyStoredBytes(filePath, mime)).resolves.toBe(true);
    });

    it("rejects a non-zip file declared as a zip-container document type", async () => {
      const filePath = writeTemp("renamed.docx", Buffer.from("MZ\x90\x00 not a zip at all"));
      await expect(verifyStoredBytes(filePath, DOCX)).resolves.toBe(false);
    });

    it.each(["application/rtf", "text/rtf"])("accepts an RTF header declared as %s", async (mime) => {
      const filePath = writeTemp(`real-${mime.replace(/\W/g, "")}.rtf`, Buffer.from(String.raw`{\rtf1\ansi hello}`));
      await expect(verifyStoredBytes(filePath, mime)).resolves.toBe(true);
    });

    it("rejects plain text declared as RTF — it has no {\\rtf header", async () => {
      const filePath = writeTemp("fake.rtf", Buffer.from("not really rtf at all"));
      await expect(verifyStoredBytes(filePath, "application/rtf")).resolves.toBe(false);
    });

    it("rejects a zip declared as a PDF — a zip is not every document type", async () => {
      const filePath = writeTemp("zip-as-pdf.pdf", zipHeader);
      await expect(verifyStoredBytes(filePath, "application/pdf")).resolves.toBe(false);
    });
  });
});
