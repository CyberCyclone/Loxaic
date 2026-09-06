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
        case "bash":     return await runBash(handle, args);
        case "grep":     return await runGrep(handle, args);
        case "glob":     return await runGlob(handle, args);
      }
    }
    switch (tool) {
      case "web_fetch": return await runWebFetch(args);
      case "todo_write": return runTodoWrite(args);
      default:
        return { ok: false, output: `Unknown tool: ${tool}` };
    }
  } catch (err) {
    return { ok: false, output: `Error: ${(err as Error).message}` };
  }
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

async function runBash(handle: SandboxHandle, args: Record<string, unknown>): Promise<ToolResult> {
  const command = requireString(args, "command");
  const res = await handle.exec(["bash", "-lc", command], {
    workdir: handle.workdir,
    timeoutMs: 60_000,
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

/**
 * Markup to readable text.
 *
 * The trailing-unterminated pass is load-bearing, not defensive: a body cut
 * off at WEB_FETCH_MAX_RAW_BYTES can end *inside* a <style> or <script>, and
 * the paired patterns above — non-greedy, and requiring a closing tag — then
 * match nothing at all, leaving the entire tail of CSS or JS in place for the
 * generic tag strip to hand straight to the model. That is exactly how one
 * news fetch put 100 KB of raw CSS into a prompt. Once the paired blocks are
 * gone, any remaining opening tag has no partner and can only be the start of
 * a block truncation cut short, so everything from it to the end is markup.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:script|style)\b[\s\S]*$/i, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
  const text = contentType.includes("html") ? htmlToText(body) : body;
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
    // Releasing the lock lets the runtime tear the (possibly unfinished)
    // body down; the caller's AbortController covers the rest.
    reader.releaseLock();
  }
  return { text, truncated };
}
