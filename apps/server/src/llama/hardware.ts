import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LlamaBackend } from "./settings.ts";

/**
 * What this machine can run llama.cpp on, decided the way LM Studio decides
 * it: look at the hardware, pick the build that uses the GPU, and never pick
 * the CPU on its own. CPU inference is reachable only through an admin's
 * explicit, acknowledged choice (settings.ts) — a model that silently lands on
 * the CPU looks exactly like a broken product.
 *
 * Detection here is only a first guess, before a runtime exists. Once one is
 * installed, `llama-server --list-devices` is the source of truth for which
 * devices exist and how much memory each has (`parseDeviceList`).
 */

/** A concrete build flavour — the manifest key's last segment. */
export type BuildFlavour = "metal" | "vulkan" | "cuda12" | "cuda13" | "rocm" | "cpu";

export interface GpuGuess {
  name: string;
  /** Bytes, when the OS says. */
  memoryBytes: number | null;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
}

export interface HardwareGuess {
  platform: NodeJS.Platform;
  arch: string;
  gpus: GpuGuess[];
  /** The flavour `auto` resolves to, or null when there is no usable GPU. */
  flavour: Exclude<BuildFlavour, "cpu"> | null;
  /** Why `flavour` is null, in a sentence an admin can act on. */
  reason: string | null;
  /** System RAM, for the CPU fit estimate. */
  ramBytes: number;
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

interface NvidiaGpu {
  name: string;
  memoryBytes: number | null;
  driverMajor: number | null;
}

/** `nvidia-smi` is present wherever the NVIDIA driver is, on Linux and Windows. */
async function nvidiaGpus(): Promise<NvidiaGpu[]> {
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(",").map((s) => s.trim());
      const name = cols.at(0) ?? "";
      const mib = Number(cols.at(1));
      const major = Number((cols.at(2) ?? "").split(".").at(0));
      return {
        name: name || "NVIDIA GPU",
        memoryBytes: Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : null,
        driverMajor: Number.isFinite(major) && major > 0 ? major : null,
      };
    });
}

const PCI_VENDORS: Record<string, GpuGuess["vendor"]> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

/** Linux display adapters from sysfs — no tool needed, readable unprivileged. */
function linuxDrmGpus(): GpuGuess[] {
  const root = "/sys/class/drm";
  let entries: string[];
  try {
    entries = readdirSync(root).filter((e) => /^card\d+$/.test(e));
  } catch {
    return [];
  }
  const out: GpuGuess[] = [];
  for (const card of entries) {
    const dev = path.join(root, card, "device");
    let vendorId = "";
    try {
      vendorId = readFileSync(path.join(dev, "vendor"), "utf8").trim();
    } catch {
      continue;
    }
    let memoryBytes: number | null = null;
    try {
      // amdgpu reports dedicated VRAM here; other drivers do not.
      const v = Number(readFileSync(path.join(dev, "mem_info_vram_total"), "utf8").trim());
      if (Number.isFinite(v) && v > 0) memoryBytes = v;
    } catch {
      // unknown
    }
    const vendor = PCI_VENDORS[vendorId] ?? "other";
    out.push({ name: `${vendor === "other" ? "GPU" : vendor.toUpperCase()} (${card})`, memoryBytes, vendor });
  }
  return out;
}

const VULKAN_LOADERS = [
  "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
  "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
  "/usr/lib64/libvulkan.so.1",
  "/usr/lib/libvulkan.so.1",
];

function hasVulkanLoader(): boolean {
  if (process.platform === "win32") {
    return existsSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "vulkan-1.dll"));
  }
  return VULKAN_LOADERS.some((p) => existsSync(p));
}

/**
 * The CUDA build a driver can run. CUDA 13 needs a 580-series driver; 12.x
 * builds run on anything from the 525 series. Older than that, NVIDIA's Vulkan
 * driver is the better bet than a CUDA runtime that will refuse to start.
 */
export function cudaFlavourForDriver(driverMajor: number | null): "cuda13" | "cuda12" | null {
  if (driverMajor === null) return "cuda12";
  if (driverMajor >= 580) return "cuda13";
  if (driverMajor >= 525) return "cuda12";
  return null;
}

