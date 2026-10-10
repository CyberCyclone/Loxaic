import { describe, expect, it } from 'vitest';
import type { LoadSettingSpec, LocalRuntimeView } from '@loxaic/api-client';
import {
  configFromDraft,
  cpuWarning,
  describeFit,
  draftFactor,
  draftFromConfig,
  etaSeconds,
  gpuJobLimitWarning,
  parseNumericInput,
  pollIntervalMs,
  progressPercent,
  runtimeHeadline,
  setDraft,
  standardCtx,
  stageErrors,
  suggestStages,
} from './localModels';

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

describe('the GPU driver\'s job limit', () => {
  it('warns about a short limit, says whose it is, and gives the line that raises it', () => {
    const w = gpuJobLimitWarning(rt({ gpuJobLimit: { driver: 'amdgpu', computeMs: 2000, source: 'default' } }));
    expect(w?.message).toMatch(/^This host's AMD GPU driver \(amdgpu\) resets the GPU when one piece of GPU work runs longer than 2 s\./);
    expect(w?.message).toContain('update-initramfs');
    expect(w?.fix).toBe("echo 'options amdgpu lockup_timeout=2000,60000,2000,2000' | sudo tee /etc/modprobe.d/amdgpu-timeout.conf");
    expect(gpuJobLimitWarning(rt({ gpuJobLimit: { driver: 'amdgpu', computeMs: 1500, source: 'set' } }))?.message).toMatch(
      /^This host is set to reset the GPU when one piece of GPU work runs longer than 1500 ms\./,
    );
  });

  it('says nothing for a long limit, no limit, an unknown one, or an older server', () => {
    expect(gpuJobLimitWarning(rt({ gpuJobLimit: { driver: 'amdgpu', computeMs: 60_000, source: 'set' } }))).toBeNull();
    expect(gpuJobLimitWarning(rt({ gpuJobLimit: { driver: 'amdgpu', computeMs: 10_000, source: 'set' } }))).toBeNull();
    expect(gpuJobLimitWarning(rt({ gpuJobLimit: { driver: 'amdgpu', computeMs: null, source: 'set' } }))).toBeNull();
    expect(gpuJobLimitWarning(rt({ gpuJobLimit: null }))).toBeNull();
    expect(gpuJobLimitWarning(rt({}))).toBeNull();
  });
});

describe('runtime headline', () => {
  it('says which device it runs on, and says CPU plainly', () => {
    expect(runtimeHeadline(rt({}))).toBe('Running on AMD Radeon Pro V620');
    expect(runtimeHeadline(rt({ cpuActive: true }))).toBe('Running on the CPU');
    expect(runtimeHeadline(rt({ state: 'needs-gpu' }))).toBe('No supported GPU found');
    expect(runtimeHeadline(rt({ state: 'off' }))).toBe('Host models are off');
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
  const ctx: LoadSettingSpec = { key: 'ctxSize', flag: 'ctx-size', group: 'context', label: 'Context length', help: '', type: 'int', min: 512, max: 'nCtxTrain', softMax: true };
  const layers: LoadSettingSpec = { key: 'gpuLayers', flag: 'n-gpu-layers', group: 'offload', label: 'GPU offload', help: '', type: 'int', min: 0, max: 'nLayers', words: ['auto', 'all'] };
  const meta = { nCtxTrain: 40960, nLayers: 28 };

  it('blank means the default, and removes the key', () => {
    expect(parseNumericInput(ctx, '  ', meta)).toEqual({ value: null });
    expect(setDraft({ ctxSize: 4096, seed: 1 }, 'ctxSize', null)).toEqual({ seed: 1 });
  });

  it('checks the model-specific ceiling', () => {
    expect(parseNumericInput(ctx, '8192', meta)).toEqual({ value: 8192 });
    // The trained maximum is advice for the context length: past it is a
    // value with a warning, so Save stays possible (YaRN needs it).
    expect(parseNumericInput(ctx, '65536', meta)).toEqual({ value: 65536, warning: expect.stringMatching(/above the 40,960 this model was trained for.*YaRN/) as string });
    expect(parseNumericInput(ctx, '40960', meta)).toEqual({ value: 40960 });
    expect(parseNumericInput(ctx, String(2 ** 31), meta)).toEqual({ error: 'Context length can be at most 2147483647' });
    expect(parseNumericInput(ctx, '100', meta)).toEqual({ error: 'Context length must be at least 512' });
    // Any other ceiling is still a limit.
    expect(parseNumericInput(layers, '30', meta)).toEqual({ error: 'GPU offload can be at most 29' });
    expect(parseNumericInput(layers, '29', meta)).toEqual({ value: 29 });
    expect(parseNumericInput(layers, 'ALL', meta)).toEqual({ value: 'all' });
    expect(parseNumericInput(ctx, '12.5', meta)).toEqual({ error: 'Context length must be a whole number' });
  });
});

describe('describing a fit', () => {
  const GB = 1024 ** 3;
  it('says how both GPUs add up, and who holds the rest', () => {
    // Two 30 GB cards, another program holding 26 GB of one of them.
    const text = describeFit({
      label: 'will-fit',
      requiredBytes: 20 * GB,
      availableBytes: 34 * GB,
      target: 'gpu',
      breakdown: { freeBytes: 34 * GB, reclaimableBytes: 0, pinnedBytes: 0, otherBytes: 26 * GB, totalBytes: 60 * GB, deviceCount: 2 },
    });
    expect(text).toBe('Needs about 20.0 GB of 34.0 GB available on 2 GPUs (60.0 GB in all). Other programs are using 26.0 GB.');
  });

  it('counts what unpinned models give back, and what pinned ones keep', () => {
    const text = describeFit({
      label: 'might-fit',
      requiredBytes: 20 * GB,
      availableBytes: 22 * GB,
      target: 'gpu',
      breakdown: { freeBytes: 10 * GB, reclaimableBytes: 12 * GB, pinnedBytes: 8 * GB, otherBytes: 0, totalBytes: 30 * GB, deviceCount: 1 },
    });
    expect(text).toContain('available on the GPU');
    expect(text).toContain('That counts 12.0 GB other models are using');
    expect(text).toContain('Pinned models keep 8.0 GB.');
    expect(text).not.toContain('Other programs');
  });

  it('falls back to a plain sentence without a breakdown', () => {
    expect(describeFit({ label: 'will-fit', requiredBytes: GB, availableBytes: 8 * GB, target: 'cpu' })).toBe(
      'Needs about 1.0 GB of 8.0 GB RAM.',
    );
    expect(describeFit({ label: 'unknown', requiredBytes: GB, availableBytes: null, target: 'gpu' })).toBe('Needs about 1.0 GB');
  });
});

describe('extended context stages', () => {
  const K = 1024;
  const meta = { nCtxTrain: 256 * K, nLayers: 64 };
  const stage = (ctx: string, extra: object = {}) => ({ ctx, ...extra });

  it('takes the standard context from the admin, else from the file', () => {
    expect(standardCtx({ ctxSize: 65536 }, meta)).toBe(65536);
    expect(standardCtx({}, meta)).toBe(256 * K);
    expect(standardCtx({}, {})).toBeNull();
  });

  it('works the factor out of the stage, not from the admin', () => {
    expect(draftFactor(stage(String(512 * K)), meta)).toBe(2);
    expect(draftFactor(stage(String(1024 * K)), meta)).toBe(4);
    expect(draftFactor(stage(String(768 * K)), meta)).toBe(3);
    expect(draftFactor(stage('nonsense'), meta)).toBeNull();
    expect(draftFactor(stage(String(1024 * K), { base: { ctxSize: 1024 * K, ropeScale: 3.5 } }), meta)).toBe(3.5);
    expect(draftFactor(stage(String(512 * K)), {})).toBeNull();
  });

  it('suggests stages up to what the file says it stretches, else 4×', () => {
    expect(suggestStages(meta, 256 * K)).toEqual([512 * K, 768 * K, 1024 * K]);
    expect(suggestStages({ ...meta, shape: { ropeScaling: { type: 'yarn', factor: 2, originalContext: null } } }, 256 * K)).toEqual([512 * K]);
    // Nothing to suggest below what is already standard.
    expect(suggestStages(meta, 600 * K)).toEqual([768 * K, 1024 * K]);
    expect(suggestStages({}, 256 * K)).toEqual([]);
  });

  it('says what is wrong with each stage before Save', () => {
    const draft = { ...draftFromConfig(null), enabled: true, stages: [stage(String(512 * K)), stage(String(512 * K)), stage('100'), stage(''), stage(String(2 ** 31))] };
    expect(stageErrors(draft, 256 * K, meta)).toEqual([
      null,
      'Must be larger than stage 1.',
      'Enter a whole number of tokens, at least 512.',
      'Enter a whole number of tokens, at least 512.',
      `At most ${String(2 ** 31 - 1)}.`,
    ]);
    expect(stageErrors({ ...draft, stages: [stage(String(200 * K))] }, 256 * K, meta)[0]).toMatch(/larger than the standard context \(262,144\)/);
    expect(stageErrors({ ...draft, stages: [stage(String(512 * K))] }, 256 * K, {})[0]).toMatch(/does not say how long it was trained for/);
  });

  it('round-trips a config without losing fields the sheet has no control for', () => {
    const config = {
      enabled: true,
      whoMayChange: 'admins' as const,
      whenFull: 'extend' as const,
      stages: [{ ctxSize: 512 * K, ropeScale: 2.5, betaFast: 32 }, { ctxSize: 1024 * K, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }],
    };
    const draft = draftFromConfig(config);
    expect(draft.stages.map((s) => s.ctx)).toEqual([String(512 * K), String(1024 * K)]);
    draft.stages[0].ctx = String(600 * K);
    draft.stages[1].cacheTypeK = undefined; // cleared in the sheet
    expect(JSON.parse(JSON.stringify(configFromDraft(draft)))).toEqual({
      enabled: true,
      whoMayChange: 'admins',
      whenFull: 'extend',
      stages: [{ ctxSize: 600 * K, ropeScale: 2.5, betaFast: 32 }, { ctxSize: 1024 * K, cacheTypeV: 'q8_0' }],
    });
  });

  it('saves nothing for a model that never used it, and keeps stages while switched off', () => {
    expect(configFromDraft(draftFromConfig(null))).toBeNull();
    const off = { ...draftFromConfig(null), stages: [stage(String(512 * K))] };
    expect(configFromDraft(off)?.enabled).toBe(false);
    expect(configFromDraft(off)?.stages).toHaveLength(1);
  });
});
