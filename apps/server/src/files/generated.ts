/**
 * Images Loxaic itself produced — today, a `browse` screenshot (#281).
 *
 * Deliberately routed through the **same** attachment pipeline as an upload
 * rather than a parallel store: an attachment row owned by the conversation's
 * **owner** and bytes under `UPLOADS_DIR` named by the ref means the existing
 * serve route (`GET /v1/files/:ref?token=`, with its `nosniff`, its CSP and its
 * images-only `inline`), the existing quota accounting, and the existing orphan
 * reaper all apply to a screenshot with nothing new to get wrong. The
 * `files/AGENTS.md` rule that a new block kind carrying refs must be taught to
 * the reaper's SQL *and* to `mayReadAttachment` is precisely the trap this
 * avoids by not inventing a kind: a screenshot rides on an ordinary
 * `{kind:"attachment"}` ref.
 *
 * Owned by the conversation's **owner**, not by whoever ran the tool: an
 * editor's screenshot belongs to the conversation, the same rule `createConfigFor`
 * follows for sandboxes.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { db } from "@loxaic/db";
import { attachments } from "@loxaic/db/schema";
import { attachmentClass, IMAGE_MIMES } from "@loxaic/types";
import { attachmentPath, sniffMime, verifyStoredBytes } from "./storage.ts";
import { usedAttachmentBytes, userQuotaBytes } from "./reaper.ts";

/** One screenshot's ceiling. A full-page PNG of a long page is routinely
 * several MB; the browser's own cap (`BROWSE_SCREENSHOT_MAX_BYTES`) refuses
 * bigger ones before they get here, so this is the store's own line rather than
 * the model's. */
export const GENERATED_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export class GeneratedImageError extends Error {}

export interface GeneratedImage {
  ref: string;
  mime: string;
  sizeBytes: number;
  filename: string;
}

/**
 * Stores one generated image and returns what a message block and the client
 * need.
 *
 * The mime is **confirmed against the bytes** before the row exists (the same
 * `verifyStoredBytes` an upload goes through), because the serve route's safety
 * rests on that row's mime being true: an image stored under a mime it does not
 * match is how same-origin stored XSS gets an inline document. Only
 * `IMAGE_MIMES` are accepted at all, and never SVG, per the same rule.
 */
export async function storeGeneratedImage(input: {
  bytes: Buffer;
  mime: string;
  ownerId: string;
  /** Shown on the chip and in Content-Disposition; sanitized at insert. */
  name: string;
}): Promise<GeneratedImage> {
  if (input.bytes.length === 0) throw new GeneratedImageError("The image was empty.");
  if (input.bytes.length > GENERATED_IMAGE_MAX_BYTES) {
    throw new GeneratedImageError(
      `The image is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB, over the ${(GENERATED_IMAGE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB cap.`,
    );
  }
  if (!(IMAGE_MIMES as readonly string[]).includes(input.mime) || attachmentClass(input.mime) !== "image") {
    throw new GeneratedImageError(`Only images can be stored this way (got ${input.mime}).`);
  }
  // The sniff is the check, not a hint: a caller that passes "image/png" over
  // JPEG bytes gets the mime the bytes actually are, or a refusal when the
  // bytes are neither.
  const sniffed = sniffMime(input.bytes);
  if (sniffed !== input.mime) {
    throw new GeneratedImageError(`The image bytes are ${sniffed ?? "not a recognized image"}, not ${input.mime}.`);
  }

  // Quota first, then the write: a deployment at its limit should fail before
  // it has bytes on disk with no row, which only an hourly sweep could find.
  const used = await usedAttachmentBytes(input.ownerId);
  if (used + input.bytes.length > userQuotaBytes()) {
    throw new GeneratedImageError("The attachment storage quota is full, so the screenshot could not be kept.");
  }

  const ref = randomUUID();
  const path = attachmentPath(ref);
  await writeFile(path, input.bytes);
  try {
    // Read the bytes back and re-verify, as the upload route does: a partial
    // write on a full disk would otherwise become a row that serves a corrupt
    // image forever.
    if (!(await verifyStoredBytes(path, input.mime))) {
      throw new GeneratedImageError("The stored image did not verify.");
    }
    await db.insert(attachments).values({
      id: ref,
      ownerId: input.ownerId,
      mime: input.mime,
      sizeBytes: input.bytes.length,
      filename: input.name,
      extractStatus: "none",
      extractBytes: 0,
    });
  } catch (err) {
    // Nothing could ever reach the file: no row means the reaper has nothing to
    // match it against, and `uploadsDir()` is not swept by path.
    await unlinkQuietly(path);
    throw err;
  }
  return { ref, mime: input.mime, sizeBytes: input.bytes.length, filename: input.name };
}

async function unlinkQuietly(path: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(path).catch(() => undefined);
}
