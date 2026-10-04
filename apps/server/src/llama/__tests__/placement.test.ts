import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findTensor, LOOKUP_TABLE_TENSOR } from "../gguf.ts";
import { checkTableSetting, LoadSettingsError, presetLines } from "../load-settings.ts";
import { describePlacement, foldPlacementLine, measuredFrom, newPlacementTracker } from "../placement.ts";
import { renderPreset } from "../preset.ts";
import { parentPidFromStat, sumDrmFdinfo } from "../residency.ts";
import { buildGguf } from "./gguf-fixture.ts";

/**
 * Where a loaded model's memory went: llama.cpp's own allocation log, folded
 * as the router forwards it, and the kernel's per-process GPU counters.
 *
 * The lines below are real: Qwen3.8-Flash-Next UD-IQ4_XS on Pheonix's four
 * V620s (b11342, Vulkan, verbosity 4), once with its 27.5 GiB per-layer table
 * left to llama.cpp (read from the file on demand) and once copied into RAM,
 * and Gemma 4 E4B on Metal. Only the `[port] time I` prefix the router adds is
 * reconstructed.
 */

const MIB = 1024 * 1024;
const NAME = "unsloth/Qwen3.8-Flash-Next-GGUF@UD-IQ4_XS";

function child(port: number, lines: string[]): string[] {
  return lines.map((l) => `[${String(port).padStart(5, " ")}] 0.01.085.178 I ${l}`);
}

const FLASH_SHARED = [
  "load_tensors: offloaded 49/49 layers to GPU",
  "load_tensors:      Vulkan0 model buffer size = 14630.52 MiB",
  "load_tensors:      Vulkan1 model buffer size = 16847.20 MiB",
  "load_tensors:      Vulkan2 model buffer size = 15030.52 MiB",
  "load_tensors:      Vulkan3 model buffer size = 14713.82 MiB",
];
const FLASH_CONTEXT = [
  "llama_context: Vulkan_Host  output buffer size =     0.95 MiB",
  "llama_kv_cache:    Vulkan0 KV buffer size =    51.00 MiB",
  "llama_kv_cache:    Vulkan1 KV buffer size =    51.00 MiB",
  "llama_kv_cache:    Vulkan2 KV buffer size =    51.00 MiB",
  "llama_kv_cache:    Vulkan3 KV buffer size =    51.00 MiB",
  "llama_memory_recurrent:    Vulkan0 RS buffer size =    28.05 MiB",
  "llama_memory_recurrent:    Vulkan1 RS buffer size =    31.52 MiB",
  "llama_memory_recurrent:    Vulkan2 RS buffer size =    28.05 MiB",
  "llama_memory_recurrent:    Vulkan3 RS buffer size =    24.94 MiB",
  "llama_kv_cache:    Vulkan0 KV buffer size =    12.75 MiB",
  "sched_reserve:    Vulkan1 compute buffer size =   318.48 MiB",
  "sched_reserve:    Vulkan0 compute buffer size =   438.48 MiB",
  "sched_reserve:    Vulkan2 compute buffer size =   438.48 MiB",
  "sched_reserve:    Vulkan3 compute buffer size =   438.48 MiB",
  "sched_reserve: Vulkan_Host compute buffer size =   128.81 MiB",
  "sched_reserve: graph: nodes = 6972, splits = 5, input objects = 6, input tensors = 18",
];
/** `lazy-mode` auto: the table is read from the file as rows are needed. */
const FLASH_LAZY = [
  "add: tensor per_layer_token_embd.weight (size = 27465 MiB) lazy read enabled",
  "load_tensors: enabling prefetch for 'per_layer_token_embd.weight'",
  FLASH_SHARED[0],
  "load_tensors:   CPU_Mapped model buffer size =   644.14 MiB",
  ...FLASH_SHARED.slice(1),
  "load_tensors:   CPU_Mapped model buffer size = 27465.95 MiB",
  ...FLASH_CONTEXT,
];
/** `lazy-mode = off`, `load-mode = none`: copied into the process's RAM. */
const FLASH_RAM = [
  FLASH_SHARED[0],
  "load_tensors:          CPU model buffer size = 27465.95 MiB",
  ...FLASH_SHARED.slice(1),
  "load_tensors:  Vulkan_Host model buffer size =   644.14 MiB",
  ...FLASH_CONTEXT,
];
const TABLE_BYTES = Math.round(27465.95 * MIB);

