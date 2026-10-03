import { describe, expect, it } from 'vitest';
import type { LocalRuntimeView, ModelPlacement } from '@loxaic/api-client';
import { loadedFirst, modelLoadState, pollIntervalMs, restartHeadline, unloadBlockedReason } from './localModels';
import {
  placementLines,
  placementSegments,
  placementSummary,
  placementWarnings,
  tableRamWarning,
  tierLabel,
} from './placement';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const rt = (over: Partial<LocalRuntimeView>): LocalRuntimeView => ({
  mode: 'managed',
  state: 'running',
  reason: null,
  installProgress: null,
  tag: 'b1',
  backend: 'auto',
  flavour: 'vulkan',
  hardware: null,
  devices: [],
  activeDevices: ['Vulkan1'],
  gpuAvailable: true,
  cpuActive: false,
  recentErrors: [],
  ...over,
});

/** Qwen3.8-Flash-Next UD-IQ4_XS on Pheonix's four V620s, as the server
 * describes it (llama/placement.ts), its table left to llama.cpp. */
const flash = (over: Partial<ModelPlacement> = {}): ModelPlacement => ({
  parts: [
    { part: 'weights', tier: 'ram', device: null, bytes: 644 * MiB },
    { part: 'weights', tier: 'gpu', device: 'Vulkan0', bytes: 14630 * MiB },
    { part: 'weights', tier: 'gpu', device: 'Vulkan1', bytes: 16847 * MiB },
    { part: 'weights', tier: 'gpu', device: 'Vulkan2', bytes: 15030 * MiB },
    { part: 'weights', tier: 'gpu', device: 'Vulkan3', bytes: 14713 * MiB },
    { part: 'table', tier: 'ssd', device: null, bytes: 27466 * MiB },
    { part: 'kv', tier: 'gpu', device: 'Vulkan0', bytes: 64 * MiB },
    { part: 'kv', tier: 'gpu', device: 'Vulkan1', bytes: 64 * MiB },
    { part: 'compute', tier: 'gpu', device: 'Vulkan0', bytes: 438 * MiB },
    { part: 'compute', tier: 'ram', device: null, bytes: 129 * MiB },
  ],
  offloaded: { done: 49, total: 49 },
  splits: 5,
  gpuCount: 4,
  measured: null,
  ...over,
});

describe('the restart indicator', () => {
  const started = '2026-10-03T13:00:00.000Z';
  const at = (secs: number) => Date.parse(started) + secs * 1000;

  it('says what the restart is doing, and for how long', () => {
    expect(restartHeadline(rt({ restart: { phase: 'stopping', cause: 'requested', startedAt: started } }), [], at(3))).toBe(
      'Restarting llama.cpp · stopping models · 3 s',
    );
    expect(restartHeadline(rt({ restart: { phase: 'starting', cause: 'requested', startedAt: started } }), [], at(75))).toBe(
      'Restarting llama.cpp · starting · 1 min 15 s',
    );
  });

  it('names the kept-loaded model it is loading, and how many there are', () => {
    const models = [
      { displayName: 'Qwen 27B', pinned: true, enabled: true, runtimeStatus: 'loaded' },
      { displayName: 'Flash-Next', pinned: true, enabled: true, runtimeStatus: 'loading' },
      { displayName: 'Small', pinned: false, enabled: true, runtimeStatus: 'unloaded' },
    ];
    expect(restartHeadline(rt({ restart: { phase: 'loading-pinned', cause: 'requested', startedAt: started } }), models, at(40))).toBe(
      'Restarting llama.cpp · loading Flash-Next (2 of 2) · 40 s',
    );
  });

  it('says when llama.cpp stopped on its own, and nothing when there is no restart', () => {
    expect(restartHeadline(rt({ restart: { phase: 'starting', cause: 'crashed', startedAt: started } }), [], at(1))).toBe(
      'llama.cpp stopped, starting it again · starting · 1 s',
    );
    expect(restartHeadline(rt({ restart: null }), [], at(1))).toBeNull();
    // An older server sends no field at all.
    expect(restartHeadline(rt({}), [], at(1))).toBeNull();
  });

  it('polls fast while a restart, a load or a pending reload is under way', () => {
    const base = { settings: {} as never, freeDiskBytes: null, settingSpecs: [] };
    expect(pollIntervalMs({ ...base, runtime: rt({}), models: [] })).toBe(15_000);
    expect(pollIntervalMs({ ...base, runtime: rt({ restart: { phase: 'starting', cause: 'requested', startedAt: started } }), models: [] })).toBe(1000);
    expect(pollIntervalMs({ ...base, runtime: rt({}), models: [{ status: 'ready', runtimeStatus: 'loading' } as never] })).toBe(1000);
    expect(pollIntervalMs({ ...base, runtime: rt({}), models: [{ status: 'ready', runtimeStatus: 'loaded', reloadPending: true } as never] })).toBe(1000);
  });
});

