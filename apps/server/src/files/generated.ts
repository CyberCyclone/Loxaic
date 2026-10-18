/**
 * Images Loxaic itself produced — today, a web_fetch screenshot (#281).
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
import { unlink, writeFile } from "node:fs/promises";
import { db, eq } from "@loxaic/db";
import { attachments } from "@loxaic/db/schema";
import { attachmentClass, IMAGE_MIMES, sanitizeFilename } from "@loxaic/types";
import { attachmentPath, sniffMime, verifyStoredBytes } from "./storage.ts";
import { usedAttachmentBytes, userQuotaBytes } from "./reaper.ts";

/** One generated image's ceiling: the store's own line, the same as the
 * browser's screenshot cap (browser/render.ts) so neither can drift past it. */
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
  /** Shown on the chip and in Content-Disposition; sanitized here. */
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
  // The sniff is the check, not a hint: bytes that are not the mime the caller
  // named are refused, never relabelled.
  const sniffed = sniffMime(input.bytes);
  if (sniffed !== input.mime) {
    throw new GeneratedImageError(`The image bytes are ${sniffed ?? "not a recognized image"}, not ${input.mime}.`);
  }

  // A cheap check before writing, so an owner already at the limit costs no
  // disk; the authoritative one is after the row exists (below).
  const quota = userQuotaBytes();
  if ((await usedAttachmentBytes(input.ownerId)) + input.bytes.length > quota) {
    throw new GeneratedImageError("The attachment storage quota is full, so the screenshot could not be kept.");
  }
  const filename = sanitizeFilename(input.name);

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
      filename,
      extractStatus: "none",
      extractBytes: 0,
    });
    // Re-counted with this row in it: two screenshots stored at once both pass
    // the check above, and only a count that includes them can see the excess.
    if ((await usedAttachmentBytes(input.ownerId)) > quota) {
      await db.delete(attachments).where(eq(attachments.id, ref));
      throw new GeneratedImageError("The attachment storage quota is full, so the screenshot could not be kept.");
    }
  } catch (err) {
    // Nothing could ever reach the file: no row means the reaper has nothing to
    // match it against, and `uploadsDir()` is not swept by path.
    await unlinkQuietly(path);
    throw err;
  }
  return { ref, mime: input.mime, sizeBytes: input.bytes.length, filename };
}

async function unlinkQuietly(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}
