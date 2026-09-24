import { promises as dns } from "node:dns";
import posix from "node:path/posix";
import type { SandboxHandle } from "../sandbox/provider.ts";
import type { FileDiff, Todo, ToolName } from "@loxaic/agent";

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
}

const WEB_FETCH_TIMEOUT_MS = 15_000;
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
): Promise<ToolResult> {
  try {
    if (toolNeedsSandbox(tool)) {
      if (!handle) {
        return { ok: false, output: "No sandbox is available for this tool." };
      }
      switch (tool) {
        case "fs_read":  return await runFsRead(handle, args);
        case "fs_write": return await runFsWrite(handle, args);
        case "fs_edit":  return await runFsEdit(handle, args);
        case "bash":     return await runBash(handle, args, signal);
        case "grep":     return await runGrep(handle, args);
        case "glob":     return await runGlob(handle, args);
      }
    }
    switch (tool) {
      case "web_fetch": return await runWebFetch(args);
      case "todo_write": return runTodoWrite(args);
      case "propose_plan": return runProposePlan(args);
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

async function runFsWrite(handle: SandboxHandle, args: Record<string, unknown>): Promise<ToolResult> {
  const path = resolvePath(handle, args.path);
  const content = requireString(args, "content");
  const oldContent = await readOrNull(handle, path);
  await handle.writeFile(path, content);
  return {
    ok: true,
    output: `Wrote ${String(content.length)} bytes to ${path}`,
    diff: [{ path, oldContent, newContent: content }],
  };
}

async function runFsEdit(handle: SandboxHandle, args: Record<string, unknown>): Promise<ToolResult> {
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
): Promise<ToolResult> {
  const command = requireString(args, "command");
  const res = await handle.exec(["bash", "-lc", command], {
    workdir: handle.workdir,
    timeoutMs: 60_000,
    ...(signal ? { signal } : {}),
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
  const raw = args.todos;
  if (!Array.isArray(raw)) return { ok: false, output: "todos must be an array" };

  const todos: Todo[] = raw.map((t, i) => {
    const item = (t ?? {}) as Record<string, unknown>;
    const status = item.status;
    return {
      id: typeof item.id === "string" ? item.id : String(i + 1),
      text:
        typeof item.text === "string" ? item.text
        : typeof item.text === "number" || typeof item.text === "boolean" ? String(item.text)
        : "",
      status: status === "completed" || status === "in_progress" ? status : "pending",
    };
  });

  const rendered = todos
    .map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.text}`)
    .join("\n");
  return { ok: true, output: `Todo list updated:\n${rendered}`, todos };
}

// ── web_fetch (runs on the server: sandboxes may have no network) ──

/**
 * True for addresses that must never be reachable from a model-chosen URL:
 * loopback, link-local, and the RFC1918 / carrier-grade / benchmarking
 * ranges that make up a typical private network.
 */
export function isBlockedAddress(ip: string, family: number): boolean {
  if (family === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;     // RFC1918
    if (a === 192 && b === 168) return true;              // RFC1918
    if (a === 192 && b === 0) return true;                // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true;                            // multicast + reserved
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  // IPv4-mapped (::ffff:10.0.0.1) has to be unwrapped and re-checked.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isBlockedAddress(mapped[1], 4);
  if (/^f[cd]/.test(v6)) return true;   // fc00::/7 unique local
  if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link local
  return false;
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Every A/AAAA record must be public — one private answer is enough to
  // reach an internal service, so a mixed result is rejected outright.
  const records = await dns.lookup(host, { all: true }).catch(() => {
    throw new Error(`could not resolve host: ${host}`);
  });
  if (records.length === 0) throw new Error(`could not resolve host: ${host}`);
  for (const r of records) {
    if (isBlockedAddress(r.address, r.family)) {
      throw new Error(`refusing to fetch a private or loopback address (${host} → ${r.address})`);
    }
  }
}

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

async function runWebFetch(args: Record<string, unknown>): Promise<ToolResult> {
  const raw = requireString(args, "url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, output: `Invalid URL: ${raw}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, WEB_FETCH_TIMEOUT_MS);
  try {
    let response: Response | null = null;
    // Redirects are followed by hand so every hop gets the SSRF check —
    // `redirect: "follow"` would let a public URL bounce to 169.254.169.254.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(url);
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Loxaic-Agent/1.0", Accept: "text/*, application/json;q=0.9, */*;q=0.5" },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      response = res;
      break;
    }
    if (!response) return { ok: false, output: `Too many redirects (>${String(MAX_REDIRECTS)})` };
    if (!response.ok) return { ok: false, output: `HTTP ${String(response.status)} ${response.statusText} for ${url.href}` };

    const { text: bodyText, truncated: rawTruncated } = await readBoundedText(response);
    return {
      ok: true,
      output: extractFetchText(bodyText, response.headers.get("content-type") ?? "", rawTruncated),
    };
  } catch (err) {
    const message = (err as Error).name === "AbortError"
      ? `Request timed out after ${String(WEB_FETCH_TIMEOUT_MS)}ms`
      : (err as Error).message;
    return { ok: false, output: `Fetch failed: ${message}` };
  } finally {
    clearTimeout(timer);
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
async function readBoundedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
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
