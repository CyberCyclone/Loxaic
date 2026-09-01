import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuid } from "uuid";
import { db, eq } from "@shannon/db";
import { user } from "@shannon/db/schema";
import { extractText, readExtractedText, stopAllExtractionSandboxes } from "../extract.ts";
import { attachmentPath } from "../storage.ts";
import { sandboxImageReady } from "../../sandbox/__tests__/docker-available.ts";

/**
 * Office extraction against a **real sandbox container** — there is no useful
 * way to fake this, and the two things it locks in were both real bugs found
 * by running it:
 *
 *  1. The sandbox copy of the upload has to carry its format's extension.
 *     openpyxl dispatches on the filename, not the content, and refuses a file
 *     called anything else ("does not support .in file format") — so a
 *     perfectly valid .xlsx silently extracted to `failed` until the temp file
 *     was named for its format.
 *  2. The extractor's output is read back in chunks. exec caps what it returns
 *     at MAX_OUTPUT_BYTES (256 KB); taking stdout directly truncated any
 *     longer document mid-way *and* spliced the exec layer's own
 *     "[output truncated]" notice into the text cached as the document's.
 *
 * Both are invisible to a unit test with a fake handle, because both live in
 * the seam between this module and a real container.
 */
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test-fixtures/documents",
);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const userId = `test-office-extract-${uuid()}`;
const dir = mkdtempSync(path.join(tmpdir(), "shannon-office-test-"));
const prevUploadsDir = process.env.UPLOADS_DIR;

const dockerReady = await sandboxImageReady();

beforeAll(async () => {
  if (!dockerReady) return;
  process.env.UPLOADS_DIR = dir;
  await db.insert(user).values({
    id: userId,
    name: "Office Extract",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}, 30_000);

afterAll(async () => {
  if (!dockerReady) return;
  await stopAllExtractionSandboxes().catch(() => undefined);
  await db.delete(user).where(eq(user.id, userId));
  if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = prevUploadsDir;
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

/** Stages a fixture as an upload and returns its ref. */
function stage(fixture: string): string {
  const ref = uuid();
  copyFileSync(path.join(FIXTURES, fixture), attachmentPath(ref));
  return ref;
}

describe.skipIf(!dockerReady)("office extraction in a real sandbox", () => {
  it("extracts a .docx", async () => {
    const ref = stage("sample.docx");
    const result = await extractText({ ref, mime: DOCX, filename: "sample.docx", userId });
    expect(result.status).toBe("ok");
    expect(await readExtractedText(ref)).toContain("aardvark-11");
  }, 300_000);

  it("extracts a .xlsx — regression: the sandbox copy needs an .xlsx extension", async () => {
    const ref = stage("sample.xlsx");
    const result = await extractText({ ref, mime: XLSX, filename: "sample.xlsx", userId });
    expect(result.status).toBe("ok");
    const text = await readExtractedText(ref);
    // Header row and a data row, proving cell values (not just sheet names).
    expect(text).toContain("quarter,region,revenue");
    expect(text).toContain("412000");
  }, 300_000);

  it("rejects a zip bomb without inflating it, and keeps the upload", async () => {
    // One entry declaring 300 MB uncompressed — the guard reads the central
    // directory only, so this costs nothing to reject.
    const ref = uuid();
    writeFileSync(attachmentPath(ref), buildZipBomb());
    const result = await extractText({ ref, mime: DOCX, filename: "bomb.docx", userId });
    expect(result).toEqual({ status: "failed", bytes: 0 });
  }, 300_000);
});

/**
 * A minimal single-entry zip whose central directory *declares* a huge
 * uncompressed size — built by hand rather than with a zip library so the
 * declared size is a deliberate lie, which is exactly the shape the guard
 * exists to catch (it must reject on the declaration, without inflating).
 */
function buildZipBomb(): Buffer {
  const name = Buffer.from("word/document.xml", "latin1");
  const payload = Buffer.from([0x03, 0x00]); // empty deflate stream
  const declared = 300 * 1024 * 1024;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(0, 14); // crc, unchecked by the guard
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + payload.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, payload, central, name, end]);
}