function fold(lines: string[]) {
  const t = newPlacementTracker();
  for (const l of lines) foldPlacementLine(t, l);
  return t;
}

describe("reading where a model's memory went", () => {
  it("finds every buffer of the model on its own port, ignoring another model's", () => {
    const t = fold([
      `0.10.001.000 I srv    operator(): spawning server instance with name=${NAME} on port 51234`,
      `0.10.001.000 I srv    operator(): spawning server instance with name=other@Q4 on port 51300`,
      ...child(51234, FLASH_LAZY.slice(0, 6)),
      ...child(51300, ["load_tensors:      Vulkan0 model buffer size =  9999.00 MiB"]),
      ...child(51234, FLASH_LAZY.slice(6)),
      ...child(51234, ["slot launch_slot_: id  3 | task 0 | processing task, is_child = 0"]),
    ]);
    const raw = t.byName.get(NAME);
    expect(raw?.port).toBe(51234);
    expect(raw?.weights.map((w) => w.buffer)).toEqual(["CPU_Mapped", "Vulkan0", "Vulkan1", "Vulkan2", "Vulkan3", "CPU_Mapped"]);
    expect(raw?.lazy).toEqual([{ tensor: "per_layer_token_embd.weight", bytes: 27465 * MIB }]);
    expect(raw?.offloaded).toEqual({ done: 49, total: 49 });
    expect(raw?.splits).toBe(5);
    expect(raw?.kv).toHaveLength(5);
    expect(raw?.recurrent).toHaveLength(4);
    expect(t.byName.get("other@Q4")?.weights).toEqual([{ buffer: "Vulkan0", bytes: 9999 * MIB }]);
  });

  it("starts afresh on a reload and forgets a model once it is unloaded or gone", () => {
    const spawn = (port: number) => `0.1 I srv  load: spawning server instance with name=${NAME} on port ${String(port)}`;
    const t = fold([spawn(51234), ...child(51234, FLASH_LAZY), spawn(51400), ...child(51400, FLASH_RAM.slice(0, 2))]);
    expect(t.byName.get(NAME)?.weights).toHaveLength(1);
    // The old port's lines no longer belong to anyone.
    foldPlacementLine(t, child(51234, ["load_tensors:      Vulkan0 model buffer size =  1.00 MiB"])[0]);
    expect(t.byName.get(NAME)?.weights).toHaveLength(1);
    foldPlacementLine(t, `0.2 I srv        unload: stopping model instance name=${NAME}`);
    expect(t.byName.has(NAME)).toBe(false);
    const again = fold([spawn(51234), ...child(51234, FLASH_LAZY), `0.3 I srv operator(): instance name=${NAME} exited with status 134`]);
    expect(again.byName.has(NAME)).toBe(false);
  });

  it("says the table is read from the SSD when llama.cpp made it lazy, and the rest is on the GPUs", () => {
    const raw = fold([`spawning server instance with name=${NAME} on port 51234`, ...child(51234, FLASH_LAZY)]).byName.get(NAME);
    if (!raw) throw new Error("no placement");
    const p = describePlacement(raw, TABLE_BYTES, null);
    expect(p.parts.find((x) => x.part === "table")).toEqual({ part: "table", tier: "ssd", device: null, bytes: TABLE_BYTES });
    expect(p.parts.filter((x) => x.part === "weights" && x.tier === "gpu").map((x) => x.device)).toEqual(["Vulkan0", "Vulkan1", "Vulkan2", "Vulkan3"]);
    // The rest of the mapped file (token embeddings, ~644 MiB) is in RAM.
    expect(p.parts.find((x) => x.part === "weights" && x.tier === "ram")?.bytes).toBe(Math.round(644.14 * MIB));
    // Both KV allocations on a device are one entry.
    expect(p.parts.find((x) => x.part === "kv" && x.device === "Vulkan0")?.bytes).toBe(Math.round(51 * MIB) + Math.round(12.75 * MIB));
    expect(p.gpuCount).toBe(4);
    expect(p.splits).toBe(5);
  });

  it("says the table is in RAM when it was copied there, knowing it by its size", () => {
    const raw = fold([`spawning server instance with name=${NAME} on port 51234`, ...child(51234, FLASH_RAM)]).byName.get(NAME);
    if (!raw) throw new Error("no placement");
    const p = describePlacement(raw, TABLE_BYTES, null);
    expect(p.parts.find((x) => x.part === "table")).toMatchObject({ tier: "ram", bytes: TABLE_BYTES });
    // Without the size it is just weights in RAM: nothing claims a table the
    // model was not known to have.
    expect(describePlacement(raw, null, null).parts.some((x) => x.part === "table")).toBe(false);
  });

  it("counts Metal's mapped buffer as the GPU's", () => {
    const lines = child(51314, [
      "load_tensors: offloaded 43/43 layers to GPU",
      "load_tensors:   CPU_Mapped model buffer size =  2288.00 MiB",
      "load_tensors:  MTL0_Mapped model buffer size =  4873.73 MiB",
      "llama_kv_cache:       MTL0 KV buffer size =    64.00 MiB",
      "sched_reserve: graph: nodes = 1863, splits = 2, input objects = 5, input tensors = 10",
    ]);
    const raw = fold(["spawning server instance with name=g on port 51314", ...lines]).byName.get("g");
    if (!raw) throw new Error("no placement");
    const p = describePlacement(raw, 1848 * MIB, null);
    expect(p.parts.find((x) => x.part === "weights" && x.tier === "gpu")?.device).toBe("MTL0");
    // Gemma's 1.8 GiB table is under llama.cpp's 4 GiB lazy threshold, so it
    // is mapped with the rest and cannot be told apart by size here.
    expect(p.gpuCount).toBe(1);
  });

  it("calls GTT beyond the host-side buffers a spill, and the host-side buffers themselves nothing", () => {
    const raw = fold([`spawning server instance with name=${NAME} on port 51234`, ...child(51234, FLASH_LAZY)]).byName.get(NAME);
    if (!raw) throw new Error("no placement");
    // Measured on Pheonix with nothing else loaded: 150 MiB of GTT against
    // ~130 MiB of Vulkan_Host buffers.
    expect(measuredFrom(raw, { vramBytes: 63290 * MIB, gttBytes: 150 * MIB }).spillBytes).toBe(0);
    expect(measuredFrom(raw, { vramBytes: 60000 * MIB, gttBytes: 3500 * MIB }).spillBytes).toBeGreaterThan(3000 * MIB);
  });
});

