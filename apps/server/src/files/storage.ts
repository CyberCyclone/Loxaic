import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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

/**
 * Takes `unknown` deliberately. `RegExp.test` stringifies its argument, so a
 * `string`-typed parameter is not the guard it looks like: `test(["<uuid>"])`
 * coerces the single-element array to the uuid and returns true. Callers
 * validating a value that came off the wire (where TypeScript's `string[]` is
 * a claim, not a fact) would then hand an array to a uuid-typed query.
 */
export function isValidRef(ref: unknown): ref is string {
  return typeof ref === "string" && UUID_RE.test(ref);
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
 * Ceiling on the raw image bytes one prompt may carry, summed across every
 * replayed turn. The per-upload caps (10 MB × 4 per message) bound a single
 * send but not a conversation: HISTORY_LIMIT is 50, so without this a user
 * could build a thread whose every subsequent turn re-reads and base64s a
 * gigabyte off disk into one JSON body — heap exhaustion on demand, repeatable
 * for the cost of one WebSocket frame. Base64 inflates this by ~4/3 on the
 * wire, so 32 MiB here is ~43 MB of request body.
 */
export const MAX_HISTORY_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Which refs across a whole history fit in {@link MAX_HISTORY_IMAGE_BYTES},
 * chosen newest-first.
 *
 * `turns` is oldest-first (the order the prompt is assembled in), and the
 * walk is deliberately backwards: the images the user just sent are the ones
 * the model is being asked about, so a budget spent oldest-first would starve
 * exactly the turn that matters. A ref that doesn't fit is skipped rather than
 * ending the walk, so one big old image can't hide several small newer ones.
 * Unreadable files are left out here and degrade to "[image unavailable]"
 * downstream, same as before.
 */
export async function selectAffordableImages(turns: AttachmentRef[][]): Promise<Set<string>> {
  const allowed = new Set<string>();
  let remaining = MAX_HISTORY_IMAGE_BYTES;
  for (let i = turns.length - 1; i >= 0; i--) {
    for (const a of turns[i]) {
      if (allowed.has(a.ref)) continue;
      let size: number;
      try {
        ({ size } = await stat(attachmentPath(a.ref)));
      } catch {
        continue;
      }
      if (size > remaining) continue;
      remaining -= size;
      allowed.add(a.ref);
    }
  }
  return allowed;
}

/**
 * A user message's attachments + text as OpenAI content parts, images first —
 * the same order the blocks are stored in. A file missing from disk (pruned
 * volume, restored DB) degrades to a text marker rather than failing the run.
 *
 * `allowed`, when given, is the budget verdict from
 * {@link selectAffordableImages}; a ref outside it becomes a text marker
 * instead of being read. Repeated refs within one message are collapsed to a
 * single part — the same image twice tells the model nothing, and older rows
 * (written before the send path de-duplicated) can carry up to four copies.
 */
export async function attachmentContentParts(
  atts: AttachmentRef[],
  text: string,
  allowed?: ReadonlySet<string>,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  const seen = new Set<string>();
  for (const a of atts) {
    if (seen.has(a.ref)) continue;
    seen.add(a.ref);
    if (allowed && !allowed.has(a.ref)) {
      parts.push({ type: "text", text: "[image omitted: over this prompt's image budget]" });
      continue;
    }
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
