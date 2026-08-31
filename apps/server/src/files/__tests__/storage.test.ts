import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import {
  MAX_HISTORY_IMAGE_BYTES,
  attachmentContentParts,
  attachmentPath,
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
