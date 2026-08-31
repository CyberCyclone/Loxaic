import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { db, eq } from "@shannon/db";
import { attachments } from "@shannon/db/schema";
import { ATTACHMENT_MIMES } from "@shannon/types";
import { authenticate, authenticateHeaderOrQuery } from "../auth/middleware";
import { attachmentPath, isValidRef, sniffImageMime } from "../files/storage";
import { usedAttachmentBytes, userQuotaBytes } from "../files/reaper";

export function fileRoutes(app: FastifyInstance) {
  // Upload one image. The client parallelizes for multi-image messages.
  app.post("/v1/files", async (request, reply) => {
    const userId = await authenticate(request, reply);

    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { error: "Attach an image file to upload" };
    }
    const mime = file.mimetype.toLowerCase();
    if (!(ATTACHMENT_MIMES as readonly string[]).includes(mime)) {
      reply.code(415);
      return { error: "Only JPEG, PNG, WebP, and GIF images are supported" };
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

    if (file.file.truncated) {
      await cleanup();
      reply.code(413);
      return { error: "Image is larger than 10 MB — resize it and try again" };
    }

    // The declared mime got the file this far; the bytes have the final say.
    const fh = await open(dest, "r");
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    await fh.close();
    if (sniffImageMime(head) !== mime) {
      await cleanup();
      reply.code(415);
      return { error: "File contents don't match an image of the declared type" };
    }

    const { size } = await stat(dest);
    if (usedBefore + size > quota) {
      await cleanup();
      reply.code(413);
      return { error: "That image would put you over your storage limit" };
    }

    try {
      await db.insert(attachments).values({ id: ref, ownerId: userId, mime, sizeBytes: size });
    } catch (err) {
      // Same reasoning as the pipeline catch: without a row the file is
      // unreachable by every reclaim path there is.
      await cleanup();
      throw err;
    }
    return { ref, mime, size_bytes: size };
  });

  // Serve an image to its owner. Accepts `?token=` because <img> tags can't
  // set headers. Wrong owner and nonexistent are the same 404 — no existence
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
      // `row.mime` can only be one of ATTACHMENT_MIMES (allowlisted on upload,
      // then confirmed against the file's magic bytes), so nothing served here
      // is script today. These three are the second line behind that single
      // control: this endpoint is same-origin with the web app, so the day
      // someone adds "image/svg+xml" to the allowlist — a one-line diff, and
      // the obvious next request — it would otherwise become stored XSS with
      // full access to the session. nosniff stops content-type guessing,
      // `inline` without a filename keeps <img> working while pinning the
      // disposition, and the CSP neutralizes scripts in any document-ish type
      // that ever slips through.
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "inline")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.send(createReadStream(attachmentPath(ref)));
  });
}
