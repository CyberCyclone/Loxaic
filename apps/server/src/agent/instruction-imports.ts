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
 * The `@path` mentions in a file, in order, each once. A mention starts a line
 * or follows whitespace (so an email address is not one), and is ignored
 * inside fenced code and inline code spans — the same places Claude Code
 * ignores it. Trailing sentence punctuation is not part of the path.
 */
export function findImportRefs(text: string): string[] {
  const refs: string[] = [];
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
    const prose = line.replace(/(`+)[\s\S]*?\1/g, " ");
    for (const m of prose.matchAll(/(?:^|\s)@([^\s`<>()[\]{}"']+)/g)) {
      const ref = m[1].replace(/[.,;:!?]+$/, "");
      if (ref && !ref.includes("://") && !refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
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
    for (const ref of findImportRefs(text).slice(0, MAX_REFS_PER_FILE)) {
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
