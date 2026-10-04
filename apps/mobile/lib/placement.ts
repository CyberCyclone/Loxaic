import type { ModelPlacement, PlacementTier } from '@loxaic/api-client';
import { formatBytes } from './localModels';

/**
 * Where a loaded host model's memory is, in words and in a bar. Pure, so the
 * wording and the warnings are tested rather than eyeballed; the server's
 * placement comes from llama.cpp's own allocation log (llama/placement.ts).
 */

type Part = ModelPlacement['parts'][number];

/** A bar segment: the GPUs, RAM, the file on the SSD, and memory the driver
 * moved out of VRAM (`spill`), which is drawn apart because it is a problem. */
export type PlacementSegmentTier = PlacementTier | 'spill';

export interface PlacementSegment {
  tier: PlacementSegmentTier;
  bytes: number;
  /** Whole percent of the bar, floored; the last segment takes the remainder
   * so the bar is always exactly full. */
  pct: number;
}

/** Apple's GPUs share the host's memory: "VRAM" would be a claim it is not. */
function unified(p: ModelPlacement): boolean {
  return p.parts.some((x) => x.device?.startsWith('MTL') === true);
}

export function tierLabel(tier: PlacementSegmentTier, p: ModelPlacement): string {
  switch (tier) {
    case 'gpu':
      return unified(p) ? 'Unified memory' : 'VRAM';
    case 'ram':
      return 'RAM';
    case 'ssd':
      return 'SSD';
    case 'spill':
      return 'Moved to RAM';
  }
}

const TIER_ORDER: PlacementSegmentTier[] = ['gpu', 'spill', 'ram', 'ssd'];

function sum(parts: Part[]): number {
  return parts.reduce((a, x) => a + x.bytes, 0);
}

export function placementSegments(p: ModelPlacement): PlacementSegment[] {
  const spill = Math.min(p.measured?.spillBytes ?? 0, sum(p.parts.filter((x) => x.tier === 'gpu')));
  const bytes: Record<PlacementSegmentTier, number> = {
    gpu: sum(p.parts.filter((x) => x.tier === 'gpu')) - spill,
    spill,
    ram: sum(p.parts.filter((x) => x.tier === 'ram')),
    ssd: sum(p.parts.filter((x) => x.tier === 'ssd')),
  };
  const total = TIER_ORDER.reduce((a, t) => a + bytes[t], 0);
  const present = TIER_ORDER.filter((t) => bytes[t] > 0);
  if (total <= 0) return [];
  let used = 0;
  return present.map((tier, i) => {
    const pct = i === present.length - 1 ? 100 - used : Math.floor((bytes[tier] / total) * 100);
    used += pct;
    return { tier, bytes: bytes[tier], pct };
  });
}

/** One line under the bar: the tiers, biggest share first among the GPUs. */
export function placementSummary(p: ModelPlacement): string {
  const segs = placementSegments(p);
  const gpus = p.gpuCount > 1 ? ` on ${String(p.gpuCount)} GPUs` : '';
  return segs
    .map((s) => {
      if (s.tier === 'gpu') return `${formatBytes(s.bytes)} ${tierLabel('gpu', p) === 'VRAM' ? 'in VRAM' : 'in unified memory'}${gpus}`;
      if (s.tier === 'spill') return `${formatBytes(s.bytes)} moved to RAM`;
      if (s.tier === 'ram') return `${formatBytes(s.bytes)} in RAM`;
      return `${formatBytes(s.bytes)} read from SSD`;
    })
    .join(' · ');
}

const PART_TEXT: Record<Part['part'], string> = {
  weights: 'Weights',
  table: 'Lookup table',
  kv: 'KV cache',
  recurrent: 'Recurrent state',
  compute: 'Compute buffers',
  output: 'Output buffer',
};

export interface PlacementLine {
  part: Part['part'];
  text: string;
}