describe('loaded or not', () => {
  it('reads the router, and treats asleep or unknown as not loaded', () => {
    expect(modelLoadState({ runtimeStatus: 'loaded' })).toBe('loaded');
    expect(modelLoadState({ runtimeStatus: 'loading' })).toBe('loading');
    expect(modelLoadState({ runtimeStatus: 'sleeping' })).toBe('unloaded');
    expect(modelLoadState({ runtimeStatus: null })).toBe('unknown');
  });

  it('lists loaded models first, keeping the order within each group', () => {
    const list = [
      { id: 'a', runtimeStatus: 'unloaded' },
      { id: 'b', runtimeStatus: 'loaded' },
      { id: 'c', runtimeStatus: 'loading' },
      { id: 'd', runtimeStatus: 'loaded' },
    ];
    expect(loadedFirst(list).map((m) => m.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('will not unload a kept-loaded model, and says why', () => {
    expect(unloadBlockedReason({ pinned: true })).toMatch(/Keep loaded/);
    expect(unloadBlockedReason({ pinned: false })).toBeNull();
  });
});

describe('where a model is', () => {
  it('splits the bar by VRAM, RAM and the SSD, always exactly full', () => {
    const segs = placementSegments(flash());
    expect(segs.map((s) => s.tier)).toEqual(['gpu', 'ram', 'ssd']);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBe(100);
    expect(segs.find((s) => s.tier === 'ssd')?.bytes).toBe(27466 * MiB);
  });

  it('says it in a line, and part by part', () => {
    expect(placementSummary(flash())).toBe('60.3 GB in VRAM on 4 GPUs · 773 MB in RAM · 26.8 GB read from SSD');
    expect(placementLines(flash()).map((l) => l.text)).toEqual([
      'Weights: 59.8 GB on 4 GPUs, 644 MB in RAM',
      'Lookup table: 26.8 GB on SSD, read as needed',
      'KV cache: 128 MB on 2 GPUs',
      'Compute buffers: 438 MB on Vulkan0, 129 MB in RAM',
    ]);
  });

  it('calls Apple Silicon memory unified, never VRAM', () => {
    const p = flash({ parts: [{ part: 'weights', tier: 'gpu', device: 'MTL0', bytes: 5 * GiB }], gpuCount: 1 });
    expect(tierLabel('gpu', p)).toBe('Unified memory');
    expect(placementSummary(p)).toBe('5.0 GB in unified memory');
  });

  it('draws memory the driver moved out of VRAM apart, and says what to do', () => {
    const p = flash({ measured: { vramBytes: 58 * GiB, gttBytes: 3 * GiB, spillBytes: 2 * GiB } });
    expect(placementSegments(p).map((s) => s.tier)).toEqual(['gpu', 'spill', 'ram', 'ssd']);
    expect(placementWarnings(p).join(' ')).toMatch(/2\.0 GB of it was moved out of VRAM.*Unload the other models/);
    expect(placementWarnings(flash({ measured: { vramBytes: 58 * GiB, gttBytes: 150 * MiB, spillBytes: 0 } }))).toEqual([]);
  });

  it('warns about a graph split more ways than the GPUs need, and layers left on the CPU', () => {
    // One piece per GPU plus the host's is normal: 5 on four cards.
    expect(placementWarnings(flash())).toEqual([]);
    expect(placementWarnings(flash({ splits: 17 })).join(' ')).toMatch(/17 pieces.*All on GPU/);
    expect(placementWarnings(flash({ offloaded: { done: 40, total: 49 } })).join(' ')).toMatch(/Only 40 of 49 layers/);
  });
});

describe('the lookup table in RAM', () => {
  const host = { totalBytes: 123 * GiB, freeBytes: 20 * GiB };

  it('says what it costs, and warns when the host cannot spare it', () => {
    expect(tableRamWarning('ssd', 27 * GiB, host)).toBeNull();
    expect(tableRamWarning('ram', 27 * GiB, { ...host, freeBytes: 100 * GiB })).toBe(
      'The table is 27.0 GB, copied into RAM each time the model loads.',
    );
    expect(tableRamWarning('ram', 27 * GiB, host)).toMatch(/20\.0 GB free right now, so it may not load/);
    expect(tableRamWarning('ram', 27 * GiB, { totalBytes: 16 * GiB, freeBytes: 8 * GiB })).toMatch(/only 16\.0 GB of RAM, so it will not load/);
  });
});