describe("the kernel's per-process GPU counters", () => {
  const client = (id: number, pdev: string, vram: number, gtt: number) =>
    `pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-pdev:\t${pdev}\ndrm-client-id:\t${String(id)}\ndrm-memory-vram:\t${String(vram)} KiB\ndrm-memory-gtt:\t${String(gtt)} KiB\n`;

  it("counts each client once, per device, and ignores fds that are not DRM", () => {
    const usage = sumDrmFdinfo([
      client(7, "0000:43:00.0", 1024, 10),
      client(7, "0000:43:00.0", 1024, 10), // the same client behind a second fd
      client(7, "0000:23:00.0", 2048, 20), // another device numbers its clients from 1 too
      "pos:\t0\nflags:\t02\n",
    ]);
    expect(usage).toEqual({ vramBytes: 3072 * 1024, gttBytes: 30 * 1024, clients: 2 });
    expect(sumDrmFdinfo(["pos:\t0\n"])).toBeNull();
  });

  it("reads a process's parent from its stat line, whatever its name holds", () => {
    // How a cached model pid is checked again before its memory is read: the
    // port's model changes, and a pid is reused.
    expect(parentPidFromStat("41234 (llama-server) S 41000 41234 41000 0 -1 4194560")).toBe(41000);
    expect(parentPidFromStat("41234 (a (weird) name) R 41000 41234")).toBe(41000);
    expect(parentPidFromStat("")).toBeNull();
  });
});

