import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxImageReady } from "./docker-available.ts";
import { attachDirectory } from "../host-provider.ts";
import { getContainerProvider } from "../container-provider.ts";
import type { SandboxHandle } from "../provider.ts";

/**
 * Cancelling an exec has to actually kill the command — #119.
 *
 * Returning early is the easy half and proves nothing: the point is that the
 * work *stops*, because the old timeout already returned early and left the
 * process running inside the container until it was reaped.
 *
 * So each case asserts two things a lenient test would miss:
 *
 *   1. `exec` returns promptly, well inside what the command would have taken;
 *   2. the process is **gone afterwards** — checked by having it write a file
 *      it only reaches after the point of cancellation. A surviving process
 *      writes that file; a killed one never does.
 *
 * The group, not the pid: the command is `bash -lc` with a child, mirroring
 * the real `bash` tool, so killing only the direct child would leave the
 * writer alive and fail the second assertion.
 */
const dockerReady = await sandboxImageReady();

/** Long enough that finishing normally is unmistakably different from being
 * cancelled, short enough not to drag the suite if something goes wrong. */
const SLEEP_SECONDS = 8;

describe("cancelling an exec kills the command", () => {
  describe("host provider", () => {
    let dir: string;
    let handle: SandboxHandle;

    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "exec-cancel-host-"));
      handle = attachDirectory(dir);
    });

    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    it("returns at once and leaves nothing running", async () => {
      const marker = path.join(dir, "survived.txt");
      const controller = new AbortController();
      const started = Date.now();

      const running = handle.exec(
        ["bash", "-lc", `sleep ${String(SLEEP_SECONDS)}; echo survived > ${marker}`],
        { timeoutMs: 30_000, signal: controller.signal },
      );
      // Long enough that the child is genuinely running, far short of its sleep.
      await new Promise((r) => setTimeout(r, 500));
      controller.abort();

      const result = await running;
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.stderr).toContain("stopped by the user");

      // The real assertion: outlive the sleep and confirm the marker never
      // appeared, i.e. the whole group died rather than just the shell.
      await new Promise((r) => setTimeout(r, (SLEEP_SECONDS + 1) * 1000));
      const after = await handle.exec(["bash", "-lc", `test -f ${marker} && echo LEAKED || echo clean`], {});
      expect(after.stdout).toContain("clean");
    }, 60_000);
  });

  describe.skipIf(!dockerReady)("container provider", () => {
    let handle: SandboxHandle;

    beforeAll(async () => {
      // Through the provider rather than the engine directly: it is the same
      // path a real tool call takes, limits and all.
      handle = await getContainerProvider().create(`exec-cancel-${Date.now().toString(36)}`, {});
    }, 120_000);

    afterAll(async () => { await handle.destroy().catch(() => undefined); });

    it("leaves an uncancelled command's output and exit code untouched", async () => {
      // The guard for the wrapper itself. A cancellable exec runs under
      // `setsid -w bash -c ...` rather than bare, and every `bash` tool call
      // now passes a signal — so if that wrapper swallowed stdout or reported
      // the shell's status instead of the command's, it would break every tool
      // call in the product while the cancellation tests still passed.
      const controller = new AbortController();
      const ok = await handle.exec(["bash", "-lc", "echo hello-from-wrapped"], {
        signal: controller.signal,
      });
      expect(ok.stdout).toContain("hello-from-wrapped");
      expect(ok.exitCode).toBe(0);

      const bad = await handle.exec(["bash", "-lc", "echo to-stderr >&2; exit 17"], {
        signal: controller.signal,
      });
      expect(bad.exitCode).toBe(17);
      expect(bad.stderr).toContain("to-stderr");
    }, 60_000);

    it("returns at once and leaves nothing running", async () => {
      const marker = "/tmp/survived.txt";
      const controller = new AbortController();
      const started = Date.now();

      const running = handle.exec(
        ["bash", "-lc", `sleep ${String(SLEEP_SECONDS)}; echo survived > ${marker}`],
        { timeoutMs: 30_000, signal: controller.signal },
      );
      await new Promise((r) => setTimeout(r, 500));
      controller.abort();

      const result = await running;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.stderr).toContain("stopped by the user");

      // Docker has no kill-exec call, so this is the assertion that the
      // in-container process-group kill really ran — without it the sleep
      // finishes and writes the file, exactly as it did before #119.
      await new Promise((r) => setTimeout(r, (SLEEP_SECONDS + 2) * 1000));
      const after = await handle.exec(["bash", "-lc", `test -f ${marker} && echo LEAKED || echo clean`], {});
      expect(after.stdout).toContain("clean");
    }, 90_000);
  });
});

/**
 * The already-aborted-signal path — after a Stop, every remaining call in a
 * batch enters exec with `signal.aborted` already true — and the timeout
 * with no signal at all. Both got the least attention the first time: the
 * host provider spawned and returned before attending the child's `error`
 * event, and the container provider started the exec, settled "cancelled"
 * before the wrapper had written its PGID, and let the command run.
 */
describe("a signal that is already aborted never starts the command", () => {
  it("host provider: returns a stopped result without spawning", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exec-preaborted-host-"));
    try {
      const handle = attachDirectory(dir);
      const marker = path.join(dir, "ran.txt");
      const controller = new AbortController();
      controller.abort();
      const result = await handle.exec(["bash", "-lc", `echo ran > ${marker}`], { signal: controller.signal });
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain("stopped by the user");
      await new Promise((r) => setTimeout(r, 300));
      const after = await handle.exec(["bash", "-lc", `test -f ${marker} && echo LEAKED || echo clean`], {});
      expect(after.stdout).toContain("clean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe.skipIf(!dockerReady)("container provider", () => {
    let handle: SandboxHandle;
    beforeAll(async () => {
      handle = await getContainerProvider().create("exec-preaborted", {});
    }, 120_000);
    afterAll(async () => {
      await handle.destroy().catch(() => undefined);
    });

    it("returns a stopped result without starting an exec", async () => {
      const marker = "/tmp/preaborted-ran.txt";
      const controller = new AbortController();
      controller.abort();
      const result = await handle.exec(["bash", "-lc", `echo ran > ${marker}`], { signal: controller.signal });
      expect(result.exitCode).toBe(130);
      await new Promise((r) => setTimeout(r, 500));
      const after = await handle.exec(["bash", "-lc", `test -f ${marker} && echo LEAKED || echo clean`], {});
      expect(after.stdout).toContain("clean");
    }, 60_000);

    it("kills a timed-out command that carried no signal at all", async () => {
      // Document extraction, a clone, the REST exec endpoint: none passes a
      // signal, and the timeout used to merely detach from them.
      const marker = "/tmp/timeout-survived.txt";
      const result = await handle.exec(
        ["bash", "-lc", `sleep ${String(SLEEP_SECONDS)}; echo survived > ${marker}`],
        { timeoutMs: 1_000 },
      );
      expect(result.exitCode).toBe(124);
      await new Promise((r) => setTimeout(r, (SLEEP_SECONDS + 2) * 1000));
      const after = await handle.exec(["bash", "-lc", `test -f ${marker} && echo LEAKED || echo clean`], {});
      expect(after.stdout).toContain("clean");
    }, 90_000);
  });
});
