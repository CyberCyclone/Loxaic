import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gpuJobLimit, gpuJobLimitView, isShortGpuJobLimit, parseLockupTimeout, parseModinfo, refreshGpuJobLimit } from "../gpu-job-limit.ts";

/** amdgpu's `lockup_timeout`, read the way the module documents it. */

/** `modinfo -p amdgpu`'s line on Pheonix (kernel 7.0.0-38). */
const KERNEL_7 =
  "lockup_timeout:GPU lockup timeout in ms (default: 2000. 0: keep default value. negative: infinity timeout), format: [single value for all] or [GFX,Compute,SDMA,Video]. (string)\n";
/** The same line on an older kernel, which gave compute a minute. */
const KERNEL_6 =
  "lockup_timeout:GPU lockup timeout in ms (default: for bare metal 10000 for non-compute jobs and 60000 for compute jobs; for passthrough or sriov, 10000 for all jobs. 0: keep default value. negative: infinity timeout), format: for bare metal [Non-Compute] or [GFX,Compute,SDMA,Video]; for passthrough or sriov [all jobs] or [GFX,Compute,SDMA,Video]. (string)\n";

describe("the GPU driver's job limit", () => {
  const NEW = { computeDefaultMs: 2000, single: "all" as const };
  const OLD = { computeDefaultMs: 60_000, single: "non-compute" as const };

  it("reads the module's default for compute, and what one value covers, on old kernels and new", () => {
    expect(parseModinfo(`dpm:DPM support (int)\n${KERNEL_7}`)).toEqual(NEW);
    expect(parseModinfo(KERNEL_6)).toEqual(OLD);
    expect(parseModinfo("dpm:DPM support (int)\n")).toBeNull();
    expect(parseModinfo("lockup_timeout:GPU lockup timeout in ms (string)\n")).toEqual({ computeDefaultMs: null, single: null });
  });

  it("takes compute from four values, and the default for blank or 0", () => {
    expect(parseLockupTimeout("2000,60000,2000,2000\n", null)).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "set" });
    // Pheonix: the parameter reads as an empty line.
    expect(parseLockupTimeout("\n", NEW)).toEqual({ driver: "amdgpu", computeMs: 2000, source: "default" });
    expect(parseLockupTimeout("0", NEW)).toEqual({ driver: "amdgpu", computeMs: 2000, source: "default" });
    expect(parseLockupTimeout("10000,0,10000,10000", OLD)).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "default" });
  });

  it("reads one value as compute's only where the module says one value is for every job", () => {
    expect(parseLockupTimeout("5000", NEW)).toEqual({ driver: "amdgpu", computeMs: 5000, source: "set" });
    // An older kernel on bare metal: one value is every job but compute's, so
    // compute keeps its minute and nothing is short.
    expect(parseLockupTimeout("5000", OLD)).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "default" });
    expect(isShortGpuJobLimit(parseLockupTimeout("5000", OLD))).toBe(false);
    expect(parseLockupTimeout("-1", OLD)).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "default" });
    // Without the module's word on it, one value cannot be read either way.
    expect(parseLockupTimeout("5000", null)).toBeNull();
    expect(parseLockupTimeout("5000", { computeDefaultMs: 2000, single: null })).toBeNull();
  });

  it("calls a negative value no limit, and an unknown default unknown", () => {
    expect(parseLockupTimeout("2000,-1,2000,2000", null)).toEqual({ driver: "amdgpu", computeMs: null, source: "set" });
    expect(parseLockupTimeout("-1", NEW)).toEqual({ driver: "amdgpu", computeMs: null, source: "set" });
    expect(parseLockupTimeout("", null)).toBeNull();
    expect(parseLockupTimeout("soon", NEW)).toBeNull();
  });

  it("is short below ten seconds, and only when there is a limit", () => {
    expect(isShortGpuJobLimit({ driver: "amdgpu", computeMs: 2000, source: "default" })).toBe(true);
    expect(isShortGpuJobLimit({ driver: "amdgpu", computeMs: 10_000, source: "set" })).toBe(false);
    expect(isShortGpuJobLimit({ driver: "amdgpu", computeMs: null, source: "set" })).toBe(false);
    expect(isShortGpuJobLimit(null)).toBe(false);
  });

  it("is sent to the card with the server's verdict and the value that raises it", () => {
    expect(gpuJobLimitView({ driver: "amdgpu", computeMs: 2000, source: "default" })).toEqual({
      driver: "amdgpu",
      computeMs: 2000,
      source: "default",
      short: true,
      suggestedLockupTimeout: "2000,60000,2000,2000",
    });
    expect(gpuJobLimitView({ driver: "amdgpu", computeMs: 60_000, source: "set" })?.short).toBe(false);
    expect(gpuJobLimitView(null)).toBeNull();
  });
});

describe("reading it from the host", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-amdgpu-"));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the parameter where the module keeps it", async () => {
    writeFileSync(path.join(dir, "lockup_timeout"), "2000,60000,2000,2000\n");
    vi.stubEnv("LOXAIC_AMDGPU_PARAMS_DIR", dir);
    await refreshGpuJobLimit();
    expect(gpuJobLimit()).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "set" });
  });

  it("asks the module what a single value covers", async () => {
    writeFileSync(path.join(dir, "lockup_timeout"), "5000\n");
    writeFileSync(path.join(dir, "modinfo"), KERNEL_6);
    vi.stubEnv("LOXAIC_AMDGPU_PARAMS_DIR", dir);
    await refreshGpuJobLimit();
    expect(gpuJobLimit()).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "default" });
    writeFileSync(path.join(dir, "modinfo"), KERNEL_7);
    await refreshGpuJobLimit();
    expect(gpuJobLimit()).toEqual({ driver: "amdgpu", computeMs: 5000, source: "set" });
    rmSync(path.join(dir, "modinfo"));
    await refreshGpuJobLimit();
    expect(gpuJobLimit()).toBeNull();
  });

  it("reports nothing without amdgpu", async () => {
    vi.stubEnv("LOXAIC_AMDGPU_PARAMS_DIR", path.join(dir, "missing"));
    await refreshGpuJobLimit();
    expect(gpuJobLimit()).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
