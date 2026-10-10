import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * How long the GPU driver lets one piece of GPU work run before it resets the
 * GPU, where we can tell (AMD on Linux, through `amdgpu`'s `lockup_timeout`).
 *
 * Every step of reading a prompt is one such job per GPU, and a step attends to
 * the whole context read so far, so it gets longer as the context does. On
 * Pheonix (kernel 7.0, four V620s, Vulkan) the module's default of 2 seconds
 * was crossed about 207K tokens into re-reading a conversation after a
 * context-stage switch: the kernel logged `ring comp_1.1.0 timeout`, reset the
 * card, and llama.cpp answered `vk::Queue::submit: ErrorDeviceLost` after 31
 * minutes of work. Nothing short of raising the limit lets that prompt
 * through, and only someone with root on the host can — so the Host models
 * screen says so before anyone gets there.
 *
 * The parameter (`/sys/module/amdgpu/parameters/lockup_timeout`) is one value
 * for every kind of job or four (`GFX,Compute,SDMA,Video`), in milliseconds:
 * 0 or empty keeps the module's default, a negative value means no limit. The
 * default differs by kernel (2000 for everything on 7.0; 60000 for compute on
 * older ones), and is read from `modinfo` rather than assumed.
 */
export interface GpuJobLimit {
  driver: "amdgpu";
  /** The limit for compute jobs, which is what llama.cpp's Vulkan backend
   * submits, in milliseconds; null when there is none. */
  computeMs: number | null;
  /** Whether an admin set it, or it is the module's default. */
  source: "set" | "default";
}

/** Below this, a long context can be cut off by the driver. Generous: a step
 * on a 200K-token prompt took about two seconds on a V620. */
export const SHORT_GPU_JOB_LIMIT_MS = 10_000;

/** What `options amdgpu lockup_timeout=…` should say to give compute jobs a
 * minute and leave the others as the module has them. */
export const SUGGESTED_LOCKUP_TIMEOUT = "2000,60000,2000,2000";

/** The compute limit from `modinfo -p amdgpu`'s description, or null when it
 * does not say. Older kernels describe bare metal and SR-IOV separately
 * ("10000 for non-compute jobs and 60000 for compute jobs"); 7.0 says
 * "default: 2000" for everything. */
export function parseModinfoDefault(text: string): number | null {
  const line = text.split("\n").find((l) => l.startsWith("lockup_timeout:"));
  if (!line) return null;
  const compute = /(\d+) for compute jobs/.exec(line);
  if (compute) return Number(compute[1]);
  const all = /default:\s*(\d+)/.exec(line);
  return all ? Number(all[1]) : null;
}

/** The compute limit from the parameter's value and the module's default, or
 * null when it cannot be told (blank, with no default known). */
export function parseLockupTimeout(param: string, moduleDefaultMs: number | null): GpuJobLimit | null {
  const fields = param.trim().split(",").map((f) => f.trim());
  // One value applies to every kind of job, as 7.0's description says; with
  // four, compute is the second.
  const raw = fields.length >= 2 ? fields[1] : fields[0];
  const value = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0) return { driver: "amdgpu", computeMs: null, source: "set" };
  if (value > 0) return { driver: "amdgpu", computeMs: value, source: "set" };
  if (moduleDefaultMs === null) return null;
  return { driver: "amdgpu", computeMs: moduleDefaultMs, source: "default" };
}

/** Whether `limit` is short enough to cut off a long prompt. */
export function isShortGpuJobLimit(limit: GpuJobLimit | null): boolean {
  return limit?.computeMs != null && limit.computeMs < SHORT_GPU_JOB_LIMIT_MS;
}

let cached: GpuJobLimit | null = null;

/** The limit as last read (`refreshGpuJobLimit`), or null when there is none
 * to report: not Linux, no amdgpu, or unreadable. */
export function gpuJobLimit(): GpuJobLimit | null {
  return cached;
}

/**
 * Read the limit again. Called when the runtime starts; the parameter only
 * changes with the module, which means a reboot.
 *
 * `LOXAIC_AMDGPU_PARAMS_DIR` stands in for `/sys/module/amdgpu/parameters`
 * under test, and is read whatever the platform: that is how the e2e lane, on
 * a Mac, shows the warning. It is inert unset.
 */
export async function refreshGpuJobLimit(): Promise<void> {
  const fake = process.env.LOXAIC_AMDGPU_PARAMS_DIR;
  if (!fake && process.platform !== "linux") {
    cached = null;
    return;
  }
  const dir = fake ?? "/sys/module/amdgpu/parameters";
  let param: string;
  try {
    param = await readFile(`${dir}/lockup_timeout`, "utf8");
  } catch {
    // No amdgpu loaded: an NVIDIA or Intel machine, or a container.
    cached = null;
    return;
  }
  const needsDefault = parseLockupTimeout(param, 0)?.source === "default";
  cached = parseLockupTimeout(param, needsDefault && !fake ? await moduleDefault() : null);
}

function moduleDefault(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile("modinfo", ["-p", "amdgpu"], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => {
        resolve(err ? null : parseModinfoDefault(stdout));
      });
    } catch {
      // execFile throws, rather than calling back, for a binary it cannot run.
      resolve(null);
    }
  });
}

/** Test seam. */
export function __setGpuJobLimitForTest(limit: GpuJobLimit | null): void {
  cached = limit;
}
