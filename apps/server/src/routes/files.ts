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

    // Mint the ref up front so the bytes can stream straight to their final
    // path; the row is only inserted once the file is fully on disk.
    const ref = randomUUID();
    const dest = attachmentPath(ref);
    await pipeline(file.file, createWriteStream(dest));

    const cleanup = () => unlink(dest).catch(() => undefined);

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
    await db.insert(attachments).values({ id: ref, ownerId: userId, mime, sizeBytes: size });
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
      .header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.send(createReadStream(attachmentPath(ref)));
  });
}
