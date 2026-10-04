/**
 * Where a loaded host model's memory went, read from llama.cpp's own log.
 *
 * Nothing on llama-server's HTTP side says where a model was put: `/props`
 * and `/models` carry no buffer or device, and the memory table llama.cpp can
 * print (`common_memory_breakdown_print`) only appears at exit. What does say
 * it is the allocation log a model child writes while it loads — one line per
 * buffer, naming the device or host buffer type and its size:
 *
 *     [51234] … I load_tensors:      Vulkan0 model buffer size = 14630.52 MiB
 *     [51234] … I load_tensors:   CPU_Mapped model buffer size = 27465.95 MiB
 *     [51234] … I add: tensor per_layer_token_embd.weight (size = 27465 MiB) lazy read enabled
 *     [51234] … I llama_kv_cache:    Vulkan0 KV buffer size =    51.00 MiB
 *     [51234] … I llama_memory_recurrent:    Vulkan0 RS buffer size =    28.05 MiB
 *     [51234] … I sched_reserve:    Vulkan0 compute buffer size =   438.48 MiB
 *     [51234] … I sched_reserve: graph: nodes = 6972, splits = 5, input objects = 6, input tensors = 18
 *
 * Those are info lines of libllama's, which llama-server prints only at
 * verbosity 4 (`log-verbosity` in the preset's globals, preset.ts); at the
 * default they are dropped. Confirmed against b11342 on Metal and on Pheonix's
 * Vulkan V620s. The router forwards each child's output as `[port] line`, and
 * names the port when it spawns the child — the same two facts
 * `explainModelLoadFailure` reads.
 *
 * The log is folded line by line as it arrives (router.ts `recordLog`), never
 * read back from the in-memory tail, which one busy model can scroll past
 * another's load.
 */

export interface RawBuffer {
  /** The buffer as llama.cpp names it: a device (`Vulkan0`, `CUDA1`,
   * `MTL0_Mapped`) or a host type (`CPU`, `CPU_Mapped`, `CPU_REPACK`,
   * `Vulkan_Host`). */
  buffer: string;
  bytes: number;
}

export interface RawPlacement {
  port: number;
  weights: RawBuffer[];
  kv: RawBuffer[];
  recurrent: RawBuffer[];
  compute: RawBuffer[];
  output: RawBuffer[];
  /** Tensors read row by row from the mapped file on demand (`--lazy-mode`). */
  lazy: { tensor: string; bytes: number }[];
  offloaded: { done: number; total: number } | null;
  splits: number | null;
}

const MIB = 1024 * 1024;

const SPAWN_LINE = /spawning server instance with name=(\S+) on port (\d+)/;
const CHILD_LINE = /^\[\s*(\d+)\]\s?(.*)$/;
const ENDED_LINE = /instance name=(\S+) exited/;
const STOPPING_LINE = /stopping model instance name=(\S+)/;

const MODEL_BUFFER = /load_tensors:\s+(\S+) model buffer size\s*=\s*([\d.]+) MiB/;
const KV_BUFFER = /:\s+(\S+) KV buffer size\s*=\s*([\d.]+) MiB/;
const RS_BUFFER = /:\s+(\S+) RS buffer size\s*=\s*([\d.]+) MiB/;
const COMPUTE_BUFFER = /:\s+(\S+) compute buffer size\s*=\s*([\d.]+) MiB/;
const OUTPUT_BUFFER = /:\s+(\S+)\s+output buffer size\s*=\s*([\d.]+) MiB/;
const LAZY_TENSOR = /tensor (\S+) \(size = (\d+) MiB\) lazy read enabled/;
const OFFLOADED = /offloaded (\d+)\/(\d+) layers to GPU/;
const SPLITS = /graph[^:]*: nodes = [\d,]+, splits = ([\d,]+)/;

export interface PlacementTracker {
  /** Child port → the router's name for the model it serves. */
  ports: Map<number, string>;
  /** Router name → what its newest load allocated. */
  byName: Map<string, RawPlacement>;
}

export function newPlacementTracker(): PlacementTracker {
  return { ports: new Map(), byName: new Map() };
}

function empty(port: number): RawPlacement {
  return { port, weights: [], kv: [], recurrent: [], compute: [], output: [], lazy: [], offloaded: null, splits: null };
}

