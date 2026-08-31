/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function --
   the fake handle below implements SandboxHandle's async interface with
   synchronous stubs (no real I/O to await) — that's the point of a fake. */
import { describe, expect, it } from "vitest";
import { executeTool, resolvePath } from "../executor.ts";
import type { ExecOptions, ExecResult, SandboxHandle } from "../../sandbox/provider.ts";

/**
 * An in-memory SandboxHandle — proves executor.ts's own logic (path
 * resolution, diff construction, output formatting, the fs_edit uniqueness
 * rule) without a real container or even a real filesystem. Mirrors
 * container-mode's root/workdir shape since that's what the pre-refactor
 * tests would have exercised; host-provider.test.ts covers the real-fs/
 * real-exec side of the contract this handle only fakes.
 */
function makeFakeHandle() {
  const files = new Map<string, string>();
  const execCalls: { command: string[]; options?: ExecOptions }[] = [];
  let nextExec: ExecResult = { stdout: "", stderr: "", exitCode: 0, truncated: false, timedOut: false };

  const handle: SandboxHandle = {
    provider: "container",
    ref: "fake-ref",
    root: "/home/shannon",
    workdir: "/home/shannon/repo",
    async exec(command, options) {
      execCalls.push({ command, options });
      return nextExec;
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return files.get(path) ?? "";
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async writeFileBinary(path, data) {
      files.set(path, data.toString("utf8"));
    },
    async fileTree() {
      return [];
    },
    async isRunning() {
      return true;
    },
    async stop() {},
  };

  return {
    handle,
    files,
    execCalls,
    setNextExec: (r: ExecResult) => { nextExec = r; },
  };
}

const EXEC_OK: ExecResult = { stdout: "", stderr: "", exitCode: 0, truncated: false, timedOut: false };

describe("resolvePath", () => {
  it("resolves a relative path against the handle's workdir", () => {
    const { handle } = makeFakeHandle();
    expect(resolvePath(handle, "notes.txt")).toBe("/home/shannon/repo/notes.txt");
  });

  it("accepts an absolute path inside the handle's root", () => {
    const { handle } = makeFakeHandle();
    expect(resolvePath(handle, "/home/shannon/other/file.txt")).toBe("/home/shannon/other/file.txt");
  });

  it("accepts the root itself", () => {
    const { handle } = makeFakeHandle();
    expect(resolvePath(handle, "/home/shannon")).toBe("/home/shannon");
  });

  it("rejects a path that escapes the root via ..", () => {
    const { handle } = makeFakeHandle();
    expect(() => resolvePath(handle, "../../etc/passwd")).toThrow(/escapes the sandbox/);
  });

  it("rejects an absolute path outside the root", () => {
    const { handle } = makeFakeHandle();
    expect(() => resolvePath(handle, "/etc/passwd")).toThrow(/escapes the sandbox/);
  });

  it("rejects a non-string or empty path", () => {
    const { handle } = makeFakeHandle();
    expect(() => resolvePath(handle, undefined)).toThrow(/non-empty string/);
    expect(() => resolvePath(handle, "")).toThrow(/non-empty string/);
  });

  it("re-roots per handle — a host-mode handle's paths never resolve under /home/shannon", () => {
    const hostHandle: SandboxHandle = {
      provider: "host",
      ref: "/data/sandboxes/abc123",
      root: "/data/sandboxes/abc123",
      workdir: "/data/sandboxes/abc123/repo",
      exec: async () => EXEC_OK,
      readFile: async () => "",
      writeFile: async () => {},
      writeFileBinary: async () => {},
      fileTree: async () => [],
      isRunning: async () => true,
      stop: async () => {},
    };
    expect(resolvePath(hostHandle, "notes.txt")).toBe("/data/sandboxes/abc123/repo/notes.txt");
    expect(() => resolvePath(hostHandle, "/home/shannon/repo/notes.txt")).toThrow(/escapes the sandbox/);
  });
});

describe("executeTool — filesystem", () => {
  it("fs_read returns file contents", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/shannon/repo/a.txt", "hello");
    const result = await executeTool(handle, "fs_read", { path: "a.txt" });
    expect(result).toEqual({ ok: true, output: "hello" });
  });

  it("fs_read reports an empty file distinctly", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/shannon/repo/empty.txt", "");
    const result = await executeTool(handle, "fs_read", { path: "empty.txt" });
    expect(result).toEqual({ ok: true, output: "(empty file)" });
  });

  it("fs_read on a missing file surfaces the error, not a crash", async () => {
    const { handle } = makeFakeHandle();
    const result = await executeTool(handle, "fs_read", { path: "missing.txt" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no such file");
  });

  it("fs_write creates a file and reports oldContent: null in the diff", async () => {
    const { handle, files } = makeFakeHandle();
    const result = await executeTool(handle, "fs_write", { path: "new.txt", content: "hi" });
    expect(result.ok).toBe(true);
    expect(result.diff).toEqual([{ path: "/home/shannon/repo/new.txt", oldContent: null, newContent: "hi" }]);
    expect(files.get("/home/shannon/repo/new.txt")).toBe("hi");
  });

  it("fs_write overwriting an existing file reports its prior content in the diff", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/shannon/repo/existing.txt", "old");
    const result = await executeTool(handle, "fs_write", { path: "existing.txt", content: "new" });
    expect(result.diff).toEqual([{ path: "/home/shannon/repo/existing.txt", oldContent: "old", newContent: "new" }]);
  });

  it("fs_edit replaces a unique match", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/shannon/repo/f.txt", "const x = 1;\nconst y = 2;\n");
    const result = await executeTool(handle, "fs_edit", { path: "f.txt", oldText: "const x = 1;", newText: "const x = 100;" });
    expect(result.ok).toBe(true);
    expect(files.get("/home/shannon/repo/f.txt")).toBe("const x = 100;\nconst y = 2;\n");
  });

  it("fs_edit rejects zero occurrences", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/shannon/repo/f.txt", "abc");
    const result = await executeTool(handle, "fs_edit", { path: "f.txt", oldText: "zzz", newText: "yyy" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("fs_edit rejects an ambiguous (non-unique) match", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/shannon/repo/f.txt", "dup\ndup\n");
    const result = await executeTool(handle, "fs_edit", { path: "f.txt", oldText: "dup", newText: "x" });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/appears 2 times/);
  });

  it("fs_edit rejects an empty oldText", async () => {
    const { handle } = makeFakeHandle();
    const result = await executeTool(handle, "fs_edit", { path: "f.txt", oldText: "", newText: "x" });
    expect(result).toEqual({ ok: false, output: "oldText must not be empty" });
  });
});

