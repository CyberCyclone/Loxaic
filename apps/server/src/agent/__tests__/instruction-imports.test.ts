import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_DEPTH,
  MAX_IMPORTED_FILES,
  collectImports,
  findImportRefs,
  stripInlineCode,
  importsEnabledFor,
  resolveImportPath,
  type ReadInstructionFile,
} from "../instruction-imports.ts";

/**
 * `@path` imports: which mentions count, where they resolve, and the bounds
 * on following them. The reader is a map, so every rule is exercised without
 * a repository.
 */
function reader(files: Partial<Record<string, string>>): ReadInstructionFile & { reads: string[] } {
  const reads: string[] = [];
  const read = ((path: string, maxBytes: number) => {
    reads.push(path);
    const text = files[path];
    if (text === undefined) return Promise.resolve(null);
    const bytes = Buffer.byteLength(text);
    const cut = Buffer.from(text).subarray(0, maxBytes).toString();
    return Promise.resolve({ text: cut, bytes: Math.min(bytes, maxBytes), truncated: bytes > maxBytes });
  }) as ReadInstructionFile & { reads: string[] };
  read.reads = reads;
  return read;
}

describe("which mentions are imports", () => {
  it("finds mentions at a line's start or after whitespace, each once, in order", () => {
    expect(findImportRefs("@AGENTS.md\nSee @docs/git.md and @docs/git.md, then @README.")).toEqual([
      "AGENTS.md",
      "docs/git.md",
      "README",
    ]);
  });

  it("ignores code, email addresses and URLs", () => {
    const text = [
      "Contact casey@example.com or visit @https://example.com/x.",
      "Inline `@not/this.md` and ``@nor/this.md`` stay literal.",
      "```",
      "@inside/fence.md",
      "```",
      "~~~",
      "@inside/tilde.md",
      "~~~",
      "But @real/one.md counts.",
    ].join("\n");
    expect(findImportRefs(text)).toEqual(["real/one.md"]);
  });

  it("closes an inline span only on a run of the same length, and leaves an unclosed run literal", () => {
    expect(stripInlineCode("a `x` b")).toBe("a   b");
    expect(stripInlineCode("a ``x ` y`` b")).toBe("a   b");
    expect(stripInlineCode("a ``x` b")).toBe("a ``x` b");
    expect(findImportRefs("Run `@not/this.md` then ``` @real/two.md")).toEqual(["real/two.md"]);
  });

  it("stops at the per-file cap, since nothing past it is followed", () => {
    const text = Array.from({ length: 50 }, (_, i) => `@docs/${String(i)}.md`).join(" ");
    expect(findImportRefs(text)).toHaveLength(20);
    expect(findImportRefs(text)[19]).toBe("docs/19.md");
  });

  /**
   * Each of these held the event loop for tens of seconds on the original
   * code — every user's stream, the scheduler and /health with it — on a file
   * any signed-in user can put in a repository, or the model can write.
   * Generous bounds: linear work takes milliseconds.
   */
  describe("stays linear on a hostile file", () => {
    const timed = (text: string): number => {
      const start = performance.now();
      findImportRefs(text);
      return performance.now() - start;
    };

    it("a megabyte of distinct mentions", () => {
      // 42.5 s measured on the quadratic membership check.
      const text = Array.from({ length: 150_000 }, (_, i) => `@m${String(i)}`).join(" ");
      expect(timed(text)).toBeLessThan(1_000);
    });

    it("a long run of backticks nothing closes", () => {
      // 27.0 s measured on the backreference regex.
      expect(timed(`x ${"`".repeat(300_000)}`)).toBeLessThan(1_000);
    });

    it("a mention that is a long run of punctuation", () => {
      expect(timed(`@${".".repeat(300_000)}x`)).toBeLessThan(1_000);
      expect(findImportRefs(`@${".".repeat(1_000)}x`)).toEqual([`${".".repeat(1_000)}x`]);
    });

    it("many backtick runs of different lengths", () => {
      const text = Array.from({ length: 3_000 }, (_, i) => "`".repeat((i % 50) + 1)).join(" a ");
      expect(timed(text)).toBeLessThan(1_000);
    });
  });

  it("is only followed in the files whose tools define it", () => {
    expect(importsEnabledFor("CLAUDE.md")).toBe(true);
    expect(importsEnabledFor("pkg/GEMINI.md")).toBe(true);
    expect(importsEnabledFor("AGENTS.md")).toBe(false);
    expect(importsEnabledFor(".github/copilot-instructions.md")).toBe(false);
  });
});

describe("where a mention resolves", () => {
  it("is relative to the importing file's directory", () => {
    expect(resolveImportPath("CLAUDE.md", "docs/git.md")).toBe("docs/git.md");
    expect(resolveImportPath("pkg/sub/CLAUDE.md", "../rules.md")).toBe("pkg/rules.md");
    expect(resolveImportPath("pkg/CLAUDE.md", "./a/../b.md")).toBe("pkg/b.md");
  });

  it("never leaves the repository", () => {
    expect(resolveImportPath("CLAUDE.md", "../outside.md")).toBeNull();
    expect(resolveImportPath("pkg/CLAUDE.md", "../../etc/passwd")).toBeNull();
    expect(resolveImportPath("CLAUDE.md", "/etc/passwd")).toBeNull();
    expect(resolveImportPath("CLAUDE.md", "~/.ssh/id_ed25519")).toBeNull();
    expect(resolveImportPath("CLAUDE.md", ".")).toBeNull();
  });
});

describe("following imports", () => {
  it("reads what exists, depth first, and leaves the rest as text", async () => {
    const read = reader({ "docs/a.md": "A, which uses @b.md", "docs/b.md": "B" });
    const imports = await collectImports("CLAUDE.md", "@docs/a.md and @someone and @docs/missing.md", read, 1e6);
    expect(imports.map((i) => [i.path, i.importedBy])).toEqual([
      ["docs/a.md", "CLAUDE.md"],
      ["docs/b.md", "docs/a.md"],
    ]);
    expect(read.reads).toEqual(["docs/a.md", "docs/b.md", "someone", "docs/missing.md"]);
  });

  it("reads a cycle, or a file imported twice, once", async () => {
    const read = reader({ "a.md": "@b.md", "b.md": "@a.md and @CLAUDE.md" });
    const imports = await collectImports("CLAUDE.md", "@a.md @b.md", read, 1e6);
    expect(imports.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(read.reads).toEqual(["a.md", "b.md"]);
  });

  it(`stops ${String(MAX_IMPORT_DEPTH)} levels down`, async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) files[`l${String(i)}.md`] = `@l${String(i + 1)}.md`;
    const imports = await collectImports("CLAUDE.md", "@l1.md", reader(files), 1e6);
    expect(imports.map((i) => i.path)).toEqual(["l1.md", "l2.md", "l3.md", "l4.md"]);
  });

  it(`stops at ${String(MAX_IMPORTED_FILES)} files`, async () => {
    const files: Record<string, string> = {};
    const refs: string[] = [];
    for (let i = 0; i < 15; i++) {
      files[`a${String(i)}.md`] = `@b${String(i)}.md`;
      files[`b${String(i)}.md`] = "leaf";
      refs.push(`@a${String(i)}.md`);
    }
    const imports = await collectImports("CLAUDE.md", refs.join(" "), reader(files), 1e6);
    expect(imports).toHaveLength(MAX_IMPORTED_FILES);
  });

  it("shares one byte budget across every file", async () => {
    const read = reader({ "a.md": "x".repeat(600), "b.md": "y".repeat(600), "c.md": "z" });
    const imports = await collectImports("CLAUDE.md", "@a.md @b.md @c.md", read, 1000);
    expect(imports.map((i) => [i.path, i.sourceBytes, i.sourceTruncated])).toEqual([
      ["a.md", 600, false],
      ["b.md", 400, true],
    ]);
  });

  it("follows nothing from a file whose tool has no imports", async () => {
    const read = reader({ "docs/a.md": "A" });
    expect(await collectImports("AGENTS.md", "@docs/a.md", read, 1e6)).toEqual([]);
    expect(read.reads).toEqual([]);
  });
});
