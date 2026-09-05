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
    root: "/home/loxaic",
    workdir: "/home/loxaic/repo",
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
    expect(resolvePath(handle, "notes.txt")).toBe("/home/loxaic/repo/notes.txt");
  });

  it("accepts an absolute path inside the handle's root", () => {
    const { handle } = makeFakeHandle();
    expect(resolvePath(handle, "/home/loxaic/other/file.txt")).toBe("/home/loxaic/other/file.txt");
  });

  it("accepts the root itself", () => {
    const { handle } = makeFakeHandle();
    expect(resolvePath(handle, "/home/loxaic")).toBe("/home/loxaic");
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

  it("re-roots per handle — a host-mode handle's paths never resolve under /home/loxaic", () => {
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
    expect(() => resolvePath(hostHandle, "/home/loxaic/repo/notes.txt")).toThrow(/escapes the sandbox/);
  });
});

describe("executeTool — filesystem", () => {
  it("fs_read returns file contents", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "1\thello\n2\tworld\n", stderr: "2", exitCode: 0, truncated: false, timedOut: false });
    const result = await executeTool(handle, "fs_read", { path: "a.txt" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("1\thello\n2\tworld\n");
  });

  it("fs_read reports an empty file distinctly", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "0", exitCode: 0, truncated: false, timedOut: false });
    const result = await executeTool(handle, "fs_read", { path: "empty.txt" });
    expect(result).toEqual({ ok: true, output: "(empty file)" });
  });

  it("fs_read on a missing file surfaces the error, not a crash", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({
      stdout: "",
      stderr: 'awk: cannot open "missing.txt" (No such file or directory)',
      exitCode: 2,
      truncated: false,
      timedOut: false,
    });
    const result = await executeTool(handle, "fs_read", { path: "missing.txt" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("No such file or directory");
  });

  it("fs_read computes end = offset + limit - 1 and passes it through argv", async () => {
    const { handle, execCalls, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "10\tx\n", stderr: "20", exitCode: 0, truncated: false, timedOut: false });
    await executeTool(handle, "fs_read", { path: "a.txt", offset: 10, limit: 5 });
    expect(execCalls[0].command).toEqual([
      "bash", "-c",
      'awk -v s="$1" -v e="$2" \'NR>=s && NR<=e {print NR"\\t"$0} END{print NR > "/dev/stderr"}\' "$3"',
      "_", "10", "14", "/home/loxaic/repo/a.txt",
    ]);
  });

  it("fs_read appends a continue-from footer when there are more lines than shown", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "1\ta\n2\tb\n", stderr: "50", exitCode: 0, truncated: false, timedOut: false });
    const result = await executeTool(handle, "fs_read", { path: "a.txt", offset: 1, limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("48 more line(s)");
    expect(result.output).toContain("offset=3");
  });

  it("fs_read reports a past-the-end offset without stdout or a more-lines footer", async () => {
    const { handle, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "5", exitCode: 0, truncated: false, timedOut: false });
    const result = await executeTool(handle, "fs_read", { path: "a.txt", offset: 100 });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("(offset 100 is past the end of the file — it has 5 line(s))");
    expect(result.output).not.toContain("more line(s)");
  });

  it("fs_read falls back to defaults for invalid offset/limit", async () => {
    const { handle, execCalls, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "0", exitCode: 0, truncated: false, timedOut: false });
    await executeTool(handle, "fs_read", { path: "a.txt", offset: 0, limit: -5 });
    // offset defaults to 1, limit defaults to 2000 → end = 2000.
    expect(execCalls[0].command).toEqual([
      "bash", "-c",
      'awk -v s="$1" -v e="$2" \'NR>=s && NR<=e {print NR"\\t"$0} END{print NR > "/dev/stderr"}\' "$3"',
      "_", "1", "2000", "/home/loxaic/repo/a.txt",
    ]);
  });

  it("fs_read falls back to defaults for a non-numeric or omitted offset/limit", async () => {
    const { handle, execCalls, setNextExec } = makeFakeHandle();
    setNextExec({ stdout: "", stderr: "0", exitCode: 0, truncated: false, timedOut: false });
    await executeTool(handle, "fs_read", { path: "a.txt", offset: "not-a-number" });
    expect(execCalls[0].command).toEqual([
      "bash", "-c",
      'awk -v s="$1" -v e="$2" \'NR>=s && NR<=e {print NR"\\t"$0} END{print NR > "/dev/stderr"}\' "$3"',
      "_", "1", "2000", "/home/loxaic/repo/a.txt",
    ]);
  });

  it("fs_write creates a file and reports oldContent: null in the diff", async () => {
    const { handle, files } = makeFakeHandle();
    const result = await executeTool(handle, "fs_write", { path: "new.txt", content: "hi" });
    expect(result.ok).toBe(true);
    expect(result.diff).toEqual([{ path: "/home/loxaic/repo/new.txt", oldContent: null, newContent: "hi" }]);
    expect(files.get("/home/loxaic/repo/new.txt")).toBe("hi");
  });

  it("fs_write overwriting an existing file reports its prior content in the diff", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/loxaic/repo/existing.txt", "old");
    const result = await executeTool(handle, "fs_write", { path: "existing.txt", content: "new" });
    expect(result.diff).toEqual([{ path: "/home/loxaic/repo/existing.txt", oldContent: "old", newContent: "new" }]);
  });

  it("fs_edit replaces a unique match", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/loxaic/repo/f.txt", "const x = 1;\nconst y = 2;\n");
    const result = await executeTool(handle, "fs_edit", { path: "f.txt", oldText: "const x = 1;", newText: "const x = 100;" });
    expect(result.ok).toBe(true);
    expect(files.get("/home/loxaic/repo/f.txt")).toBe("const x = 100;\nconst y = 2;\n");
  });

  it("fs_edit rejects zero occurrences", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/loxaic/repo/f.txt", "abc");
    const result = await executeTool(handle, "fs_edit", { path: "f.txt", oldText: "zzz", newText: "yyy" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("fs_edit rejects an ambiguous (non-unique) match", async () => {
    const { handle, files } = makeFakeHandle();
    files.set("/home/loxaic/repo/f.txt", "dup\ndup\n");
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
      options: { workdir: "/home/loxaic/repo", timeoutMs: 60_000 },
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
