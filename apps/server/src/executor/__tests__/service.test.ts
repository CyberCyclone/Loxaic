import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutorService, RootViolationError } from "../service.ts";
import { SandboxGoneError } from "../../sandbox/errors.ts";

/**
 * The executor's one security property: nothing outside a folder the user
 * chose is ever reached, whatever the server asks for. The server is not
 * trusted here — it may be someone else's machine — so every case below is
 * "a hostile call" and the assertion is a refusal, not just an error.
 *
 * Symlinks are the case that matters. The server's own check
 * (agent/executor.ts's resolvePath) is lexical; a repository can contain a
 * link that points at `/`, and only realpath sees through it.
 */
/** This machine's id, which a container-isolated sandbox is labelled with. */
const EXECUTOR_ID = "test-executor";

let base: string;
let root: string;
let roots: string[];

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "loxaic-executor-"));
  root = path.join(base, "project");
  mkdirSync(root);
  roots = [root];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function service() {
  return createExecutorService({ roots: () => roots, executorId: EXECUTOR_ID });
}

describe("create", () => {
  it("accepts the root itself and directories inside it, resolved through symlinks", async () => {
    mkdirSync(path.join(root, "sub"));
    const svc = service();
    expect(await svc.handle("create", { path: root, isolation: "direct" })).toEqual({ ref: realpathSync(root) });
    expect(await svc.handle("create", { path: path.join(root, "sub"), isolation: "direct" })).toEqual({
      ref: realpathSync(path.join(root, "sub")),
    });
  });

  it("refuses a directory outside every root", async () => {
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    await expect(service().handle("create", { path: elsewhere, isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
  });

  it("refuses a symlink inside the root that points outside it", async () => {
    const secret = path.join(base, "secret");
    mkdirSync(secret);
    symlinkSync(secret, path.join(root, "link"));
    await expect(service().handle("create", { path: path.join(root, "link"), isolation: "direct" })).rejects.toBeInstanceOf(
      RootViolationError,
    );
  });

  it("refuses a sibling whose name merely starts with the root's", async () => {
    mkdirSync(`${root}-evil`);
    await expect(service().handle("create", { path: `${root}-evil`, isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
  });

  it("refuses traversal, relative paths, files, and nonexistent directories", async () => {
    writeFileSync(path.join(root, "file.txt"), "x");
    const svc = service();
    await expect(svc.handle("create", { path: path.join(root, "..", "secret"), isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(svc.handle("create", { path: "project", isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(svc.handle("create", { path: path.join(root, "file.txt"), isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(svc.handle("create", { path: path.join(root, "nope"), isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
  });

  it("checks the folder before anything else, container isolation included", async () => {
    // Refused for the same reason and at the same point as direct mode: the
    // folder is not one the user chose. Asserted here rather than in the
    // Docker-gated container suite because it must hold on a machine with no
    // engine at all — the refusal comes first.
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    await expect(service().handle("create", { path: elsewhere, isolation: "container" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(service().handle("create", { path: root, isolation: "sideways" })).rejects.toThrow(/direct or container/);
  });

  it("refuses everything when the user has chosen no folder at all", async () => {
    roots = [];
    await expect(service().handle("create", { path: root, isolation: "direct" })).rejects.toBeInstanceOf(RootViolationError);
  });
});

describe("file operations stay inside the ref", () => {
  it("writes, reads, lists, and execs within the directory", async () => {
    const svc = service();
    const { ref } = (await svc.handle("create", { path: root, isolation: "direct" })) as { ref: string };
    await svc.handle("writeFile", { ref, path: "notes/a.txt", content: "hello\n" });
    expect(readFileSync(path.join(root, "notes/a.txt"), "utf8")).toBe("hello\n");
    expect(await svc.handle("readFile", { ref, path: path.join(ref, "notes/a.txt") })).toBe("hello\n");
    const tree = (await svc.handle("fileTree", { ref })) as { name: string }[];
    expect(tree.map((n) => n.name)).toContain("notes");
    const result = (await svc.handle("exec", { ref, command: ["pwd"] })) as { stdout: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(ref);
  });

  it("refuses a write that would land outside the ref, even for a file that does not exist yet", async () => {
    const svc = service();
    const { ref } = (await svc.handle("create", { path: root, isolation: "direct" })) as { ref: string };
    await expect(svc.handle("writeFile", { ref, path: "../escaped.txt", content: "x" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(svc.handle("writeFile", { ref, path: path.join(base, "escaped.txt"), content: "x" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(svc.handle("readFile", { ref, path: "/etc/hostname" })).rejects.toBeInstanceOf(RootViolationError);
  });

  it("refuses a write through a symlinked directory that points outside", async () => {
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "out"));
    const svc = service();
    const { ref } = (await svc.handle("create", { path: root, isolation: "direct" })) as { ref: string };
    // The file does not exist; its *directory* is a link out of the root.
    await expect(svc.handle("writeFile", { ref, path: "out/new.txt", content: "x" })).rejects.toBeInstanceOf(RootViolationError);
    await expect(svc.handle("exec", { ref, command: ["pwd"], options: { workdir: "out" } })).rejects.toBeInstanceOf(RootViolationError);
  });

  it("refuses a ref the server made up, and a ref whose root was since removed", async () => {
    const svc = service();
    const { ref } = (await svc.handle("create", { path: root, isolation: "direct" })) as { ref: string };
    await expect(svc.handle("readFile", { ref: base, path: "x" })).rejects.toBeInstanceOf(RootViolationError);
    roots = [];
    await expect(svc.handle("readFile", { ref, path: "x" })).rejects.toBeInstanceOf(RootViolationError);
    // exists/isRunning answer false rather than throwing — that is how the
    // server learns to stop trusting the row.
    expect(await svc.handle("exists", { ref })).toBe(false);
    expect(await svc.handle("isRunning", { ref })).toBe(false);
    // start is the manager's "paused or gone?" question, and an un-approved
    // directory is "gone" to the server — reported as exactly that, so the
    // row is dropped rather than the refusal surfacing as a retryable error.
    await expect(svc.handle("start", { ref })).rejects.toBeInstanceOf(SandboxGoneError);
  });
});

describe("lifecycle verbs never touch the user's files", () => {
  it("stop and destroy leave the directory and its contents alone", async () => {
    writeFileSync(path.join(root, "keep.txt"), "important");
    const svc = service();
    const { ref } = (await svc.handle("create", { path: root, isolation: "direct" })) as { ref: string };
    await svc.handle("stop", { ref });
    await svc.handle("destroy", { ref });
    expect(readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("important");
    expect(await svc.handle("exists", { ref })).toBe(true);
  });
});

describe("cancelling an exec", () => {
  /**
   * The executor half of #119. A `local` workspace runs commands on the
   * user's own machine, and until now nothing could stop one: the server
   * cannot serialise an AbortSignal, so cancellation had to become its own
   * `exec.cancel` message, which main.ts turns back into a signal here.
   *
   * Asserted on the *filesystem*, not on how fast the promise settled:
   * returning early is what the old timeout already did while leaving the
   * command running. The command writes a file only after the point of
   * cancellation, so a survivor leaves evidence.
   */
  it("kills the command's process group, not just the promise", async () => {
    const marker = path.join(root, "survived.txt");
    const controller = new AbortController();
    const started = Date.now();

    const running = service().handle(
      "exec",
      { ref: root, command: ["bash", "-lc", `sleep 6; echo survived > ${marker}`], options: { timeoutMs: 30_000 } },
      controller.signal,
    );
    // Long enough that the child is genuinely running, far short of its sleep.
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    await running;
    expect(Date.now() - started).toBeLessThan(3_000);

    // Outlive the sleep: the whole group must be gone, including the
    // grandchild the `bash -lc` spawned.
    await new Promise((r) => setTimeout(r, 6_500));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("leaves an uncancelled command's output and exit code alone", async () => {
    // The wrapper guard: every bash tool call now carries a signal, so a
    // cancellable exec that mangled ordinary results would break local
    // workspaces wholesale while the case above still passed.
    const controller = new AbortController();
    const ok = await service().handle(
      "exec",
      { ref: root, command: ["bash", "-lc", "echo hello; exit 3"] },
      controller.signal,
    ) as { stdout: string; exitCode: number };
    expect(ok.stdout).toContain("hello");
    expect(ok.exitCode).toBe(3);
  }, 30_000);
});
