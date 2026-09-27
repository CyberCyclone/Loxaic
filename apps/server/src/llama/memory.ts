import { listServableModels, rowMeta, type LocalModelRow } from "./catalog.ts";
import { estimateFit } from "./fit.ts";
import { offloadMemory, remeasureDevices, routerEndpoint, routerModelStatuses, runtimeView } from "./router.ts";

/**
 * What a model can use, as it stands now.
 *
 * The fit label used to be measured against the free memory llama.cpp listed
 * when the router started. That was wrong twice over on a real two-GPU box:
 * free memory moves after start (another program, and our own models, load
 * and unload), and a figure that silently subtracted another program's 26 GB
 * from one card read to an admin as "it only counts one GPU", since the GPU
 * rows showed each card's total. This module keeps the three parts apart:
 *
 * - `freeBytes`: free on the active devices, re-measured (router.ts'
 *   `remeasureDevices`).
 * - `reclaimableBytes`: what our own loaded, *unpinned* models hold — they are
 *   unloaded to make room (room.ts), so a model that fits once they are gone
 *   fits. A pinned model's memory is not reclaimable.
 * - `otherBytes`: what is left of the devices' total — other programs.
 *
 * Our models' footprints are estimates (fit.ts), which is why room.ts decides
 * what to unload on a *re-measured* figure after each unload rather than on
 * these sums.
 */

export interface MemoryBreakdown {
  /** Free on the active devices, measured now. */
  freeBytes: number;
  /** Held by our loaded, unpinned models (and the model itself, when it is
   * the one being measured), which would be unloaded to make room. */
  reclaimableBytes: number;
  /** Held by our loaded, pinned models. */
  pinnedBytes: number;
  /** Held by everything else on those devices. */
  otherBytes: number;
  /** The active devices' total. */
  totalBytes: number;
  deviceCount: number;
}

export interface LoadedFootprint {
  id: string;
  displayName: string;
  pinned: boolean;
  /** `loaded`, or `loading` — a loading model is holding (or about to hold)
   * its memory too. */
  status: string;
  estBytes: number;
}

/** A model's estimated footprint on the GPU with its own settings. */
export function footprintBytes(row: LocalModelRow): number {
  return estimateFit({
    weightBytes: row.sizeBytes,
    nLayers: rowMeta(row).nLayers ?? null,
    settings: row.loadSettings ?? {},
    memoryBytes: null,
    cpu: false,
  }).requiredBytes;
}

let loaded: LoadedFootprint[] = [];
/** Which of our models were loaded at the last measurement. */
let measuredWith: string | null = null;

/** Our models the router has loaded (or is loading), from the last refresh. */
export function loadedFootprints(): LoadedFootprint[] {
  return loaded;
}

/**
 * Re-measure free memory and re-read which of our models are loaded. Cheap
 * inside `maxAgeMs` of the last measurement — unless one of our models has
 * loaded or unloaded since, which moves free memory by gigabytes and would
 * otherwise go unseen for the rest of the window. `force` measures again
 * whatever the age.
 */
export async function refreshMemory(opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<void> {
  if (!routerEndpoint()) {
    loaded = [];
    return;
  }
  const [statuses, rows] = await Promise.all([routerModelStatuses(), listServableModels()]);
  loaded = rows.flatMap((row) => {
    const status = statuses.get(row.id)?.value;
    if (status !== "loaded" && status !== "loading") return [];
    return [{ id: row.id, displayName: row.displayName, pinned: row.pinned, status, estBytes: footprintBytes(row) }];
  });
  const key = loaded
    .map((m) => `${m.id}=${m.status}`)
    .sort()
    .join(",");
  const changed = key !== measuredWith;
  measuredWith = key;
  await remeasureDevices(changed ? { force: true } : opts);
}

/**
 * The memory a model is measured against: free now, plus what our unpinned
 * models hold (they would be unloaded for it), plus the model's own footprint
 * when it is itself loaded. CPU, and a runtime that has listed no devices yet,
 * fall back to router.ts' `offloadMemory` with no breakdown.
 */
export function availableMemory(forId?: string): {
  bytes: number | null;
  cpu: boolean;
  breakdown: MemoryBreakdown | null;
} {
  const base = offloadMemory();
  const view = runtimeView();
  if (base.cpu || base.bytes === null || view.devices.length === 0) return { ...base, breakdown: null };
  const active = view.activeDevices === "none" ? [] : view.activeDevices;
  const devs = active.length > 0 ? view.devices.filter((d) => active.includes(d.name)) : view.devices;
  const totalBytes = devs.reduce((n, d) => n + d.totalBytes, 0);
  const freeBytes = base.bytes;
  let reclaimableBytes = 0;
  let pinnedBytes = 0;
  for (const m of loaded) {
    if (m.pinned && m.id !== forId) pinnedBytes += m.estBytes;
    else reclaimableBytes += m.estBytes;
  }
  // Our footprints are estimates; clamp so an over-estimate never reports
  // other programs holding negative memory, or ours exceeding what is in use.
  const used = Math.max(0, totalBytes - freeBytes);
  const ours = Math.min(used, reclaimableBytes + pinnedBytes);
  const scale = reclaimableBytes + pinnedBytes > 0 ? ours / (reclaimableBytes + pinnedBytes) : 0;
  reclaimableBytes = Math.round(reclaimableBytes * scale);
  pinnedBytes = Math.round(pinnedBytes * scale);
  const otherBytes = Math.max(0, used - reclaimableBytes - pinnedBytes);
  return {
    bytes: freeBytes + reclaimableBytes,
    cpu: false,
    breakdown: { freeBytes, reclaimableBytes, pinnedBytes, otherBytes, totalBytes, deviceCount: devs.length },
  };
}

/** Test seam. */
export function __setLoadedFootprintsForTest(next: LoadedFootprint[]): void {
  loaded = next;
}
