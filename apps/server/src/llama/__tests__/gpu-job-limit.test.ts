import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gpuJobLimit, isShortGpuJobLimit, parseLockupTimeout, parseModinfoDefault, refreshGpuJobLimit } from "../gpu-job-limit.ts";

/** amdgpu's `lockup_timeout`, read the way the module documents it. */

/** `modinfo -p amdgpu`'s line on Pheonix (kernel 7.0.0-38). */
const KERNEL_7 =
  "lockup_timeout:GPU lockup timeout in ms (default: 2000. 0: keep default value. negative: infinity timeout), format: [single value for all] or [GFX,Compute,SDMA,Video]. (string)\n";
/** The same line on an older kernel, which gave compute a minute. */
const KERNEL_6 =
  "lockup_timeout:GPU lockup timeout in ms (default: for bare metal 10000 for non-compute jobs and 60000 for compute jobs; for passthrough or sriov, 10000 for all jobs. 0: keep default value. negative: infinity timeout), format: for bare metal [Non-Compute] or [GFX,Compute,SDMA,Video]; for passthrough or sriov [all jobs] or [GFX,Compute,SDMA,Video]. (string)\n";

describe("the GPU driver's job limit", () => {
  it("reads the module's default for compute, on old kernels and new", () => {
    expect(parseModinfoDefault(`dpm:DPM support (int)\n${KERNEL_7}`)).toBe(2000);
    expect(parseModinfoDefault(KERNEL_6)).toBe(60_000);
    expect(parseModinfoDefault("dpm:DPM support (int)\n")).toBeNull();
  });

  it("takes compute from four values, one value for everything, and the default for blank or 0", () => {
    expect(parseLockupTimeout("2000,60000,2000,2000\n", 2000)).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "set" });
    expect(parseLockupTimeout("5000", 2000)).toEqual({ driver: "amdgpu", computeMs: 5000, source: "set" });
    // Pheonix: the parameter reads as an empty line.
    expect(parseLockupTimeout("\n", 2000)).toEqual({ driver: "amdgpu", computeMs: 2000, source: "default" });
    expect(parseLockupTimeout("10000,0,10000,10000", 60_000)).toEqual({ driver: "amdgpu", computeMs: 60_000, source: "default" });
  });

  it("calls a negative value no limit, and an unknown default unknown", () => {
    expect(parseLockupTimeout("2000,-1,2000,2000", 2000)).toEqual({ driver: "amdgpu", computeMs: null, source: "set" });
    expect(parseLockupTimeout("", null)).toBeNull();
    expect(parseLockupTimeout("soon", 2000)).toBeNull();
  });

  it("is short below ten seconds, and only when there is a limit", () => {
    expect(isShortGpuJobLimit({ driver: "amdgpu", computeMs: 2000, source: "default" })).toBe(true);
    expect(isShortGpuJobLimit({ driver: "amdgpu", computeMs: 10_000, source: "set" })).toBe(false);
    expect(isShortGpuJobLimit({ driver: "amdgpu", computeMs: null, source: "set" })).toBe(false);
    expect(isShortGpuJobLimit(null)).toBe(false);
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

  it("reports nothing without amdgpu", async () => {
    vi.stubEnv("LOXAIC_AMDGPU_PARAMS_DIR", path.join(dir, "missing"));
    await refreshGpuJobLimit();
    expect(gpuJobLimit()).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
