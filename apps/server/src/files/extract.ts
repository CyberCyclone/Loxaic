import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import {
  attachmentClass,
  MAX_CACHED_EXTRACTION_BYTES,
  MAX_PDF_PAGES,
} from "@shannon/types";
import { stripControl } from "../mcp/sanitize.ts";
import { getSandboxProvider, type SandboxHandle, type SandboxProvider } from "../sandbox/provider.ts";
import { attachmentPath, attachmentTextPath } from "./storage.ts";

/**
 * Turning an uploaded file into the text the model will actually be given.
 *
 * Two rules shape this module.
 *
 * **Nothing with a parser runs in this process.** Text formats are just UTF-8
 * bytes and are decoded here; everything needing a real parser over a file the
 * server did not author runs inside the sandbox container, which has no
 * network, a non-root user, and memory/CPU/pids limits. That is why
 * DOCUMENT_MIMES are rejected at upload when SANDBOX_MODE is "off" — there is
 * no safe place to read them.
 *
 * **Extraction reads, it never executes.** `pdftotext` is a text extractor: no
 * macro, embedded script, or PDF JavaScript is run. Keep that true of anything
 * added here.
 *
 * Everything runs once, at upload, and the result is cached beside the
 * original as `<ref>.txt`. That is what keeps prompt assembly synchronous and
 * sandbox-free, so chat and agent behave identically and a 40-turn history
 * replay re-extracts nothing.
 */

/** How long an extraction sandbox may sit unused before it is stopped. */
const IDLE_TTL_MS = 5 * 60 * 1000;
/** How often the reaper looks. */
const REAP_INTERVAL_MS = 60 * 1000;
/** Ceiling on one extraction. A pathological file must not hold a container. */
const EXTRACT_TIMEOUT_MS = 60_000;

/** Mirrors the DB column: never blocks an upload, only describes the outcome. */
export type ExtractStatus = "none" | "ok" | "failed" | "unsupported";

export interface ExtractResult {
  status: ExtractStatus;
  /** Bytes written to `<ref>.txt`; 0 unless status is "ok". */
  bytes: number;
}

export interface ExtractInput {
  ref: string;
  mime: string;
  /** Already sanitized. Metadata only — it never reaches a command line. */
  filename: string;
  userId: string;
}

/**
 * Extract and cache one attachment's text.
 *
 * Never throws and never fails an upload. A malformed PDF, a wedged engine, a
 * timeout — all land as `status: "failed"`, the file stays stored, the chip
 * warns, and the prompt carries an explicit marker. Losing the user's file
 * because a parser disagreed with it would be worse than any of those.
 */
export async function extractText(input: ExtractInput): Promise<ExtractResult> {
  const cls = attachmentClass(input.mime);
  if (cls === "image" || cls === null) return { status: "none", bytes: 0 };

  try {
    const raw = cls === "text" ? await extractPlainText(input) : await extractViaSandbox(input);
    const text = capped(stripControl(raw));
    if (!text.trim()) return { status: "failed", bytes: 0 };
    await writeFile(attachmentTextPath(input.ref), text, "utf8");
    return { status: "ok", bytes: Buffer.byteLength(text, "utf8") };
  } catch (err) {
    console.warn(
      `[extract] ${input.mime} attachment ${input.ref} could not be read: ${(err as Error).message}`,
    );
    return { status: "failed", bytes: 0 };
  }
}

/** Remove a cached extraction, if there is one. Used by the reaper alongside
 * the original — the sidecar must not outlive the file it describes. */
export async function removeExtractedText(ref: string): Promise<void> {
  await unlink(attachmentTextPath(ref)).catch(() => undefined);
}

/** Read a cached extraction, or null when there isn't one. */
export async function readExtractedText(ref: string): Promise<string | null> {
  try {
    return await readFile(attachmentTextPath(ref), "utf8");
  } catch {
    return null;
  }
}

/** UTF-8 safe truncation: slice on a character boundary, not a byte one, so a
 * cut multi-byte sequence can't become a replacement character. Caps the
 * cached sidecar at MAX_CACHED_EXTRACTION_BYTES — distinct from, and much
 * larger than, MAX_EXTRACTED_BYTES, which bounds what enters the prompt (see
 * storage.ts's own truncateForPrompt). */
