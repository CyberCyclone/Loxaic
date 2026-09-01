import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { db, eq } from "@shannon/db";
import { attachments } from "@shannon/db/schema";
import {
  attachmentClass,
  maxBytesForMime,
  resolveAttachmentMime,
  sanitizeFilename,
  MAX_DOCUMENT_BYTES,
} from "@shannon/types";
import { authenticate, authenticateHeaderOrQuery } from "../auth/middleware";
import { attachmentPath, attachmentTextPath, isValidRef, verifyStoredBytes } from "../files/storage";
import { usedAttachmentBytes, userQuotaBytes } from "../files/reaper";
import { extractText } from "../files/extract";
import { getSandboxStatus } from "../sandbox/status";

export function fileRoutes(app: FastifyInstance) {
  // Upload one file. The client parallelizes for multi-attachment messages.
  app.post("/v1/files", async (request, reply) => {
    const userId = await authenticate(request, reply);

    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { error: "Attach a file to upload" };
    }

    // The picker's declared type wins when it's usable; the extension is the
    // fallback, because browsers report "" for .md/.ts/.csv and a strict mime
    // allowlist alone would silently reject exactly the source files a coding
    // assistant is most likely to be handed.
    const filename = sanitizeFilename(file.filename);
    const mime = resolveAttachmentMime(file.mimetype, filename);
    if (!mime) {
      reply.code(415);
      return { error: "That file type isn't supported — images, text, code, CSV, JSON, and PDF are" };
    }
    const cls = attachmentClass(mime);

    // Parser-needing formats are read inside a **container** and nowhere else,
    // so without one there is no safe way to read this file and it is rejected
    // rather than stored unreadable.
    //
    // The gate is "a container is actually available right now", not merely
    // "some provider is configured". Host mode does not count: it has none of
    // the container's protections — no network isolation, no uid separation,
    // and the host provider ignores the resource limits entirely — so running
    // a PDF or Office parser there is running it on the server itself.
    // Resolved at call time, per the settings contract in AGENTS.md.
    if (cls === "document") {
      const sandbox = await getSandboxStatus();
      if (sandbox.mode !== "container" || !sandbox.available) {
        reply.code(415);
        return {
          // A code as well as prose: the client renders a specific explanation
          // for this case, and string-matching an error message for that would
          // break the moment the wording changed.
          code: "sandbox_required",
          error:
            "This file type can't be read safely without a container sandbox, so it wasn't uploaded. " +
            (sandbox.mode === "host"
              ? "This server is in host mode, which runs tools directly on the machine rather than in a container."
              : (sandbox.reason ?? "No container sandbox is available on this server.")),
        };
      }
    }

    // Cheap pre-check so a user already at their ceiling doesn't get to write
    // 10 MB first. The authoritative check is after the bytes land, when the
    // real size is known.
    const quota = userQuotaBytes();
    const usedBefore = await usedAttachmentBytes(userId);
    if (usedBefore >= quota) {
      reply.code(413);
      return { error: "You've used all your image storage — delete a conversation or contact your admin" };
    }

    // Mint the ref up front so the bytes can stream straight to their final
    // path; the row is only inserted once the file is fully on disk.
    const ref = randomUUID();
    const dest = attachmentPath(ref);
    const cleanup = () => unlink(dest).catch(() => undefined);

    try {
      await pipeline(file.file, createWriteStream(dest));
    } catch (err) {
      // A client that disconnects mid-body makes @fastify/multipart destroy
      // the part, so pipeline rejects with whatever already reached the disk
      // still sitting there — and no row, which means no later sweep and no
      // quota accounting can ever see it. This is the only chance to remove
      // it. Cleanup must be defined before the await, not after.
      await cleanup();
      throw err;
    }

    // @fastify/multipart's limit is the largest any class may be; the
    // per-class cap is checked below, once the real size is known.
    if (file.file.truncated) {
      await cleanup();
      reply.code(413);
      return { error: `File is larger than ${String(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB` };
    }

    if (!(await verifyStoredBytes(dest, mime))) {
      await cleanup();
      reply.code(415);
      return {
        error:
          cls === "text"
            ? "That file isn't readable as text — it looks like binary data"
            : "File contents don't match the declared type",
      };
    }

    const { size } = await stat(dest);
    const classMax = maxBytesForMime(mime);
    if (size > classMax) {
      await cleanup();
      reply.code(413);
      const mb = String(classMax / (1024 * 1024));
      return {
        error:
          cls === "image"
            ? `Image is larger than ${mb} MB — resize it and try again`
            : `File is larger than ${mb} MB`,
      };
    }
    if (usedBefore + size > quota) {
      await cleanup();
      reply.code(413);
      return { error: "That file would put you over your storage limit" };
    }

    // Extraction never fails an upload: a parser error leaves the file stored
    // with extract_status "failed", the chip warns, and the prompt says so.
    // Losing the user's file because a PDF was malformed would be worse than
    // any of that.
    const extracted = await extractText({ ref, mime, filename, userId });

    try {
      await db.insert(attachments).values({
        id: ref,
        ownerId: userId,
        mime,
        sizeBytes: size,
        filename,
        extractStatus: extracted.status,
        extractBytes: extracted.bytes,
      });
    } catch (err) {
      // Same reasoning as the pipeline catch: without a row the file is
      // unreachable by every reclaim path there is.
      await cleanup();
      await unlink(attachmentTextPath(ref)).catch(() => undefined);
      throw err;
    }
    return {
      ref,
      mime,
      size_bytes: size,
      name: filename,
      extract_status: extracted.status,
    };
  });

  // Serve a file to its owner. Accepts `?token=` because <img> tags can't set
  // headers. Wrong owner and nonexistent are the same 404 — no existence
  // oracle, matching streams/authz.ts.
  app.get<{ Params: { ref: string } }>("/v1/files/:ref", async (request, reply) => {
    const userId = await authenticateHeaderOrQuery(request, reply);
    const { ref } = request.params;
    if (!isValidRef(ref)) {
      reply.code(404);
      return { error: "Not found" };
    }
    const row = await db.query.attachments.findFirst({ where: eq(attachments.id, ref) });
    if (row?.ownerId !== userId) {
      reply.code(404);
      return { error: "Not found" };
    }
    reply
      .type(row.mime)
      // Refs are immutable once written, so let clients cache hard — but
      // privately: the URL carries a token and must never land in a shared cache.
      .header("Cache-Control", "private, max-age=31536000, immutable")
      // `row.mime` is allowlisted on upload and then confirmed against the
      // bytes themselves, so nothing served here is what it doesn't claim to
      // be. These headers are the second line behind that single control,
      // because this endpoint is same-origin with the web app.
      //
      // The disposition split is load-bearing and is why "image/svg+xml" must
      // stay out of IMAGE_MIMES: only images are served `inline`, because only
      // they need to render in an <img>. Everything else — text/html and
      // text/xml above all, which a browser would happily execute in a
      // same-origin document — is forced to `attachment`, so it downloads
      // instead of rendering. nosniff stops content-type guessing and the CSP
      // neutralizes scripts in anything that ever slips through both.
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", contentDisposition(row.mime, row.filename))
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.send(createReadStream(attachmentPath(ref)));
  });

  // The cached extraction — exactly the text the model was given. Backs the
  // client's preview, which is deliberately a preview and not a download: it
  // shows the user what the model actually sees, which for a PDF is not the
  // same thing as the file.
  app.get<{ Params: { ref: string } }>("/v1/files/:ref/text", async (request, reply) => {
    const userId = await authenticateHeaderOrQuery(request, reply);
    const { ref } = request.params;
    if (!isValidRef(ref)) {
      reply.code(404);
      return { error: "Not found" };
    }
    const row = await db.query.attachments.findFirst({ where: eq(attachments.id, ref) });
    if (row?.ownerId !== userId) {
      reply.code(404);
      return { error: "Not found" };
    }
    if (row.extractStatus !== "ok") {
      reply.code(409);
      return { error: "No extracted text for this attachment", status: row.extractStatus };
    }
    let text: string;
    try {
      text = await readFile(attachmentTextPath(ref), "utf8");
    } catch {
      // The row says "ok" but the sidecar is gone — a pruned volume or a
      // restored DB. Same shape as the missing-file degradation in prompt
      // assembly rather than a 500.
      reply.code(409);
      return { error: "No extracted text for this attachment", status: "failed" };
    }
    reply
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    return { ref, name: row.filename, mime: row.mime, text };
  });
}

/**
 * `Content-Disposition` for one attachment.
 *
 * Only images render inline (see the serve route's comment); everything else
 * downloads. The filename is emitted twice on purpose: a quoted ASCII fallback
 * for old clients and RFC 5987 `filename*` for the real, possibly non-ASCII
 * name. `sanitizeFilename` has already removed control characters and path
 * separators at upload; the quote-stripping here is belt-and-braces so a name
 * can never close the quoted string and inject a header parameter.
 */
function contentDisposition(mime: string, filename: string): string {
  const kind = attachmentClass(mime) === "image" ? "inline" : "attachment";
  if (!filename) return kind;
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
  // sanitizeFilename caps by slicing UTF-16 code units, so a name whose cut
  // lands inside an astral-plane character (emoji, CJK extensions, musical
  // symbols) ends in a lone surrogate — and encodeURIComponent throws URIError
  // on those, which would 500 every download of that attachment forever.
  // Dropping an unpaired surrogate is the only lossy step and it only ever
  // removes half a character that was already destroyed by the cut.
  const encodable = filename.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(encodable)}`;
}