/** Where each part is: "Weights: 61.2 GB on 4 GPUs, 644 MB in RAM". */
export function placementLines(p: ModelPlacement): PlacementLine[] {
  const order: Part['part'][] = ['weights', 'table', 'kv', 'recurrent', 'compute', 'output'];
  const out: PlacementLine[] = [];
  for (const part of order) {
    const mine = p.parts.filter((x) => x.part === part);
    if (mine.length === 0) continue;
    const clauses: string[] = [];
    const gpu = mine.filter((x) => x.tier === 'gpu');
    if (gpu.length > 0) {
      const devices = new Set(gpu.map((x) => x.device));
      const where = unified(p) ? 'in unified memory' : devices.size > 1 ? `on ${String(devices.size)} GPUs` : `on ${[...devices][0] ?? 'the GPU'}`;
      clauses.push(`${formatBytes(sum(gpu))} ${where}`);
    }
    const ram = sum(mine.filter((x) => x.tier === 'ram'));
    if (ram > 0) clauses.push(`${formatBytes(ram)} in RAM`);
    const ssd = sum(mine.filter((x) => x.tier === 'ssd'));
    if (ssd > 0) clauses.push(part === 'table' ? `${formatBytes(ssd)} on SSD, read as needed` : `${formatBytes(ssd)} on SSD`);
    out.push({ part, text: `${PART_TEXT[part]}: ${clauses.join(', ')}` });
  }
  return out;
}

/**
 * What is wrong with where it went, if anything. Each one is something an
 * admin can fix from this screen, and says how.
 */
export function placementWarnings(p: ModelPlacement): string[] {
  const out: string[] = [];
  if (p.offloaded && p.offloaded.done < p.offloaded.total) {
    out.push(
      `Only ${String(p.offloaded.done)} of ${String(p.offloaded.total)} layers are on the GPU; the rest run on the CPU, which is much slower. ` +
        'Set GPU layers to "All on GPU", or a shorter context, if it fits.',
    );
  }
  // One piece per GPU, plus the host's: more than that is llama.cpp moving
  // work to the CPU between GPUs, which is how Qwen3.8-Flash-Next ran at half
  // speed with GPU layers left on automatic (#263).
  if (p.splits !== null && p.gpuCount > 0 && p.splits > 2 * p.gpuCount + 1) {
    out.push(
      `llama.cpp split this model into ${String(p.splits)} pieces, so the CPU works between the GPUs on every token. ` +
        'Setting GPU layers to "All on GPU" usually brings that down to one piece per GPU.',
    );
  }
  if (p.measured && p.measured.spillBytes > 0) {
    out.push(
      `${formatBytes(p.measured.spillBytes)} of it was moved out of VRAM into system RAM because the GPUs ran out, which slows every reply. ` +
        'Unload the other models, then unload and load this one.',
    );
  }
  return out;
}

/** Why VRAM is not a choice for the table, measured on Pheonix's V620s with
 * b11342: llama.cpp refuses the lookup on the GPU and the load stops. */
export const TABLE_VRAM_REASON =
  "Not offered: llama.cpp can't look rows up in this table on a GPU, and the model stops loading if it is put there.";

/**
 * The warning beside "RAM" for the lookup table, or null. It is copied into
 * RAM when the model loads, so it needs that much free — a warning, never a
 * refusal: free memory moves, and the admin may be about to close something.
 */
export function tableRamWarning(
  choice: unknown,
  tableBytes: number | null | undefined,
  host: { totalBytes: number; freeBytes: number } | undefined,
): string | null {
  if (choice !== 'ram' || !tableBytes) return null;
  const need = `The table is ${formatBytes(tableBytes)}, copied into RAM each time the model loads.`;
  if (!host) return need;
  if (tableBytes > host.totalBytes) return `${need} This host has only ${formatBytes(host.totalBytes)} of RAM, so it will not load.`;
  if (tableBytes > host.freeBytes) return `${need} This host has ${formatBytes(host.freeBytes)} free right now, so it may not load.`;
  return need;
}