function capped(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_CACHED_EXTRACTION_BYTES) return text;
  const buf = Buffer.from(text, "utf8").subarray(0, MAX_CACHED_EXTRACTION_BYTES);
  return new TextDecoder("utf-8").decode(buf).replace(/�$/, "");
}

/**
 * Text formats need no parser at all — the upload route has already confirmed
 * the whole file decodes as UTF-8 with no NUL byte, which is the property that
 * makes inlining it safe. HTML is the one that gets more than a decode: its
 * tags are stripped with the same helper `web_fetch` uses, since raw markup
 * tells the model nothing the text doesn't.
 */
async function extractPlainText(input: ExtractInput): Promise<string> {
  const text = await readTextCapped(attachmentPath(input.ref));
  if (input.mime === "text/html") return htmlToText(text);
  return text;
}

/**
 * Read at most {@link MAX_CACHED_EXTRACTION_BYTES} of a file as UTF-8.
 *
 * Deliberately streamed rather than `readFile(path, "utf8")`. That pulls the
 * whole upload into one string — up to MAX_DOCUMENT_BYTES, so ~25 MB, or ~50 MB
 * of heap as UTF-16 — and every later step (htmlToText's passes, the cap) then
 * copies it again, all inside the upload handler with no concurrency limit. A
 * handful of simultaneous large uploads is otherwise a cheap way for any
 * signed-in user to exhaust the heap. Everything past the cap is discarded
 * anyway, so there is no reason to have read it.
 *
 * `stream: true` on the decoder keeps a multi-byte character split across a
 * chunk boundary intact.
 */
async function readTextCapped(filePath: string): Promise<string> {
  const decoder = new TextDecoder("utf-8");
  let out = "";
  let bytes = 0;
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      const room = MAX_CACHED_EXTRACTION_BYTES - bytes;
      if (buf.length >= room) {
        out += decoder.decode(buf.subarray(0, room), { stream: true });
        break;
      }
      out += decoder.decode(buf, { stream: true });
      bytes += buf.length;
    }
  } finally {
    stream.destroy();
  }
  return out + decoder.decode();
}

/**
 * Drop every `<tag>…</tag>` pair for one element name, by scanning rather than
 * matching.
 *
 * The obvious regex — `/<script\b[^>]*>[\s\S]*?<\/script>/gi` — backtracks
 * quadratically. Its lazy `[\s\S]*?` rescans to end-of-input from every
 * candidate start, so input with many unclosed `<script` prefixes degrades
 * catastrophically: measured on this branch at 2.6s for 137 KB, 10.7s for
 * 273 KB, and 43.9s for 547 KB. `text/html` is a TEXT_MIME, so it is decoded
 * *in this process* on the server's only thread, inside the upload handler —
 * a single authenticated upload well under MAX_DOCUMENT_BYTES could block
 * every other request for minutes. This scan is linear and allocation-light
 * by comparison.
 */
function stripElement(html: string, tag: string): string {
  const open = `<${tag}`;
  const close = `</${tag}`;
  const lower = html.toLowerCase();
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) break;
    // `<scriptable>` is not `<script>` — the next char must end the tag name.
    const afterAt = start + open.length;
    if (afterAt < lower.length && /[a-z0-9]/.test(lower.slice(afterAt, afterAt + 1))) {
      out += html.slice(cursor, afterAt);
      cursor = afterAt;
      continue;
    }
    out += html.slice(cursor, start);
    const closeAt = lower.indexOf(close, start);
    // Unclosed: everything from here on is inside the element, so drop it.
    if (closeAt === -1) return out;
    const closeEnd = html.indexOf(">", closeAt);
    cursor = closeEnd === -1 ? html.length : closeEnd + 1;
  }
  return out + html.slice(cursor);
}

/**
 * Tag-stripping, matching `web_fetch`'s own treatment of HTML — script and
 * style contents dropped, tags removed, entities decoded. Not a parser,
 * deliberately: an HTML parser over untrusted input is exactly the kind of
 * thing this module keeps out of the server process.
 *
 * The remaining regexes are all single-pass with no nested quantifier, so
 * none of them backtracks the way the script/style pair did (see
 * {@link stripElement}).
 */
