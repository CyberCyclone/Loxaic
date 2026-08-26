import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { attachmentContentParts, attachmentPath, isValidRef, readAsDataUri, sniffImageMime } from "../storage.ts";

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
});

describe("sniffImageMime", () => {
  it("recognizes JPEG, PNG, GIF, and WebP magic bytes", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.concat([Buffer.from("RIFF____"), Buffer.from("WEBP")]))).toBe("image/webp");
  });

  it("returns null for content that isn't one of the four supported formats", () => {
    expect(sniffImageMime(Buffer.from("<svg></svg>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("%PDF-1.4"))).toBeNull();
  });
});
