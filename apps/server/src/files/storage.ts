import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentRef } from "@shannon/types";
import type { ContentPart } from "../inference/provider.ts";

/** Attachment refs are uuids minted by Postgres; anything else is rejected
 * before it can reach a path join. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let ensured: string | null = null;

/** Where uploaded images live. Defaults next to the server's cwd in dev; the
 * Docker image sets UPLOADS_DIR to a named volume. Created on first use. */
export function uploadsDir(): string {
  const dir = process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), "uploads");
  if (ensured !== dir) {
    mkdirSync(dir, { recursive: true });
    ensured = dir;
  }
  return dir;
}

export function isValidRef(ref: string): boolean {
  return UUID_RE.test(ref);
}

/** Files are named by their uuid ref alone — the mime lives in the DB row. */
export function attachmentPath(ref: string): string {
  if (!isValidRef(ref)) throw new Error("Invalid attachment ref");
  return path.join(uploadsDir(), ref.toLowerCase());
}

/** For prompt assembly: the stored bytes as an OpenAI-compatible data URI. */
export async function readAsDataUri(ref: string, mime: string): Promise<string> {
  const buf = await readFile(attachmentPath(ref));
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * A user message's attachments + text as OpenAI content parts, images first —
 * the same order the blocks are stored in. A file missing from disk (pruned
 * volume, restored DB) degrades to a text marker rather than failing the run.
 */
export async function attachmentContentParts(atts: AttachmentRef[], text: string): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const a of atts) {
    try {
      parts.push({ type: "image_url", image_url: { url: await readAsDataUri(a.ref, a.mime) } });
    } catch {
      parts.push({ type: "text", text: "[image unavailable]" });
    }
  }
  if (text) parts.push({ type: "text", text });
  return parts;
}

/** Cheap magic-byte check so a renamed non-image can't be stored under an
 * image mime. Only the four allowed formats are recognized. */
export function sniffImageMime(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 6 && (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
