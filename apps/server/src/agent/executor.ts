import posix from "node:path/posix";
import type { SandboxHandle } from "../sandbox/provider.ts";
import type { FileDiff, Todo, ToolName } from "@loxaic/agent";
import { QUESTION_LIMITS } from "@loxaic/agent";
import { attachmentClass, MAX_DOCUMENT_BYTES, parseTodoList } from "@loxaic/types";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { sniffMime } from "../files/storage.ts";
import { BlockedTargetError, guardedFetch, type GuardedResponse } from "./address-guard.ts";

/** Tools that need a live sandbox; the rest run in-process on the server. */
const SANDBOX_TOOLS: ToolName[] = ["fs_read", "fs_write", "fs_edit", "bash", "grep", "glob"];

export function toolNeedsSandbox(tool: ToolName): boolean {
  return SANDBOX_TOOLS.includes(tool);
}

export interface ToolResult {
  output: string;
  ok: boolean;
  diff?: FileDiff[];
  todos?: Todo[];
  /** A screenshot web_fetch took (#281), as bytes. The engine stores it as an
   * attachment and puts the ref on the result; the executor never touches
   * storage or the database. `forModel`: the model asked for it. Every other
   * browser load takes one too, for the person only. */
  image?: { bytes: Buffer; mime: "image/png"; forModel: boolean };
  /** web_fetch loaded the page in the conversation's browser (#281), whether
   * or not that worked, so the person can tell it from a plain fetch. */
  browser?: true;
}

/**
 * Turns a document's bytes into text. Injected for the reason `PageRenderer`
 * is: reading one needs a sandbox and a user, which this module knows nothing
 * of (files/extract.ts's `extractDocumentBytes` is the real one).
 */
export type DocumentReader = (
  bytes: Buffer,
  mime: string,
  signal?: AbortSignal,
) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

/**
 * Loads a page in the conversation's own browser (browser/render.ts), bound by
 * the engine to the run's conversation and abort signal. Absent when browsing
 * is off, which makes web_fetch exactly the plain fetch it always was.
 */
export type PageRenderer = (url: URL, opts: { screenshot: "required" | "best-effort"; maxTextChars: number }) => Promise<RenderResult>;

const WEB_FETCH_TIMEOUT_MS = 15_000;
/** A document takes longer to arrive than a page, so its body gets this long,
 * counted from the headers. Stop reaches it through the run's signal. */
const WEB_FETCH_DOCUMENT_TIMEOUT_MS = 60_000;
/** Ceiling on the *extracted text* a fetch contributes to the prompt. */
const WEB_FETCH_MAX_BYTES = 100 * 1024;
/**
 * Ceiling on the raw bytes read off the wire, before markup is stripped.
 * Deliberately much larger than WEB_FETCH_MAX_BYTES: a modern page is mostly
 * markup, inline CSS and inline JS, so a 100 KB slice of the *source* is
 * routinely a few KB of readable text — or, as happened here, none at all
 * (see htmlToText). The body is read incrementally and abandoned at this
 * cap, so a model-chosen URL pointing at a huge asset can't be buffered
 * whole into the server process either.
 */
const WEB_FETCH_MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Resolve a model-supplied path to an absolute path inside the sandbox,
 * rejecting anything that escapes the handle's root (../, symlink-ish
 * absolute paths, etc.). Re-rooted per handle rather than a hardcoded
 * constant so container mode (/home/loxaic) and host mode (a per-sandbox
 * directory under SANDBOX_HOST_ROOT) get the same guarantee. Exported so the
 * REST sandbox routes — which touch sandbox files directly, outside the
 * agent tool loop — get the same validation instead of trusting a
 * caller-supplied path outright.
 */