function buf(m: RegExpExecArray): RawBuffer {
  return { buffer: m[1], bytes: Math.round(Number(m[2]) * MIB) };
}

/**
 * Fold one line of router output into `t`. A spawn starts the model's record
 * afresh (a reload allocates anew), and the model's exit drops it: a model
 * that is not loaded has no placement.
 */
export function foldPlacementLine(t: PlacementTracker, line: string): void {
  const child = CHILD_LINE.exec(line);
  if (!child) {
    const spawn = SPAWN_LINE.exec(line);
    if (spawn) {
      const port = Number(spawn[2]);
      for (const [p, name] of t.ports) if (name === spawn[1]) t.ports.delete(p);
      t.ports.set(port, spawn[1]);
      t.byName.set(spawn[1], empty(port));
      return;
    }
    const gone = ENDED_LINE.exec(line) ?? STOPPING_LINE.exec(line);
    if (gone) {
      const p = t.byName.get(gone[1]);
      if (p) t.ports.delete(p.port);
      t.byName.delete(gone[1]);
    }
    return;
  }
  const name = t.ports.get(Number(child[1]));
  if (!name) return;
  const p = t.byName.get(name);
  if (!p) return;
  const text = child[2];
  // Cheap reject first: almost every line a busy child writes is about slots.
  if (!/buffer size|lazy read|offloaded|splits =/.test(text)) return;
  let m: RegExpExecArray | null;
  if ((m = MODEL_BUFFER.exec(text))) p.weights.push(buf(m));
  else if ((m = KV_BUFFER.exec(text))) p.kv.push(buf(m));
  else if ((m = RS_BUFFER.exec(text))) p.recurrent.push(buf(m));
  else if ((m = COMPUTE_BUFFER.exec(text))) p.compute.push(buf(m));
  else if ((m = OUTPUT_BUFFER.exec(text))) p.output.push(buf(m));
  else if ((m = LAZY_TENSOR.exec(text))) p.lazy.push({ tensor: m[1], bytes: Number(m[2]) * MIB });
  else if ((m = OFFLOADED.exec(text))) p.offloaded = { done: Number(m[1]), total: Number(m[2]) };
  else if ((m = SPLITS.exec(text))) {
    // The first graph line is the one reserved for the whole model; a later
    // one (a draft context) is not the main model's splits.
    p.splits ??= Number(m[1].replace(/,/g, ""));
  }
}

// ── What it means ───────────────────────────────────────────────────────────

/** `gpu` is a device's own memory (unified memory on Apple Silicon); `ram` is
 * host memory the process holds; `ssd` is the model file, read on demand. */
export type PlacementTier = "gpu" | "ram" | "ssd";

export type PlacementPartKind = "weights" | "table" | "kv" | "recurrent" | "compute" | "output";

export interface PlacementPart {
  part: PlacementPartKind;
  tier: PlacementTier;
  /** The GPU (`Vulkan0`), or null for host memory and the file. */
  device: string | null;
  bytes: number;
}

export interface Measured {
  /** Device memory the model's process holds, from the kernel's own count. */
  vramBytes: number;
  /** Host memory the GPU driver maps for it: the host-side buffers
   * (`Vulkan_Host`) and anything evicted from VRAM. */
  gttBytes: number;
  /** GTT beyond the host-side buffers it is expected to hold: memory the
   * driver moved out of VRAM because it was oversubscribed. Every step then
   * reads it across PCIe, which is how two models loaded together ran at a
   * quarter of their speed on Pheonix. */
  spillBytes: number;
}

export interface Placement {
  parts: PlacementPart[];
  offloaded: { done: number; total: number } | null;
  splits: number | null;
  /** GPUs the weights were spread over. */
  gpuCount: number;
  /** From the process itself, where the platform says (Linux amdgpu); null
   * elsewhere — the log's figures then stand alone. */
  measured: Measured | null;
}

/** A device's own buffer, or null for a host one. `MTL0_Mapped` is Metal's
 * view of the mapped file, still the GPU's (unified) memory. */
export function deviceOf(buffer: string): string | null {
  // `CPU`, `CPU_Mapped`, `CPU_REPACK`… and a GPU backend's pinned host memory
  // (`Vulkan_Host`, `CUDA_Host`) are all the host's.
  if (buffer.startsWith("CPU") || buffer.endsWith("_Host")) return null;
  return buffer.replace(/_Mapped$/, "");
}

