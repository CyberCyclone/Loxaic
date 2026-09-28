/**
 * `@path` imports in a project's instructions file — Claude Code's syntax for
 * CLAUDE.md, which Gemini CLI also uses for GEMINI.md. A repository that keeps
 * its rules in `docs/` and a two-line CLAUDE.md naming them would otherwise
 * give the agent two lines.
 *
 * Only those two files' imports are followed (and, recursively, the files
 * they import). AGENTS.md has no import syntax, and in one `@loxaic/db` is a
 * package name, not a file. A mention is followed only when it names a file
 * that exists inside the repository; anything else — a handle, a scoped
 * package, a path outside the repo — stays the literal text it was.
 *
 * Pure apart from the reader it is handed, so the parsing and the bounds are
 * tested without a repository.
 */
import posix from "node:path/posix";
import type { ImportedInstructions } from "@loxaic/types";

/** Files whose tools define the `@path` syntax; matched by name, any directory. */
const IMPORTING_FILES = new Set(["CLAUDE.md", "GEMINI.md"]);

/** How deep imports are followed from the file that started it. */
export const MAX_IMPORT_DEPTH = 4;
/** Files imported in all, across every level. */
export const MAX_IMPORTED_FILES = 20;
/** Mentions looked up per file: each is a read, and a file listing forty
 * `@someone` handles must not cost forty lookups. */
const MAX_REFS_PER_FILE = 20;

export function importsEnabledFor(path: string): boolean {
  return IMPORTING_FILES.has(posix.basename(path));
}

/**
 * The `@path` mentions in a file, in order, each once, and at most
 * `MAX_REFS_PER_FILE` of them — nothing past that is ever followed, so nothing
 * past it is scanned. A mention starts a line or follows whitespace (so an
 * email address is not one), and is ignored inside fenced code and inline code
 * spans — the same places Claude Code ignores it. Trailing sentence
 * punctuation is not part of the path.
 *
 * Linear in the file, deliberately, and so is everything it calls. It runs on
 * the event loop over a file anyone can write — a crafted repository, or a
 * nested CLAUDE.md the model wrote itself — and three quadratic steps once
 * blocked it for tens of seconds on a 1 MB file: a list membership check over
 * every mention, a backreference regex for inline code, and a trailing
 * punctuation regex, each of which backtracks on a long enough run.
 */
export function findImportRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence[0]) && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const m of stripInlineCode(line).matchAll(/(?:^|\s)@([^\s`<>()[\]{}"']+)/g)) {
      const ref = trimTrailingPunctuation(m[1]);
      if (!ref || ref.includes("://") || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
      if (refs.length >= MAX_REFS_PER_FILE) return refs;
    }
  }
  return refs;
}

/**
 * A line with its inline code spans replaced by a space. A run of backticks
 * opens a span that the next run of the *same* length closes (CommonMark's
 * rule); a run nothing closes stays literal. One pass to list the runs, one to
 * link each to the next run of its length, one to cut — where a backreference
 * regex backtracked quadratically on a long unclosed run.
 */
export function stripInlineCode(line: string): string {
  if (!line.includes("`")) return line;
  const runs: { start: number; length: number }[] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "`") j++;
    runs.push({ start: i, length: j - i });
    i = j;
  }
  const closer = new Array<number>(runs.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    closer[k] = nextOfLength.get(runs[k].length) ?? -1;
    nextOfLength.set(runs[k].length, k);
  }
  let out = "";
  let from = 0;
  for (let k = 0; k < runs.length; ) {
    const close = closer[k];
    if (close === -1) {
      k++;
      continue;
    }
    out += `${line.slice(from, runs[k].start)} `;
    from = runs[close].start + runs[close].length;
    k = close + 1;
  }
  return out + line.slice(from);
}

const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

function trimTrailingPunctuation(ref: string): string {
  let end = ref.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(ref[end - 1])) end--;
  return ref.slice(0, end);
}

/**
 * A mention as a path relative to the repository root, or null when it cannot
 * name a file inside it: absolute, home-relative, or climbing out. Relative
 * to the importing file's own directory, as Claude Code resolves it. Lexical
 * only — the reader is what re-checks a real path against the root, which is
 * what stops a symlink leading out.
 */
export function resolveImportPath(fromFile: string, ref: string): string | null {
  if (ref.startsWith("/") || ref.startsWith("~") || ref.includes("\0")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), ref));
  if (joined === "." || joined === ".." || joined.startsWith("../") || posix.isAbsolute(joined)) return null;
  return joined;
}

/** Reads a repository-relative path, at most `maxBytes` of it; null when it
 * is not a file inside the repository. */
export type ReadInstructionFile = (
  relPath: string,
  maxBytes: number,
) => Promise<{ text: string; bytes: number; truncated: boolean } | null>;

/**
 * Every file `rootPath` imports, depth first in the order they are mentioned,
 * each once — a cycle, or a file imported twice, is read once. Bounded by
 * depth, by file count, and by `maxBytes` across all of them; when the bytes
 * run out, later imports are simply not followed.
 */
export async function collectImports(
  rootPath: string,
  rootText: string,
  read: ReadInstructionFile,
  maxBytes: number,
): Promise<ImportedInstructions[]> {
  if (!importsEnabledFor(rootPath)) return [];
  const out: ImportedInstructions[] = [];
  const seen = new Set<string>([rootPath]);
  let remaining = maxBytes;

  const walk = async (from: string, text: string, depth: number): Promise<void> => {
    if (depth > MAX_IMPORT_DEPTH) return;
    for (const ref of findImportRefs(text)) {
      if (out.length >= MAX_IMPORTED_FILES || remaining <= 0) return;
      const path = resolveImportPath(from, ref);
      if (path === null || seen.has(path)) continue;
      seen.add(path);
      // An import is a secondary file: failing to read one leaves it out,
      // never the file that imported it — one 502 on docs/rules.md must not
      // cost the turn its CLAUDE.md. (A stop mid-lookup fails every read;
      // ensureInstructions stores nothing for an aborted lookup.)
      const got = await read(path, remaining).catch((err: unknown) => {
        console.warn(`could not read imported instructions ${path}: ${(err as Error).message}`);
        return null;
      });
      if (!got) continue;
      remaining -= got.bytes;
      out.push({ path, importedBy: from, text: got.text, sourceBytes: got.bytes, sourceTruncated: got.truncated });
      await walk(path, got.text, depth + 1);
    }
  };
  await walk(rootPath, rootText, 1);
  return out;
}
