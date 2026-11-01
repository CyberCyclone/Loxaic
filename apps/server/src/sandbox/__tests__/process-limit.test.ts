import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxImageReady } from "./docker-available.ts";
import { atProcessLimit, looksLikeStartFailure } from "../container-engine.ts";
import { getContainerProvider } from "../container-provider.ts";
import { execFailure, processLimitMessage, SandboxProcessLimitError } from "../errors.ts";
import type { SandboxHandle } from "../provider.ts";
import { DEFAULT_IMAGE_LIMITS } from "../../images/store.ts";

/**
 * A sandbox out of process ids. Nothing can start in it, which Docker reports
 * as `OCI runtime exec failed … procReady not received` and an exit code, so
 * until this was read against the container's own count, an agent saw every
 * tool fail with no reason given.
 */
const dockerReady = await sandboxImageReady();

describe("looksLikeStartFailure", () => {
  it("knows runc's refusal and a failed fork", () => {
    expect(looksLikeStartFailure("OCI runtime exec failed: exec failed: unable to start container process: procReady not received")).toBe(true);
    expect(looksLikeStartFailure("bash: fork: retry: Resource temporarily unavailable")).toBe(true);
    expect(looksLikeStartFailure("pthread_create: resource temporarily unavailable")).toBe(true);
  });

  it("leaves an ordinary failure alone", () => {
    expect(looksLikeStartFailure("")).toBe(false);
    expect(looksLikeStartFailure("cat: /nope: No such file or directory")).toBe(false);
  });
});

describe("atProcessLimit", () => {
  it("counts the tasks runc needs to start an exec as already gone", () => {
    expect(atProcessLimit({ current: 100, limit: 100 })).toBe(true);
    expect(atProcessLimit({ current: 98, limit: 100 })).toBe(true);
    expect(atProcessLimit({ current: 92, limit: 100 })).toBe(true);
    expect(atProcessLimit({ current: 91, limit: 100 })).toBe(false);
  });

  it("is never at a limit the engine did not report", () => {
    expect(atProcessLimit(undefined)).toBe(false);
    expect(atProcessLimit({})).toBe(false);
    expect(atProcessLimit({ current: 50 })).toBe(false);
    expect(atProcessLimit({ current: 50, limit: 0 })).toBe(false);
  });
});

describe("execFailure", () => {
  it("types a failure at the process limit, and leaves any other a plain error", () => {
    const limited = execFailure({ stderr: "full\n", processLimit: 64 }, "fallback");
    expect(limited).toBeInstanceOf(SandboxProcessLimitError);
    expect((limited as SandboxProcessLimitError).limit).toBe(64);
    expect(limited.message).toBe("full");

    const plain = execFailure({ stderr: "" }, "fallback");
    expect(plain).not.toBeInstanceOf(SandboxProcessLimitError);
    expect(plain.message).toBe("fallback");
  });
});

describe("the default limit", () => {
  it("is the same for an image's sandboxes as for Loxaic's own", async () => {
    expect(DEFAULT_IMAGE_LIMITS.pids).toBe(4096);
    if (!dockerReady) return;
    const handle = await getContainerProvider().create(`pids-default-${Date.now().toString(36)}`, {});
    try {
      const info = await new Docker().getContainer(handle.ref).inspect().catch(() => null);
      if (info) expect(info.HostConfig.PidsLimit).toBe(DEFAULT_IMAGE_LIMITS.pids);
    } finally {
      await handle.destroy().catch(() => undefined);
    }
  }, 120_000);
});

describe.skipIf(!dockerReady)("a container at its process limit", () => {
  const LIMIT = 64;
  let handle: SandboxHandle;

  beforeAll(async () => {
    handle = await getContainerProvider().create(`pids-full-${Date.now().toString(36)}`, { limits: { pids: LIMIT } });
    // Backgrounded, and held off a moment, so this exec has ended before the
    // loop fills what is left: its own exit needs a process too.
    const filler = await handle.exec(["bash", "-c", "(nohup bash -c 'sleep 1; while sleep 600 & do :; done' >/dev/null 2>&1 &) ; true"]);
    expect(filler.exitCode).toBe(0);
    await new Promise((r) => setTimeout(r, 3_000));
  }, 120_000);

  afterAll(async () => { await handle.destroy().catch(() => undefined); });

  it("says so, instead of the engine's own message alone", async () => {
    const res = await handle.exec(["bash", "-lc", "echo should-not-run"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.processLimit).toBe(LIMIT);
    expect(res.stderr).toContain(processLimitMessage(LIMIT));
    expect(res.stdout).not.toContain("should-not-run");
  }, 60_000);

  it("throws it typed from a file read and a file write", async () => {
    await expect(handle.readFile("/etc/hostname")).rejects.toBeInstanceOf(SandboxProcessLimitError);
    await expect(handle.writeFile("/tmp/x", "y")).rejects.toThrow(processLimitMessage(LIMIT));
  }, 60_000);

  it("runs again once the limit is raised in place, with no restart", async () => {
    await handle.setProcessLimit?.(4096);
    const res = await handle.exec(["bash", "-lc", "echo after-raise; cat /sys/fs/cgroup/pids.max"]);
    expect(res.exitCode).toBe(0);
    expect(res.processLimit).toBeUndefined();
    expect(res.stdout).toContain("after-raise");
    expect(res.stdout).toContain("4096");
  }, 60_000);
});