export function resolvePath(handle: SandboxHandle, raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  const abs = posix.resolve(raw.startsWith("/") ? raw : posix.join(handle.workdir, raw));
  if (abs !== handle.root && !abs.startsWith(`${handle.root}/`)) {
    throw new Error(`path escapes the sandbox: ${raw}`);
  }
  return abs;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function executeTool(
  handle: SandboxHandle | null,
  tool: ToolName,
  args: Record<string, unknown>,
  /** The run's abort signal, so Stop reaches a command already executing —
   * only `bash` is long-running enough for it to matter, but it costs nothing
   * to offer and a future slow tool gets it for free (#119). */
  signal?: AbortSignal,
  /** Called with the resolved path just before `fs_write` or `fs_edit`
   * changes a file — what records its file checkpoint (agent/checkpoints.ts).
   * Never for a call that fails before writing. */
  beforeWrite?: (path: string) => Promise<void>,
  options?: {
    /** Extra environment for `bash` — what hardens a read-only command that
     * ran without anyone being asked (engine.ts's READ_ONLY_BASH_ENV). */
    bashEnv?: Record<string, string>;
    /** web_fetch's browser fallback; see `PageRenderer`. */
    renderer?: PageRenderer | null;
    /** How web_fetch reads a document; see `DocumentReader`. */
    readDocument?: DocumentReader;
  },
): Promise<ToolResult> {
  try {
    if (toolNeedsSandbox(tool)) {
      if (!handle) {
        return { ok: false, output: "No sandbox is available for this tool." };
      }
      switch (tool) {
        case "fs_read":  return await runFsRead(handle, args);
        case "fs_write": return await runFsWrite(handle, args, beforeWrite);
        case "fs_edit":  return await runFsEdit(handle, args, beforeWrite);
        case "bash":     return await runBash(handle, args, signal, options?.bashEnv);
        case "grep":     return await runGrep(handle, args);
        case "glob":     return await runGlob(handle, args);
      }
    }
    switch (tool) {
      case "web_fetch": return await runWebFetch(args, options?.renderer ?? null, signal, options?.readDocument);
      case "todo_write": return runTodoWrite(args);
      case "propose_plan": return runProposePlan(args);
      case "ask_questions": return runAskQuestions(args);
      default:
        return { ok: false, output: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    return { ok: false, output: `Error: ${(err as Error).message}` };
  }
}

// ── Plan ──────────────────────────────────────────────────

/**
 * What the model reads once its plan has been handed over (#199). Nothing is
 * executed — the plan is in the call's own arguments, which is what the client
 * renders — and the engine ends the turn after a successful call, so the model
 * reads this beside the user's decision, on its next turn. Written for that
 * moment, and fixed: it is replayed in every later prompt.
 */
export const PLAN_SUBMITTED = "The plan was shown to the user for review.";

function runProposePlan(args: Record<string, unknown>): ToolResult {
  // Refused with a reason rather than accepted: an empty plan would give the
  // user a panel with nothing to decide on, and a refusal does not end the
  // turn, so the model gets to call again with a real one.
  if (typeof args.plan !== "string" || args.plan.trim() === "") {
    return { ok: false, output: "plan must be a non-empty Markdown string." };
  }
  return { ok: true, output: PLAN_SUBMITTED };
}

/** What the model reads once its questions have been handed over — see
 * PLAN_SUBMITTED for why it is fixed. */
export const QUESTIONS_SUBMITTED = "The questions were shown to the user.";

/**
 * Validates an `ask_questions` call. Every refusal says what to fix: it does
 * not end the turn, so the model calls again, and a vague refusal gets the same
 * malformed call back. The client renders exactly what passes, so anything it
 * could not show well (no options, twenty questions, an essay for a label) is
 * refused here rather than worked around there.
 */
export function questionsProblem(args: Record<string, unknown>): string | null {
  const { maxQuestions, minOptions, maxOptions, maxText } = QUESTION_LIMITS;
  const qs = args.questions;
  if (!Array.isArray(qs) || qs.length === 0) return "questions must be a non-empty array.";
  if (qs.length > maxQuestions) return `Ask at most ${String(maxQuestions)} questions at once.`;
  for (const [i, q] of qs.entries()) {
    const n = `Question ${String(i + 1)}`;
    if (typeof q !== "object" || q === null) return `${n} must be an object.`;
    const { question, options, header, multiSelect } = q as Record<string, unknown>;
    if (typeof question !== "string" || question.trim() === "") return `${n} needs a non-empty question.`;
    if (question.length > maxText) return `${n} is longer than ${String(maxText)} characters.`;
    if (header !== undefined && typeof header !== "string") return `${n}'s header must be a string.`;
    if (multiSelect !== undefined && typeof multiSelect !== "boolean") return `${n}'s multiSelect must be true or false.`;
    if (!Array.isArray(options) || options.length < minOptions || options.length > maxOptions) {
      return `${n} needs ${String(minOptions)}-${String(maxOptions)} options.`;
    }
    for (const o of options as unknown[]) {
      const { label, description } = (o ?? {}) as Record<string, unknown>;
      if (typeof label !== "string" || label.trim() === "") return `${n} has an option without a label.`;
      if (label.length > maxText || (typeof description === "string" && description.length > maxText)) {
        return `${n} has an option longer than ${String(maxText)} characters.`;
      }
      if (description !== undefined && typeof description !== "string") return `${n} has a description that is not a string.`;
    }
  }
  return null;
}

function runAskQuestions(args: Record<string, unknown>): ToolResult {
  const problem = questionsProblem(args);
  return problem ? { ok: false, output: problem } : { ok: true, output: QUESTIONS_SUBMITTED };
}

// ── Filesystem ────────────────────────────────────────────

const DEFAULT_READ_LIMIT = 2000;

async function runFsRead(handle: SandboxHandle, args: Record<string, unknown>): Promise<ToolResult> {
  const path = resolvePath(handle, args.path);
  const offset = positiveIntOrDefault(args.offset, 1);
  const limit = positiveIntOrDefault(args.limit, DEFAULT_READ_LIMIT);
  const end = offset + limit - 1;

  // One awk pass does two jobs: print the requested line range, numbered, to
  // stdout, and the file's total line count to stderr, from its END block —
  // which runs only after awk has scanned to EOF regardless of which lines
  // matched the range, so the total is always accurate. One exec instead of
  // a separate `wc -l` round trip. Range selection happens inside the
  // sandbox specifically so only the (small) requested slice has to cross
  // MAX_OUTPUT_BYTES, not the whole file — a naive "read everything, slice
  // in JS" approach would silently fail to page past that cap.
  const res = await handle.exec([
    "bash", "-c",
    'awk -v s="$1" -v e="$2" \'NR>=s && NR<=e {print NR"\\t"$0} END{print NR > "/dev/stderr"}\' "$3"',
    "_", String(offset), String(end), path,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `read failed (exit ${String(res.exitCode)})`);
  }

  const total = Number.parseInt(res.stderr.trim(), 10) || 0;
  if (total === 0) return { ok: true, output: "(empty file)" };
  if (offset > total) {
    return {
      ok: true,
      output: `(offset ${String(offset)} is past the end of the file — it has ${String(total)} line(s))`,
    };
  }
  // What actually came back, not what was asked for. exec caps stdout at
  // MAX_OUTPUT_BYTES, which a long-lined file reaches well before `limit`
  // lines — so trusting `end` here would tell the model nothing was omitted
  // (when the range was fully requested) or point it past lines that were
  // never printed (when it wasn't). Both silently lose content, which is the
  // exact failure this offset/limit design exists to prevent. The output is
  // line-numbered, so the last number printed is the truth.
  const lastPrinted = /(?:^|\n)(\d+)\t[^\n]*$/.exec(res.stdout.replace(/\n$/, ""));
  const shown = lastPrinted ? Number(lastPrinted[1]) : Math.min(end, total);
  const footer =
    shown < total
      ? `\n… ${String(total - shown)} more line(s). Call again with offset=${String(shown + 1)} to continue.`
      : "";
  return { ok: true, output: res.stdout + footer };
}

/** Reads a file, returning null when it doesn't exist (rather than throwing). */
async function readOrNull(handle: SandboxHandle, path: string): Promise<string | null> {
  try {
    return await handle.readFile(path);
  } catch {
    return null;
  }
}

async function runFsWrite(
  handle: SandboxHandle,
  args: Record<string, unknown>,
  beforeWrite?: (path: string) => Promise<void>,
): Promise<ToolResult> {
  const path = resolvePath(handle, args.path);
  const content = requireString(args, "content");
  const oldContent = await readOrNull(handle, path);
  await beforeWrite?.(path);
  await handle.writeFile(path, content);
  return {
    ok: true,
    output: `Wrote ${String(content.length)} bytes to ${path}`,
    diff: [{ path, oldContent, newContent: content }],
  };
}

async function runFsEdit(
  handle: SandboxHandle,
  args: Record<string, unknown>,
  beforeWrite?: (path: string) => Promise<void>,
): Promise<ToolResult> {
  const path = resolvePath(handle, args.path);
  const oldText = requireString(args, "oldText");
  const newText = requireString(args, "newText");
  if (oldText === "") return { ok: false, output: "oldText must not be empty" };

  const current = await readOrNull(handle, path);
  if (current === null) return { ok: false, output: `File not found: ${path}` };

  const occurrences = current.split(oldText).length - 1;
  if (occurrences === 0) return { ok: false, output: `oldText not found in ${path}` };
  if (occurrences > 1) {
    return { ok: false, output: `oldText appears ${String(occurrences)} times in ${path}; it must be unique. Include more surrounding context.` };
  }

  const updated = current.replace(oldText, newText);
  await beforeWrite?.(path);
  await handle.writeFile(path, updated);
  return {
    ok: true,
    output: `Edited ${path}`,
    diff: [{ path, oldContent: current, newContent: updated }],
  };
}

// ── Shell / search ────────────────────────────────────────

async function runBash(
  handle: SandboxHandle,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<ToolResult> {
  const command = requireString(args, "command");
  const res = await handle.exec(["bash", "-lc", command], {
    workdir: handle.workdir,
    timeoutMs: 60_000,
    ...(signal ? { signal } : {}),
    ...(env ? { env } : {}),
  });
  const body = [res.stdout, res.stderr].filter((s) => s.trim() !== "").join("\n");
  return {
    ok: res.exitCode === 0,
    output: `${body}${body ? "\n" : ""}[exit ${String(res.exitCode)}]`,
  };
}

async function runGrep(handle: SandboxHandle, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = requireString(args, "pattern");
  const searchPath = args.path === undefined ? handle.workdir : resolvePath(handle, args.path);
  // rg exits 1 on "no matches", which the pipe to head would mask, so the
  // empty-output case is interpreted here rather than from the exit code.
  const res = await handle.exec([
    "bash", "-c",
    'rg --line-number --no-heading --color=never --smart-case -e "$1" -- "$2" | head -n 500',
    "_", pattern, searchPath,
  ], { workdir: handle.workdir, timeoutMs: 30_000 });

  if (res.stdout.trim() === "") {
    return { ok: true, output: res.stderr.trim() || `No matches for /${pattern}/ in ${searchPath}` };
  }
  return { ok: true, output: res.stdout };
}

async function runGlob(handle: SandboxHandle, args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = requireString(args, "pattern");
  const searchPath = args.path === undefined ? handle.workdir : resolvePath(handle, args.path);
  const res = await handle.exec([
    "bash", "-c",
    'rg --files --hidden --glob "$1" -- "$2" | head -n 500',
    "_", pattern, searchPath,
  ], { workdir: handle.workdir, timeoutMs: 30_000 });

  if (res.stdout.trim() === "") {
    return { ok: true, output: res.stderr.trim() || `No files match ${pattern} under ${searchPath}` };
  }
  return { ok: true, output: res.stdout };
}

// ── Todos (virtual — no sandbox involved) ─────────────────

function runTodoWrite(args: Record<string, unknown>): ToolResult {
  // The one rule for what a call's arguments mean, shared with the client,
  // which reads a stored call back into the same list.
  const todos = parseTodoList(args);
  if (!todos) return { ok: false, output: "todos must be an array" };

  const rendered = todos
    .map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.text}`)
    .join("\n");
  return { ok: true, output: `Todo list updated:\n${rendered}`, todos };
}

// ── web_fetch (runs on the server: sandboxes may have no network) ──

import type { RenderResult } from "../browser/render.ts";
export { assertPublicUrl, isBlockedAddress } from "./address-guard.ts";

const BLOCK_TAGS = ["script", "style"] as const;

/**
 * ASCII-only case folding, applied per character against the original string.
 *
 * The obvious `html.toLowerCase()` and then index into it is **wrong**:
 * `toLowerCase()` does not preserve length. `'\u0130'.toLowerCase()` (U+0130, and
 * every Turkish `İ`) is two code units, so one such character anywhere in a page
 * shifts every subsequent index and the offsets taken from the lowercased copy
 * no longer address the same bytes in the original. The observed result was a
 * `<script>` block escaping the strip entirely and its source going into the
 * prompt — the exact failure this whole path exists to prevent. Every needle
 * here is ASCII, so folding per character sidesteps it (and saves allocating a
 * second copy of the body).
 */
function foldAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** True when the lowercase ASCII `needle` matches `s` at `at`, case-insensitively. */
function matchesAt(s: string, at: number, needle: string): boolean {
  if (at + needle.length > s.length) return false;
  for (let k = 0; k < needle.length; k++) {
    if (foldAscii(s.charCodeAt(at + k)) !== needle.charCodeAt(k)) return false;
  }
  return true;
}

/** Letters and digits, i.e. characters that would continue a tag name. */
function isNameChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** The block element opening at `i`, or null. Mirrors `\b`: the character
 * after the name must not continue it, so `<script<` counts and `<scripty>`
 * does not. */
function blockTagAt(html: string, i: number): string | null {
  for (const tag of BLOCK_TAGS) {
    if (!matchesAt(html, i, `<${tag}`)) continue;
    const after = html.charCodeAt(i + tag.length + 1);
    if (Number.isNaN(after) || !isNameChar(after)) return tag;
  }
  return null;
}

/**
 * Index just past the matching close tag, or -1 if there isn't one.
 *
 * `</script >` and `</SCRIPT\n>` are valid HTML5, so whitespace before the `>`
 * has to be tolerated — requiring the exact bytes `</script>` is what made a
 * complete page look unterminated, which then let the truncation cleanup eat
 * it. Scans `<` positions with indexOf, which advance monotonically, so the
 * whole loop is linear and there is no backtracking to exploit.
 */
function closeTagEnd(html: string, tag: string, from: number): number {
  const needle = `</${tag}`;
  for (let at = html.indexOf("<", from); at !== -1; at = html.indexOf("<", at + 1)) {
    if (!matchesAt(html, at, needle)) continue;
    let i = at + needle.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === ">") return i + 1;
  }
  return -1;
}

/**
 * Strips `<script>`/`<style>` blocks and every remaining tag, in one forward
 * pass.
 *
 * **Deliberately not regex replacements.** Every obvious pattern here is
 * quadratic on hostile input, and `WEB_FETCH_MAX_RAW_BYTES` (2 MB) is the
 * multiplier:
 *
 *   - `/<script[\s\S]*?<\/script>/g` — for every unclosed `<script` the engine
 *     expands the lazy quantifier to end-of-input hunting for a close tag that
 *     never comes. Measured on `'<script'.repeat(n)`: 66 ms at 50 KB, 254 ms at
 *     100 KB, 1.0 s at 200 KB, 4.0 s at 400 KB — roughly 100 s extrapolated to
 *     the cap.
 *   - `/<[^>]+>/g` — the same shape, and reachable even when the block patterns
 *     match nothing: input full of `<` with no `>` makes it scan to end-of-input
 *     from every one of them. This one hung a 2 MB test outright.
 *
 * Either is synchronous on the single Node thread, neither is covered by
 * WEB_FETCH_TIMEOUT_MS (the timeout aborts the fetch, not the CPU-bound strip
 * that follows), and the URL is chosen by the model — so a page of `<` repeats
 * would stall every user's stream at once. Everything below is indexOf-based
 * and linear.
 *
 * `dropUnterminated` is the truncation cleanup, and it is deliberately *not*
 * unconditional. A body cut at the raw cap can end inside a block, and
 * everything from that opener on is markup — that is how one news fetch put
 * 100 KB of raw CSS into a prompt. But on a *complete* page an opener with no
 * close is malformed rather than severed, and eating to end-of-input there
 * silently reduces the page to nothing. Only the caller knows which it is.
 */
export function stripMarkup(html: string, dropUnterminated: boolean): string {
  // Once a close tag can't be found from one position it can't be found from
  // any later one either — remembering that is what keeps a page full of
  // unclosed openers from re-scanning to the end for each of them.
  const exhausted = new Set<string>();
  let out = "";
  let cursor = 0;
  let scan = 0;

  for (;;) {
    const lt = html.indexOf("<", scan);
    if (lt === -1) break;

    const tag = blockTagAt(html, lt);
    if (tag !== null) {
      const end = exhausted.has(tag) ? -1 : closeTagEnd(html, tag, lt + tag.length + 1);
      if (end !== -1) {
        out += `${html.slice(cursor, lt)} `;
        cursor = end;
        scan = end;
        continue;
      }
      exhausted.add(tag);
      if (dropUnterminated) return `${out}${html.slice(cursor, lt)} `;
      // Otherwise fall through and treat the opener as an ordinary tag.
    }

    const gt = html.indexOf(">", lt + 1);
    // No `>` left anywhere, so nothing after this can be a tag.
    if (gt === -1) break;
    out += `${html.slice(cursor, lt)} `;
    cursor = gt + 1;
    scan = gt + 1;
  }

  return out + html.slice(cursor);
}

/**
 * Markup to readable text. `rawTruncated` says whether the body was cut at
 * WEB_FETCH_MAX_RAW_BYTES, which is what licenses the unterminated-block
 * cleanup — see stripMarkup.
 */
export function htmlToText(html: string, rawTruncated = false): string {
  return (
    stripMarkup(html, rawTruncated)
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Whitespace tidying, in forms with nothing to backtrack over. The
      // previous `/\s+\n/g` was quadratic on a long run of spaces with no
      // newline — which is exactly what stripping a large page leaves behind.
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * What a fetched body contributes to the prompt: markup stripped FIRST, then
 * the *extracted text* truncated.
 *
 * The order is the whole point. Capping the source instead both spends the
 * budget on markup the model never sees and, worse, can sever a <style> or
 * <script> so htmlToText's paired patterns match nothing — which is how a
 * single news fetch once put 100 KB of raw CSS into a prompt and cost 109
 * seconds of prompt evaluation. Pure and exported so that ordering can be
 * asserted without a network round-trip.
 */
export function extractFetchText(body: string, contentType: string, rawTruncated: boolean): string {
  const text = contentType.includes("html") ? htmlToText(body, rawTruncated) : body;
  if (text.length > WEB_FETCH_MAX_BYTES) {
    return `${text.slice(0, WEB_FETCH_MAX_BYTES)}\n… [truncated at ${String(WEB_FETCH_MAX_BYTES)} characters of extracted text]`;
  }
  if (rawTruncated) {
    return `${text}\n… [page was larger than ${String(WEB_FETCH_MAX_RAW_BYTES)} bytes; the rest was not read]`;
  }
  return text;
}

/** Types that are never text, whatever their bytes. Anything else unknown is
 * read as text, which is what catches a mislabelled one: see `NUL` below. */
const BINARY_MIME_PREFIXES = ["image/", "audio/", "video/", "font/"];
const BINARY_MIMES = new Set([
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/wasm",
  "application/java-archive",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/x-msdownload",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
]);

function mimeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * How web_fetch reads a response, from its Content-Type alone. `document`
 * bytes go to the sandbox, never into the prompt. `unlabelled` says nothing
 * either way, so its bytes decide (a PDF is often served as octet-stream).
 */
export function classifyFetchBody(contentType: string): "text" | "document" | "unlabelled" | "binary" {
  const mime = mimeOf(contentType);
  if (mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream") return "unlabelled";
  if (mime.endsWith("+xml") || mime.endsWith("+json")) return "text";
  if (attachmentClass(mime) === "document") return "document";
  if (BINARY_MIMES.has(mime) || BINARY_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return "binary";
  return "text";
}

function notReadable(url: URL, contentType: string): ToolResult {
  const mime = mimeOf(contentType);
  const type = mime && mime !== "application/octet-stream" && mime !== "binary/octet-stream" ? ` (${mime})` : "";
  return { ok: false, output: `${url.href} is a binary file${type}. web_fetch reads text, web pages and documents.` };
}

function tooLarge(url: URL, bytes: number | null): ToolResult {
  const limit = `${String(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`;
  const size = bytes === null ? "larger than" : `${(bytes / 1024 / 1024).toFixed(1)} MB, over`;
  return { ok: false, output: `${url.href} is ${size} the ${limit} web_fetch can read.` };
}

/**
 * Bytes a text-labelled response must not be holding: a binary file served
 * under a text type, or with no useful type at all. NUL rather than "invalid
 * UTF-8", which would also refuse an ordinary page in Latin-1.
 */
const NUL = "\u0000";

/**
 * A document's bytes to text: `document` and `unlabelled` responses. Buffered
 * whole, under a cap, because a parser needs all of it; a PDF's index of
 * its contents is at the end, so the first part alone reads as damaged.
 */
async function readFetchedDocument(
  response: GuardedResponse,
  url: URL,
  contentType: string,
  signal: AbortSignal | undefined,
  readDocument: DocumentReader | undefined,
): Promise<ToolResult> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return tooLarge(url, declared);
  }
  const bytes = await readBoundedBytes(response, MAX_DOCUMENT_BYTES);
  if (!bytes) return tooLarge(url, null);

  const labelled = classifyFetchBody(contentType) === "document";
  const mime = labelled ? mimeOf(contentType) : sniffMime(bytes.subarray(0, 16));
  if (!mime || attachmentClass(mime) !== "document") {
    if (bytes.includes(0)) return notReadable(url, contentType);
    // Nothing said what it is, and it reads as text.
    const text = new TextDecoder("utf-8").decode(bytes.subarray(0, WEB_FETCH_MAX_RAW_BYTES));
    return { ok: true, output: extractFetchText(text, contentType, bytes.length > WEB_FETCH_MAX_RAW_BYTES) };
  }
  if (!readDocument) return { ok: false, output: `Documents can't be read here, so ${url.href} was not.` };
  const read = await readDocument(bytes, mime, signal);
  if (!read.ok) return { ok: false, output: `${url.href}: ${read.reason}` };
  return { ok: true, output: extractFetchText(read.text, "text/plain", false) };
}

/** What the plain fetch saw, for deciding whether the browser should try. */
export interface PlainFetchSignal {
  /** The guard refused the address. Never worth a browser: it would be refused
   * the same way. */
  blocked?: boolean;
  status?: number;
  networkError?: string;
  contentType?: string;
  html?: string;
  extractedText?: string;
}

/** Statuses a site sends a script but not a browser: bot walls, rate limits,
 * "enable JavaScript" interstitials. A 404 is not here; a browser gets the
 * same 404. */
const RENDER_STATUSES = new Set([401, 403, 406, 429, 451, 503]);
/** Connection failures that come from refusing non-browser clients (a reset
 * after the TLS hello), not from a host that is simply down. */
const RENDER_NETWORK_ERRORS = /ECONNRESET|socket hang up|other side closed|UND_ERR_SOCKET|EPROTO|handshake/i;
/** Below this much extracted text, an HTML page that ships script is taken to
 * build itself in the browser. */
const RENDER_MIN_TEXT = 200;

/**
 * Whether web_fetch should fall back to the browser, and the reason it gives.
 * Pure: every trigger and non-trigger is pinned by a test.
 */
export function shouldRender(signal: PlainFetchSignal): { render: boolean; reason: string } {
  if (signal.blocked) return { render: false, reason: "" };
  if (signal.status !== undefined && RENDER_STATUSES.has(signal.status)) {
    return { render: true, reason: `the plain fetch returned ${String(signal.status)}` };
  }
  if (signal.networkError && RENDER_NETWORK_ERRORS.test(signal.networkError)) {
    return { render: true, reason: "the site dropped the plain fetch's connection" };
  }
  if (
    signal.status !== undefined && signal.status >= 200 && signal.status < 300 &&
    /html/i.test(signal.contentType ?? "") &&
    (signal.extractedText ?? "").trim().length < RENDER_MIN_TEXT &&
    /<script\b/i.test(signal.html ?? "")
  ) {
    return { render: true, reason: "the page builds itself with JavaScript" };
  }
  return { render: false, reason: "" };
}

async function plainFetch(
  start: URL,
  runSignal: AbortSignal | undefined,
  readDocument: DocumentReader | undefined,
): Promise<{ result: ToolResult; signal: PlainFetchSignal }> {
  let url = start;
  const controller = new AbortController();
  let timeoutMs = WEB_FETCH_TIMEOUT_MS;
  let timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
  try {
    let response: GuardedResponse | null = null;
    // Redirects are followed by hand so every hop gets the address check —
    // following them inside fetch would let a public URL bounce to 169.254.169.254.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await guardedFetch(url, {
        signal,
        headers: { "User-Agent": "Loxaic-Agent/1.0", Accept: "text/*, application/json;q=0.9, */*;q=0.5" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        url = new URL(location, url);
        continue;
      }
      response = res;
      break;
    }
    if (!response) return { result: { ok: false, output: `Too many redirects (>${String(MAX_REDIRECTS)})` }, signal: {} };
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        result: { ok: false, output: `HTTP ${String(response.status)} ${response.statusText} for ${url.href}` },
        signal: { status: response.status, contentType },
      };
    }
    const kind = classifyFetchBody(contentType);
    const reached = { status: response.status, contentType };
    if (kind === "binary") {
      await response.body?.cancel().catch(() => undefined);
      return { result: notReadable(url, contentType), signal: reached };
    }
    if (kind !== "text") {
      clearTimeout(timer);
      timeoutMs = WEB_FETCH_DOCUMENT_TIMEOUT_MS;
      timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      return { result: await readFetchedDocument(response, url, contentType, signal, readDocument), signal: reached };
    }
    const { text: bodyText, truncated: rawTruncated } = await readBoundedText(response);
    if (bodyText.includes(NUL)) return { result: notReadable(url, contentType), signal: reached };
    const extracted = extractFetchText(bodyText, contentType, rawTruncated);
    return {
      result: { ok: true, output: extracted },
      signal: { status: response.status, contentType, html: bodyText, extractedText: extracted },
    };
  } catch (err) {
    if (err instanceof BlockedTargetError) {
      return { result: { ok: false, output: `Fetch failed: ${err.message}` }, signal: { blocked: true } };
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(" ");
    const message = runSignal?.aborted
      ? "Stopped by the user."
      : (err as Error).name === "AbortError"
        ? `Request timed out after ${String(timeoutMs)}ms`
        : detail || (err as Error).message;
    return { result: { ok: false, output: `Fetch failed: ${message}` }, signal: { networkError: message } };
  } finally {
    clearTimeout(timer);
  }
}

/** The browser's answer, in web_fetch's shape and under its text ceiling, so
 * the fallback cannot quietly spend more of the window than the fast path. */
async function renderedFetch(url: URL, renderer: PageRenderer, forModel: boolean, why: string | null): Promise<ToolResult> {
  try {
    const page = await renderer(url, { screenshot: forModel ? "required" : "best-effort", maxTextChars: WEB_FETCH_MAX_BYTES });
    // What the browser drew goes to the person even when the page is an error.
    const image = page.image ? { image: { ...page.image, forModel } } : {};
    if (page.status !== null && page.status >= 400) {
      return { ok: false, output: `HTTP ${String(page.status)} for ${page.finalUrl} (in the browser too)`, browser: true, ...image };
    }
    const truncated = page.text.length > WEB_FETCH_MAX_BYTES;
    const body = truncated
      ? `${page.text.slice(0, WEB_FETCH_MAX_BYTES)}\n… [truncated at ${String(WEB_FETCH_MAX_BYTES)} characters of rendered text]`
      : page.text.trim().length > 0 ? page.text : "(the page rendered no readable text)";
    const header = [
      why ? `[Rendered in a browser: ${why}.]` : "[Rendered in a browser.]",
      page.title ? `Title: ${page.title}` : null,
      page.finalUrl !== url.href ? `URL: ${page.finalUrl}` : null,
      forModel && page.image ? "A screenshot of the page is attached." : null,
    ].filter((line): line is string => line !== null).join("\n");
    return { ok: true, output: `${header}\n\n${body}`, browser: true, ...image };
  } catch (err) {
    return { ok: false, output: (err as Error).message, browser: true };
  }
}

async function runWebFetch(
  args: Record<string, unknown>,
  renderer: PageRenderer | null,
  signal: AbortSignal | undefined,
  readDocument: DocumentReader | undefined,
): Promise<ToolResult> {
  const raw = requireString(args, "url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, output: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, output: `Fetch failed: only http and https URLs are allowed (got ${url.protocol})` };
  }
  if (args.screenshot === true) {
    if (!renderer) return { ok: false, output: "Screenshots need web browsing, which is off on this server." };
    return await renderedFetch(url, renderer, true, null);
  }
  const plain = await plainFetch(url, signal, readDocument);
  const decision = shouldRender(plain.signal);
  if (!decision.render || !renderer) return plain.result;
  const rendered = await renderedFetch(url, renderer, false, decision.reason);
  if (rendered.ok) return rendered;
  return { ...rendered, output: `${plain.result.output}\nThe browser fallback failed too: ${rendered.output}` };
}

/** A response's bytes, or null past `maxBytes`. Streamed for the reason
 * `readBoundedText` is: a Content-Length is only a claim. */
async function readBoundedBytes(response: GuardedResponse, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = (response.body as WebReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      read += value.length;
      if (read > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Read a response body up to WEB_FETCH_MAX_RAW_BYTES and decode it as UTF-8.
 *
 * Streamed rather than `arrayBuffer()`d because that buffers the *whole*
 * response before any cap can apply — a model-chosen URL is all it takes to
 * pull an arbitrarily large file into the server's heap. Decoding is
 * incremental (`stream: true`) so a chunk boundary landing mid-UTF-8-sequence
 * doesn't corrupt that character, the way slicing a Buffer at a fixed byte
 * offset does.
 */
async function readBoundedText(response: GuardedResponse): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = (response.body as WebReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let read = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (read + value.length > WEB_FETCH_MAX_RAW_BYTES) {
        text += decoder.decode(value.subarray(0, WEB_FETCH_MAX_RAW_BYTES - read));
        truncated = true;
        break;
      }
      read += value.length;
      text += decoder.decode(value, { stream: true });
    }
    if (!truncated) text += decoder.decode();
  } finally {
    // cancel(), not releaseLock(): releasing only detaches the reader, leaving
    // the body live with nothing draining it, and runWebFetch's `finally`
    // clears the abort timer the moment this returns — so on the truncation
    // path nothing would tear the connection down at all. The heap would stay
    // bounded while the socket and the bandwidth did not. cancel() releases
    // the lock itself.
    await reader.cancel().catch(() => undefined);
  }
  return { text, truncated };
}