function htmlToText(html: string): string {
  return stripElement(stripElement(html, "script"), "style")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Run the format's extractor inside the sandbox.
 *
 * The bytes are written to a path this module chooses, never one derived from
 * the user's filename, and the extractor is invoked in argv form — so nothing
 * the user controls is ever parsed as a command. The filename stays metadata.
 */
async function extractViaSandbox(input: ExtractInput): Promise<string> {
  const handle = await getExtractionSandbox(input.userId);
  const format = sandboxFormat(input.mime);
  // Under `handle.root`, never an absolute /tmp path. The two providers give
  // that very different meanings and only one of them is isolated: for the
  // container provider /tmp is the container's own, but for the host provider
  // it would be the *real host* /tmp — world-readable, shared by every user on
  // the box, so one person's document bytes would be briefly readable by
  // anything else running there. `root` is the per-sandbox directory in host
  // mode and /home/shannon in container mode, which is correct for both.
  const base = `${handle.root}/.extract/${randomUUID()}`;
  // The extension is load-bearing, not decoration: openpyxl refuses to open a
  // file whose name doesn't end in a spreadsheet extension, regardless of its
  // contents ("does not support .in file format"). Several of these libraries
  // dispatch on extension, so the sandbox copy is named for its format. The
  // extension comes from our own table, never from the user's filename.
  const inPath = `${base}.${format}`;
  const outPath = `${base}.out`;
  try {
    await handle.writeFileBinary(inPath, await readFile(attachmentPath(input.ref)));
    // The extractor's output goes to a file, not stdout. exec caps what it
    // will read back at MAX_OUTPUT_BYTES (256 KB) — far below what a long
    // document legitimately extracts to — so taking stdout directly would
    // silently truncate mid-document AND splice the exec layer's own
    // "[output truncated]" notice into the text we then cache as if it were
    // the document's. `$0` is the redirect target and `"$@"` the argv, so
    // neither the path nor the command is ever spliced into the script text.
    const res = await handle.exec(
      ["bash", "-c", '"$@" > "$0"', outPath, ...commandFor(format, inPath)],
      { timeoutMs: EXTRACT_TIMEOUT_MS },
    );
    if (res.timedOut) throw new Error(`extractor timed out after ${String(EXTRACT_TIMEOUT_MS)}ms`);
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `extractor exited ${String(res.exitCode)}`);
    }
    return await readSandboxText(handle, outPath);
  } finally {
    // The container is pooled, so leftovers would accumulate across uploads.
    await handle.exec(["rm", "-f", "--", inPath, outPath]).catch(() => undefined);
  }
}

/** Raw bytes per read-back chunk. base64 inflates by 4/3, so 180 KB encodes to
 * ~240 KB — comfortably inside exec's 256 KB ceiling with room for framing. */
const READ_CHUNK_BYTES = 180 * 1024;

/**
 * Read an extraction back out of the sandbox, in chunks that each fit exec's
 * output cap.
 *
 * base64 rather than raw text because exec hands back an already-decoded
 * string: a chunk boundary landing mid-UTF-8-sequence would corrupt that
 * character on every large document. Encoding keeps each chunk ASCII and
 * defers decoding until the whole buffer is reassembled.
 */
async function readSandboxText(handle: SandboxHandle, filePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const res = await handle.exec([
      "bash", "-c",
      'tail -c +"$2" -- "$1" | head -c "$3" | base64 -w0',
      "_", filePath, String(offset + 1), String(READ_CHUNK_BYTES),
    ]);
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `reading extraction failed (exit ${String(res.exitCode)})`);
    }
    // Would mean the chunk arithmetic above drifted past the cap — better to
    // fail loudly than to concatenate a silently clipped chunk.
    if (res.truncated) throw new Error("extraction read-back exceeded the exec output cap");
    const encoded = res.stdout.trim();
    if (!encoded) break;
    const buf = Buffer.from(encoded, "base64");
    if (buf.length === 0) break;
    chunks.push(buf);
    offset += buf.length;
    if (buf.length < READ_CHUNK_BYTES) break;
    if (offset >= MAX_CACHED_EXTRACTION_BYTES) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The extractor argv for a mime. Every element is a literal or a path this
 * module minted; nothing here interpolates user input. */