/** Host buffers the driver keeps in GTT by design, for `spillBytes`. */
function isDriverHost(buffer: string): boolean {
  return buffer.endsWith("_Host");
}

const TABLE_SLACK = 4 * MIB;

/**
 * The parts of a model's memory and where each is. `tableBytes` is the size
 * of the model's per-layer lookup table (catalog `meta.lookupTable`), which
 * names its buffer when llama.cpp did not say "lazy": a host buffer of that
 * size is the table, copied into RAM (`lazy-mode = off`, `load-mode = none`).
 */
export function describePlacement(raw: RawPlacement, tableBytes: number | null, measured: Measured | null): Placement {
  const parts: PlacementPart[] = [];
  const lazyBytes = raw.lazy.reduce((a, l) => a + l.bytes, 0);
  let lazyLeft = lazyBytes;
  let tableLeft = lazyBytes > 0 ? 0 : (tableBytes ?? 0);
  for (const w of raw.weights) {
    const device = deviceOf(w.buffer);
    // A lazy tensor gets a mapped buffer of its own, the same size: that is
    // the file, read on demand, not memory the model holds.
    if (device === null && lazyLeft > 0 && w.buffer === "CPU_Mapped" && Math.abs(w.bytes - lazyLeft) <= TABLE_SLACK) {
      parts.push({ part: "table", tier: "ssd", device: null, bytes: w.bytes });
      lazyLeft = 0;
      continue;
    }
    if (device === null && tableLeft > 0 && Math.abs(w.bytes - tableLeft) <= TABLE_SLACK) {
      // Mapped means the file's pages in the page cache, which the kernel may
      // drop and read back; anything else is the process's own RAM.
      parts.push({ part: "table", tier: w.buffer === "CPU_Mapped" ? "ssd" : "ram", device: null, bytes: w.bytes });
      tableLeft = 0;
      continue;
    }
    parts.push({ part: "weights", tier: device ? "gpu" : "ram", device, bytes: w.bytes });
  }
  const add = (part: PlacementPartKind, list: RawBuffer[]) => {
    for (const b of list) {
      const device = deviceOf(b.buffer);
      parts.push({ part, tier: device ? "gpu" : "ram", device, bytes: b.bytes });
    }
  };
  add("kv", raw.kv);
  add("recurrent", raw.recurrent);
  add("compute", raw.compute);
  add("output", raw.output);
  const gpus = new Set(parts.filter((p) => p.part === "weights" && p.device).map((p) => p.device));
  return { parts: mergeParts(parts), offloaded: raw.offloaded, splits: raw.splits, gpuCount: gpus.size, measured };
}

/** One entry per part, tier and device: a KV cache is allocated once per
 * attention kind (full and sliding), and listing both is noise. */
function mergeParts(parts: PlacementPart[]): PlacementPart[] {
  const out: PlacementPart[] = [];
  for (const p of parts) {
    const same = out.find((o) => o.part === p.part && o.tier === p.tier && o.device === p.device);
    if (same) same.bytes += p.bytes;
    else out.push({ ...p });
  }
  return out;
}

/** The host-side buffers' total, which the driver legitimately holds in GTT. */
export function driverHostBytes(raw: RawPlacement): number {
  return [...raw.weights, ...raw.kv, ...raw.recurrent, ...raw.compute, ...raw.output]
    .filter((b) => isDriverHost(b.buffer))
    .reduce((a, b) => a + b.bytes, 0);
}

/** GTT a model's process may hold beyond its host-side buffers without that
 * being a spill: driver bookkeeping, measured at ~20 MiB on Pheonix. */
const SPILL_SLACK = 256 * MIB;

/** The measured figures, with the spill worked out against the host-side
 * buffers this load asked for. */
export function measuredFrom(raw: RawPlacement, drm: { vramBytes: number; gttBytes: number }): Measured {
  return {
    vramBytes: drm.vramBytes,
    gttBytes: drm.gttBytes,
    spillBytes: Math.max(0, drm.gttBytes - driverHostBytes(raw) - SPILL_SLACK),
  };
}
