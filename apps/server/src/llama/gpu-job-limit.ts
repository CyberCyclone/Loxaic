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
 * or four (`GFX,Compute,SDMA,Video`), in milliseconds: 0 or empty keeps the
 * module's default, a negative value means no limit. What one value covers,
 * and the default, both differ by kernel, so both are read from `modinfo`
 * rather than assumed (`parseModinfo`).
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

/** What `modinfo -p amdgpu` says of `lockup_timeout`. */
export interface ModuleTimeouts {
  /** The module's default for compute jobs, or null when it does not say. */
  computeDefaultMs: number | null;
  /** What a single value covers: every kind of job, or every kind but
   * compute; null when the description does not say. */
  single: "all" | "non-compute" | null;
}

/**
 * The parameter's description from `modinfo -p amdgpu`, or null when there is
 * none. Kernel 7.0 says "default: 2000" and "[single value for all]". Older
 * kernels say "10000 for non-compute jobs and 60000 for compute jobs" and
 * "for bare metal [Non-Compute] … for passthrough or sriov [all jobs]": there a
 * single value leaves compute at its default, on bare metal. A passthrough or
 * SR-IOV guest, where it covers compute too, is not told apart; it reads as
 * bare metal, which can only miss a warning, never invent one.
 */
export function parseModinfo(text: string): ModuleTimeouts | null {
  const line = text.split("\n").find((l) => l.startsWith("lockup_timeout:"));
  if (!line) return null;
  const compute = /(\d+) for compute jobs/.exec(line);
  const all = /default:\s*(\d+)/.exec(line);
  const computeDefaultMs = compute ? Number(compute[1]) : all ? Number(all[1]) : null;
  const single = /bare metal \[Non-Compute\]/i.test(line) ? "non-compute" : /single value for all/i.test(line) ? "all" : null;
  return { computeDefaultMs, single };
}

/** The compute limit from the parameter's value and what the module says of
 * it, or null when it cannot be told: a value it cannot read, a single value
 * whose meaning the module does not say, or the default unknown. */
export function parseLockupTimeout(param: string, module: ModuleTimeouts | null): GpuJobLimit | null {
  const fields = param.trim().split(",").map((f) => f.trim());
  let raw: string;
  if (fields.length >= 2) raw = fields[1];
  else if (fields[0] === "" || fields[0] === "0") raw = "0";
  else if (module?.single === "all") raw = fields[0];
  // On bare metal a lone value is every other kind of job's, and compute keeps
  // the module's default.
  else if (module?.single === "non-compute") raw = "0";
  else return null;
  const value = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0) return { driver: "amdgpu", computeMs: null, source: "set" };
  if (value > 0) return { driver: "amdgpu", computeMs: value, source: "set" };
  if (module?.computeDefaultMs == null) return null;
  return { driver: "amdgpu", computeMs: module.computeDefaultMs, source: "default" };
}

/** Whether `limit` is short enough to cut off a long prompt. */
export function isShortGpuJobLimit(limit: GpuJobLimit | null): boolean {
  return limit?.computeMs != null && limit.computeMs < SHORT_GPU_JOB_LIMIT_MS;
}

/** What the runtime card is sent: the limit, whether it is short enough to
 * cut a long prompt off (decided here, so the chat's sentence and the card's
 * warning cannot disagree), and the value that raises it. */
export interface GpuJobLimitView extends GpuJobLimit {
  short: boolean;
  suggestedLockupTimeout: string;
}

export function gpuJobLimitView(limit: GpuJobLimit | null): GpuJobLimitView | null {
  return limit ? { ...limit, short: isShortGpuJobLimit(limit), suggestedLockupTimeout: SUGGESTED_LOCKUP_TIMEOUT } : null;
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
 * a Mac, shows the warning. With it set, `modinfo` is not run; a `modinfo`
 * file in that directory stands in for its output. It is inert unset.
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
  // Four values with compute set need nothing else; one value, or a compute
  // field left at 0, needs the module's own description.
  const fields = param.trim().split(",");
  const needsModule = fields.length < 2 || Number(fields[1]?.trim() || 0) === 0;
  const module = !needsModule ? null : fake ? await readFile(`${dir}/modinfo`, "utf8").then(parseModinfo, () => null) : await moduleTimeouts();
  cached = parseLockupTimeout(param, module);
}

function moduleTimeouts(): Promise<ModuleTimeouts | null> {
  return new Promise((resolve) => {
    try {
      execFile("modinfo", ["-p", "amdgpu"], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => {
        resolve(err ? null : parseModinfo(stdout));
      });
    } catch {
      // execFile throws, rather than calling back, for a binary it cannot run.
      resolve(null);
    }
  });
}