export async function detectHardware(): Promise<HardwareGuess> {
  const platform = process.platform;
  const arch = process.arch;
  const ramBytes = os.totalmem();
  const base = { platform, arch, ramBytes };

  const fake = fakeHardware(base);
  if (fake) return fake;

  if (platform === "darwin") {
    if (arch === "arm64") {
      // Apple Silicon shares memory between CPU and GPU. The OS lets the GPU
      // wire roughly three quarters of it by default; the runtime's own
      // `--list-devices` replaces this guess with the real figure.
      return {
        ...base,
        gpus: [{ name: "Apple GPU (Metal)", memoryBytes: Math.floor(ramBytes * 0.75), vendor: "apple" }],
        flavour: "metal",
        reason: null,
      };
    }
    return { ...base, gpus: [], flavour: null, reason: "Intel Macs have no supported GPU build of llama.cpp." };
  }

  if (platform !== "linux" && platform !== "win32") {
    return { ...base, gpus: [], flavour: null, reason: `No llama.cpp build is published for ${platform}.` };
  }

  const nvidia = await nvidiaGpus();
  const drm = platform === "linux" ? linuxDrmGpus().filter((g) => g.vendor !== "nvidia") : [];
  const gpus: GpuGuess[] = [
    ...nvidia.map((g) => ({ name: g.name, memoryBytes: g.memoryBytes, vendor: "nvidia" as const })),
    ...drm,
  ];

  if (nvidia.length > 0 && arch === "x64") {
    const flavour = cudaFlavourForDriver(nvidia[0].driverMajor);
    if (flavour) return { ...base, gpus, flavour, reason: null };
  }
  if (gpus.length > 0) {
    if (hasVulkanLoader()) return { ...base, gpus, flavour: "vulkan", reason: null };
    return {
      ...base,
      gpus,
      flavour: null,
      reason:
        platform === "linux"
          ? "A GPU was found, but the Vulkan loader is not installed. Install it (on Debian/Ubuntu: `sudo apt install libvulkan1 mesa-vulkan-drivers`) and restart the runtime."
          : "A GPU was found, but Vulkan is not available. Update the graphics driver and restart the runtime.",
    };
  }
  // Windows without nvidia-smi: every current AMD and Intel driver ships the
  // Vulkan loader, so its presence is the best signal we have without WMI.
  if (platform === "win32" && hasVulkanLoader()) {
    return { ...base, gpus: [{ name: "GPU (Vulkan)", memoryBytes: null, vendor: "other" }], flavour: "vulkan", reason: null };
  }
  return { ...base, gpus: [], flavour: null, reason: "No GPU was found on this machine." };
}

/**
 * `LOXAIC_FAKE_HARDWARE=gpu|none` — **test-only**, and honoured only together
 * with `LOXAIC_LLAMA_SERVER_BIN` (the fake runtime), so it can never switch off
 * real detection on a real install. The e2e harness runs on machines with no
 * GPU at all and needs to drive both the GPU path and the no-GPU warning.
 */
function fakeHardware(base: Pick<HardwareGuess, "platform" | "arch" | "ramBytes">): HardwareGuess | null {
  const mode = process.env.LOXAIC_FAKE_HARDWARE;
  if (!mode || !process.env.LOXAIC_LLAMA_SERVER_BIN) return null;
  if (mode === "none") return { ...base, gpus: [], flavour: null, reason: "No GPU was found on this machine." };
  return {
    ...base,
    gpus: [{ name: "Fake GPU", memoryBytes: 24 * 1024 ** 3, vendor: "other" }],
    flavour: "vulkan",
    reason: null,
  };
}

/** Resolve the admin's backend choice against the hardware. `auto` never
 * resolves to CPU. Returns null with the hardware's reason when nothing fits. */
export function resolveFlavour(
  backend: LlamaBackend,
  hw: Pick<HardwareGuess, "flavour" | "platform">,
): BuildFlavour | null {
  switch (backend) {
    case "auto":
      return hw.flavour;
    case "cpu":
      return "cpu";
    case "metal":
      return hw.platform === "darwin" ? "metal" : null;
    case "cuda":
      return hw.flavour === "cuda12" || hw.flavour === "cuda13" ? hw.flavour : "cuda12";
    case "vulkan":
      return "vulkan";
    case "rocm":
      return "rocm";
  }
}

/** The manifest key for a flavour on this machine. */
export function buildKey(flavour: BuildFlavour, platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}-${flavour}`;
}

// ── The runtime's own view of the hardware ──────────────────────────────────

export interface RuntimeDevice {
  /** What `--device` takes: `MTL0`, `Vulkan1`, `CUDA0`, `ROCm0`. */
  name: string;
  description: string;
  totalBytes: number;
  freeBytes: number;
}

/**
 * Parse `llama-server --list-devices`:
 *
 *   Available devices:
 *     MTL0: Apple M3 Max (28753 MiB, 28753 MiB free)
 *     BLAS: Accelerate (0 MiB, 0 MiB free)
 *
 * Entries reporting no memory (BLAS, the CPU) are not offload targets and are
 * dropped: an empty list is exactly what "no GPU" means to the caller.
 */
export function parseDeviceList(text: string): RuntimeDevice[] {
  const out: RuntimeDevice[] = [];
  const re = /^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const total = Number(m[3]) * 1024 * 1024;
    if (total <= 0) continue;
    out.push({ name: m[1], description: m[2], totalBytes: total, freeBytes: Number(m[4]) * 1024 * 1024 });
  }
  return out;
}

/** GPUs with less than this free are left out of the default device set. */
export const MIN_DEFAULT_DEVICE_BYTES = 4 * 1024 ** 3;

/**
 * The devices used when an admin has not chosen: every GPU with at least 4 GB
 * **free** when llama.cpp lists them — which is at router start, before any of
 * our own models are loaded, so "free" means "not held by something else".
 *
 * Free rather than total because of two real cases on one box: a 30 GB V620
 * beside a 2 GB GT 1030 (a total-memory rule already leaves the small card
 * out), and later a second V620 beside the first while LM Studio held 26 GB
 * of the first — both are 30 GB cards, so only free memory tells them apart,
 * and splitting a model onto the busy one fails to load. When no GPU has 4 GB
 * free, fall back to the total-memory rule, then to every GPU rather than none.
 */
export function defaultDevices(devices: RuntimeDevice[]): string[] {
  const free = devices.filter((d) => d.freeBytes >= MIN_DEFAULT_DEVICE_BYTES);
  if (free.length > 0) return free.map((d) => d.name);
  const big = devices.filter((d) => d.totalBytes >= MIN_DEFAULT_DEVICE_BYTES);
  return (big.length > 0 ? big : devices).map((d) => d.name);
}