describe("executeTool — shell", () => {
  it("bash formats a successful command with its exit code", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "hi\n", stderr: "", exitCode: 0, truncated: false, timedOut: false });
    const result = await executeTool(handle, "bash", { command: "echo hi" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hi\n\n[exit 0]");
  });

  it("bash reports ok: false on a nonzero exit code", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "boom", exitCode: 1, truncated: false, timedOut: false });
    const result = await executeTool(handle, "bash", { command: "false" });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("boom\n[exit 1]");
  });

  it("bash runs inside the handle's workdir with the expected timeout", async () => {
    const { handle, execCalls, setNextExec } = makeFakeHandle();
    setNextExec(EXEC_OK);
    await executeTool(handle, "bash", { command: "pwd" });
    expect(execCalls[0]).toEqual({
      command: ["bash", "-lc", "pwd"],
      options: { workdir: "/home/shannon/repo", timeoutMs: 60_000 },
    });
  });

  it("grep reports a friendly message on no matches instead of empty output", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "", exitCode: 1, truncated: false, timedOut: false });
    const result = await executeTool(handle, "grep", { pattern: "TODO" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("No matches for /TODO/");
  });

  it("grep returns raw ripgrep output when there are matches", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "f.txt:1:TODO here\n", stderr: "", exitCode: 0, truncated: false, timedOut: false });
    const result = await executeTool(handle, "grep", { pattern: "TODO" });
    expect(result.output).toBe("f.txt:1:TODO here\n");
  });

  it("glob reports a friendly message on no matches", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "", exitCode: 1, truncated: false, timedOut: false });
    const result = await executeTool(handle, "glob", { pattern: "*.zzz" });
    expect(result.output).toContain("No files match *.zzz");
  });
});

describe("executeTool — no sandbox available", () => {
  it("returns a clear message for a sandbox-needing tool when handle is null", async () => {
    const result = await executeTool(null, "bash", { command: "echo hi" });
    expect(result).toEqual({ ok: false, output: "No sandbox is available for this tool." });
  });

  it("non-sandbox tools work fine with a null handle", async () => {
    const result = await executeTool(null, "todo_write", { todos: [{ id: "1", text: "a", status: "pending" }] });
    expect(result.ok).toBe(true);
    expect(result.todos).toHaveLength(1);
  });
});