/** Office/ebook mimes to the short format name `shannon-extract` dispatches
 * on. Kept here rather than in the script so an unknown mime fails on this
 * side, before a container is ever touched. */
const SANDBOX_FORMATS: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/epub+zip": "epub",
};

/** The short format name for a mime — also the extension the sandbox copy is
 * given (see extractViaSandbox). Throws for anything unmapped, so an unknown
 * mime fails before a container is ever touched. */
function sandboxFormat(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  const format = SANDBOX_FORMATS[mime];
  if (!format) throw new Error(`no extractor for ${mime}`);
  return format;
}

function commandFor(format: string, inPath: string): string[] {
  if (format === "pdf") {
    // `-l` bounds pages independently of the byte cap, so a PDF with a
    // pathological page count can't monopolise the container. `-` writes to
    // stdout, which the caller redirects to a file.
    return ["pdftotext", "-layout", "-l", String(MAX_PDF_PAGES), "--", inPath, "-"];
  }
  // shannon-extract is baked into the sandbox image (infra/docker/sandbox/
  // extract.py) and runs the decompression-bomb guard itself, before it opens
  // anything — see that file for why the guard lives on that side.
  return ["shannon-extract", format, inPath];
}

// ── Pooled extraction sandboxes ───────────────────────────
// Keyed by user, mirroring mcp/client-manager.ts's `userId:serverId` caching
// and sandbox-manager.ts's idle reaper. Per-user rather than one global
// container so two people's documents never transit the same filesystem;
// pooled rather than per-upload so a four-file message isn't four cold starts.
//
// These are deliberately NOT the conversation sandboxes: extraction happens at
// upload time, when there may be no conversation yet, and an extractor must
// not run in the container an agent is working in.

interface Entry { handle: SandboxHandle; lastUsedAt: number }

const active = new Map<string, Entry>();
/** userId → in-flight creation, so concurrent uploads share one container. */
const pending = new Map<string, Promise<Entry>>();

async function getExtractionSandbox(userId: string): Promise<SandboxHandle> {
  const provider = await getSandboxProvider();
  if (!provider) throw new Error("sandboxes are disabled (SANDBOX_MODE=off)");

  const existing = active.get(userId);
  if (existing && (await existing.handle.isRunning().catch(() => false))) {
    existing.lastUsedAt = Date.now();
    return existing.handle;
  }
  active.delete(userId);

  const inFlight = pending.get(userId);
  if (inFlight) return (await inFlight).handle;

  const created = createEntry(provider, userId);
  pending.set(userId, created);
  try {
    const entry = await created;
    active.set(userId, entry);
    return entry.handle;
  } finally {
    pending.delete(userId);
  }
}

async function createEntry(provider: SandboxProvider, userId: string): Promise<Entry> {
  const handle = await provider.create(userId, {
    // Tighter than an agent sandbox: this runs one extractor over one file and
    // then idles. Bounding it here is what keeps a decompression bomb or a
    // pathological PDF from taking the host down with it.
    limits: { memory: 512 * 1024 * 1024, cpu: 1_000_000_000, pids: 64 },
  });
  return { handle, lastUsedAt: Date.now() };
}

/** Stops and forgets every extraction sandbox idle for longer than IDLE_TTL_MS. */
export async function reapIdleExtractionSandboxes(now = Date.now()): Promise<number> {
  let reaped = 0;
  for (const [userId, entry] of [...active]) {
    if (now - entry.lastUsedAt < IDLE_TTL_MS) continue;
    active.delete(userId);
    await entry.handle.stop().catch(() => undefined);
    reaped++;
  }
  return reaped;
}

/** Stops every extraction sandbox — shutdown, and the settings change that
 * invalidates containers created by a previous engine. */
export async function stopAllExtractionSandboxes(): Promise<number> {
  let stopped = 0;
  for (const [userId, entry] of [...active]) {
    active.delete(userId);
    await entry.handle.stop().catch(() => undefined);
    stopped++;
  }
  return stopped;
}

export function startExtractionReaper(onReap?: (count: number) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    void reapIdleExtractionSandboxes()
      .then((n) => { if (n > 0) onReap?.(n); })
      .catch(() => undefined);
  }, REAP_INTERVAL_MS);
  timer.unref();
  return timer;
}