describe("the lookup table", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loxaic-table-"));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("is found in whichever file holds it, sized from the gap to the next tensor", async () => {
    const kvs = [["general.architecture", { type: "str" as const, v: "qwen4exp" }]] as Parameters<typeof buildGguf>[0];
    const header = buildGguf(kvs, 0, [
      { name: "token_embd.weight", offset: 0 },
      { name: LOOKUP_TABLE_TENSOR, offset: 4096 },
      { name: "output.weight", offset: 4096 + 65536 },
    ]).length;
    const dataStart = Math.ceil(header / 32) * 32;
    const file = path.join(dir, "a.gguf");
    writeFileSync(file, buildGguf(kvs, dataStart + 4096 + 65536 + 1024, [
      { name: "token_embd.weight", offset: 0 },
      { name: LOOKUP_TABLE_TENSOR, offset: 4096 },
      { name: "output.weight", offset: 4096 + 65536 },
    ]));
    expect(await findTensor(file, LOOKUP_TABLE_TENSOR)).toEqual({ name: LOOKUP_TABLE_TENSOR, bytes: 65536 });
    // The last tensor runs to the end of the file.
    expect(await findTensor(file, "output.weight")).toEqual({ name: "output.weight", bytes: 1024 });
    const other = path.join(dir, "b.gguf");
    writeFileSync(other, buildGguf(kvs, 0, ["token_embd.weight"]));
    expect(await findTensor(other, LOOKUP_TABLE_TENSOR)).toBeNull();
  });

  it("refuses a size the file cannot back, and a hostile tensor count", async () => {
    const kvs = [["general.architecture", { type: "str" as const, v: "x" }]] as Parameters<typeof buildGguf>[0];
    const file = path.join(dir, "short.gguf");
    writeFileSync(file, buildGguf(kvs, 0, [{ name: LOOKUP_TABLE_TENSOR, offset: 1 << 30 }]));
    expect(await findTensor(file, LOOKUP_TABLE_TENSOR)).toBeNull();
    const hostile = Buffer.concat([Buffer.from("GGUF"), Buffer.from([3, 0, 0, 0]), Buffer.from([255, 255, 255, 255, 255, 255, 0, 0]), Buffer.alloc(8)]);
    writeFileSync(path.join(dir, "hostile.gguf"), hostile);
    await expect(findTensor(path.join(dir, "hostile.gguf"), LOOKUP_TABLE_TENSOR)).rejects.toThrow(/too large/);
  });

  it("is placed by the setting: SSD on demand, or copied into RAM", () => {
    const facts = { lookupTable: { bytes: TABLE_BYTES } };
    expect(presetLines({ tablePlacement: "ssd" }, { mmprojPath: null, facts })).toEqual(["lazy-mode = on"]);
    expect(presetLines({ tablePlacement: "ram" }, { mmprojPath: null, facts })).toEqual(["lazy-mode = off", "load-mode = none"]);
    // An admin's own memory mapping choice stands.
    expect(presetLines({ tablePlacement: "ram", loadMode: "mlock" }, { mmprojPath: null, facts })).toEqual(["load-mode = mlock", "lazy-mode = off"]);
    expect(presetLines({ tablePlacement: "auto" }, { mmprojPath: null, facts })).toEqual([]);
    // A model without a table writes nothing for it, and keeps its other settings.
    expect(presetLines({ tablePlacement: "ram", ctxSize: 4096 }, { mmprojPath: null, facts: { lookupTable: null } })).toEqual(["ctx-size = 4096"]);
  });

  it("is only a setting for a model that has one", () => {
    expect(() => { checkTableSetting({ tablePlacement: "ram" }, { lookupTable: null }); }).toThrow(LoadSettingsError);
    expect(() => { checkTableSetting({ tablePlacement: "auto" }, { lookupTable: null }); }).not.toThrow();
    expect(() => { checkTableSetting({ tablePlacement: "ram" }, { lookupTable: { bytes: 1 } }); }).not.toThrow();
  });
});

describe("the placement log", () => {
  it("is asked for in managed mode and nowhere else", () => {
    expect(renderPreset([], { devices: null, placementLog: true })).toContain("log-verbosity = 4");
    expect(renderPreset([], { devices: null })).not.toContain("log-verbosity");
  });
});
