import { describe, expect, it } from 'vitest';
import type { LoadSettingSpec, LocalRuntimeView } from '@loxaic/api-client';
import { cpuWarning, etaSeconds, parseNumericInput, pollIntervalMs, progressPercent, runtimeHeadline, setDraft } from './localModels';

const rt = (over: Partial<LocalRuntimeView>): LocalRuntimeView => ({
  mode: 'managed',
  state: 'running',
  reason: null,
  installProgress: null,
  tag: 'b1',
  backend: 'auto',
  flavour: 'vulkan',
  hardware: null,
  devices: [{ name: 'Vulkan1', description: 'AMD Radeon Pro V620', totalBytes: 30e9, freeBytes: 30e9 }],
  activeDevices: ['Vulkan1'],
  gpuAvailable: true,
  cpuActive: false,
  recentErrors: [],
  ...over,
});

describe('CPU warnings', () => {
  it('names the GPU that would go unused when there is one', () => {
    const w = cpuWarning(rt({}));
    expect(w.title).toBe('Leave AMD Radeon Pro V620 unused?');
    expect(w.message).toMatch(/many times slower/);
  });

  it('offers CPU as the only option, for small models, when there is no GPU', () => {
    const w = cpuWarning(rt({ gpuAvailable: false, devices: [], activeDevices: [] }));
    expect(w.title).toBe('Run models on the CPU?');
    expect(w.confirm).toMatch(/small models only/);
  });
});

describe('runtime headline', () => {
  it('says which device it runs on, and says CPU plainly', () => {
    expect(runtimeHeadline(rt({}))).toBe('Running on AMD Radeon Pro V620');
    expect(runtimeHeadline(rt({ cpuActive: true }))).toBe('Running on the CPU');
    expect(runtimeHeadline(rt({ state: 'needs-gpu' }))).toBe('No supported GPU found');
  });
});

describe('polling', () => {
  it('polls fast only while something is moving', () => {
    const base = { runtime: rt({}), settings: {} as never, freeDiskBytes: null, settingSpecs: [] };
    expect(pollIntervalMs({ ...base, models: [] })).toBe(15_000);
    expect(pollIntervalMs({ ...base, models: [{ status: 'downloading' } as never] })).toBe(1000);
    expect(pollIntervalMs({ ...base, runtime: rt({ state: 'installing' }), models: [] })).toBe(1000);
  });
});

describe('progress', () => {
  it('floors, so a nearly finished download never reads 100%', () => {
    expect(progressPercent({ bytesDone: 999, sizeBytes: 1000 })).toBe(99);
    expect(progressPercent({ bytesDone: 0, sizeBytes: 0 })).toBe(0);
  });

  it('estimates time left from two samples, and says nothing without a rate', () => {
    expect(etaSeconds(null, { at: 1000, bytes: 10 }, 100)).toBeNull();
    expect(etaSeconds({ at: 0, bytes: 0 }, { at: 1000, bytes: 10 }, 100)).toBe(9);
    expect(etaSeconds({ at: 0, bytes: 10 }, { at: 1000, bytes: 10 }, 100)).toBeNull();
  });
});

describe('settings input', () => {
  const ctx: LoadSettingSpec = { key: 'ctxSize', flag: 'ctx-size', group: 'context', label: 'Context length', help: '', type: 'int', min: 512, max: 'nCtxTrain' };
  const layers: LoadSettingSpec = { key: 'gpuLayers', flag: 'n-gpu-layers', group: 'offload', label: 'GPU offload', help: '', type: 'int', min: 0, max: 'nLayers', words: ['auto', 'all'] };
  const meta = { nCtxTrain: 40960, nLayers: 28 };

  it('blank means the default, and removes the key', () => {
    expect(parseNumericInput(ctx, '  ', meta)).toEqual({ value: null });
    expect(setDraft({ ctxSize: 4096, seed: 1 }, 'ctxSize', null)).toEqual({ seed: 1 });
  });

  it('checks the model-specific ceiling', () => {
    expect(parseNumericInput(ctx, '8192', meta)).toEqual({ value: 8192 });
    expect(parseNumericInput(ctx, '65536', meta)).toEqual({ error: 'Context length can be at most 40960' });
    expect(parseNumericInput(layers, '29', meta)).toEqual({ value: 29 });
    expect(parseNumericInput(layers, 'ALL', meta)).toEqual({ value: 'all' });
    expect(parseNumericInput(ctx, '12.5', meta)).toEqual({ error: 'Context length must be a whole number' });
  });
});
