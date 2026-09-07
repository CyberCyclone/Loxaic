import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHostProvider } from "../host-provider.ts";
import type { SandboxHandle } from "../provider.ts";

describe("host provider", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "loxaic-host-provider-"));
    process.env.SANDBOX_HOST_ROOT = root;
  });

  afterEach(() => {
    delete process.env.SANDBOX_HOST_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it("is always available (no external engine dependency)", async () => {
    await expect(getHostProvider().available()).resolves.toEqual({ ok: true });
  });

  it("creates a per-sandbox directory with a repo/ workdir", async () => {
    const handle = await getHostProvider().create("user-1", {});
    expect(handle.provider).toBe("host");
    expect(handle.ref.startsWith(root)).toBe(true);
    expect(handle.workdir).toBe(path.join(handle.root, "repo"));
    await expect(handle.isRunning()).resolves.toBe(true);
  });

  it("execs a command and reports a real exit code", async () => {
    const handle = await getHostProvider().create("user-1", {});
    const ok = await handle.exec(["bash", "-c", "echo hi && exit 0"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe("hi");
    expect(ok.timedOut).toBe(false);

    const fail = await handle.exec(["bash", "-c", "echo oops >&2; exit 3"]);
    expect(fail.exitCode).toBe(3);
    expect(fail.stderr.trim()).toBe("oops");
  });

  it("kills a command that overruns its timeout and reports exit 124", async () => {
    const handle = await getHostProvider().create("user-1", {});
    const res = await handle.exec(["bash", "-c", "sleep 5"], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
    expect(res.stderr).toContain("timed out after 100ms");
  });

  it("caps captured output at MAX_OUTPUT_BYTES and marks it truncated", async () => {
    const handle = await getHostProvider().create("user-1", {});
    // Well over the 256KB cap.
    const res = await handle.exec(["bash", "-c", "yes x | head -c 500000"]);
    expect(res.truncated).toBe(true);
    expect(res.stdout).toContain("output truncated at");
    expect(res.stdout.length).toBeLessThan(500_000);
  });

  it("round-trips a file write and read, creating parent directories", async () => {
    const handle = await getHostProvider().create("user-1", {});
    const filePath = path.join(handle.workdir, "nested/dir/notes.txt");
    await handle.writeFile(filePath, "hello from the test\n");
    await expect(handle.readFile(filePath)).resolves.toBe("hello from the test\n");
  });

  it("writeFileBinary writes the exact bytes given", async () => {
    const handle = await getHostProvider().create("user-1", {});
    const filePath = path.join(handle.workdir, "binary/data.bin");
    const payload = Buffer.from("hello binary", "utf8");
    await handle.writeFileBinary(filePath, payload);
    expect(readFileSync(filePath)).toEqual(payload);
  });

  it("lists a file tree up to the depth limit", async () => {
    const handle = await getHostProvider().create("user-1", {});
    await handle.writeFile(path.join(handle.workdir, "a.txt"), "a");
    await handle.writeFile(path.join(handle.workdir, "sub/b.txt"), "b");
    await handle.writeFile(path.join(handle.workdir, "sub/deep/c.txt"), "c");

    const tree = await handle.fileTree(handle.workdir);
    const names = tree.map((n) => n.name).sort();
    expect(names).toContain("a.txt");
    expect(names).toContain("sub");
    expect(names).toContain("b.txt");
    expect(names).toContain("deep");
  });

  it("stop() keeps the sandbox directory — it is a pause, not a teardown", async () => {
    // The behaviour this test asserted before was the bug: stopping deleted
    // the directory, so an idle conversation came back to an empty workspace.
    const handle = await getHostProvider().create("user-1", {});
    const file = path.join(handle.workdir, "keep.txt");
    await handle.writeFile(file, "x");

    await handle.stop();

    await expect(handle.exists()).resolves.toBe(true);
    await expect(handle.readFile(file)).resolves.toBe("x");
  });

  it("start() resumes a stopped sandbox with its files intact", async () => {
    const handle = await getHostProvider().create("user-1", {});
    const file = path.join(handle.workdir, "work.txt");
    await handle.writeFile(file, "in progress");
    await handle.stop();

    await handle.start();

    const result = await handle.exec(["cat", file]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("in progress");
  });

  it("start() throws once the sandbox is destroyed, which is how gone is told from paused", async () => {
    const handle = await getHostProvider().create("user-1", {});
    await handle.destroy();

    // Both are false for a stopped sandbox too, so neither can answer the
    // question on its own — start() throwing is the discriminator.
    await expect(handle.isRunning()).resolves.toBe(false);
    await expect(handle.exists()).resolves.toBe(false);
    await expect(handle.start()).rejects.toThrow(/gone/);
  });

  it("destroy() removes the sandbox directory entirely", async () => {
    const handle = await getHostProvider().create("user-1", {});
    await handle.writeFile(path.join(handle.workdir, "keep.txt"), "x");

    await handle.destroy();

    await expect(handle.isRunning()).resolves.toBe(false);
  });

  it("attach() reattaches to an existing sandbox by its ref", async () => {
    const original = await getHostProvider().create("user-1", {});
    await original.writeFile(path.join(original.workdir, "shared.txt"), "still here");

    const reattached: SandboxHandle = await getHostProvider().attach(original.ref);
    await expect(reattached.readFile(path.join(reattached.workdir, "shared.txt"))).resolves.toBe("still here");
  });

  it("isRunning() is false for a ref that was never created", async () => {
    const handle = await getHostProvider().attach(path.join(root, "does-not-exist"));
    await expect(handle.isRunning()).resolves.toBe(false);
  });
});
