import { describe, expect, it } from 'vitest';
import type { ImageChoice, SandboxImage } from '@loxaic/api-client';
import { chooserImages, effectiveImageChoice, imageOptions, imageScreens, imageStatusLine, kvmWarning, parseLimitsInput } from './customImages';

const choice = (id: string, extra: Partial<ImageChoice> = {}): ImageChoice => ({
  id, scope: 'shared', label: id, reference: `docker.io/library/${id}:1`, hasGit: true, ...extra,
});

const image = (extra: Partial<SandboxImage>): SandboxImage => ({
  id: 'i', scope: 'personal', reference: 'r', label: 'l', status: 'ready', error: null, usable: true,
  digest: 'd', check: null, limits: null, pulledAt: null, progress: null, ...extra,
});

describe('imageScreens', () => {
  it('offers the shared screen to admins only, and the personal one to everyone, when the policy allows', () => {
    expect(imageScreens('off', true)).toEqual({ shared: false, personal: false });
    expect(imageScreens('shared', true)).toEqual({ shared: true, personal: false });
    expect(imageScreens('shared', false)).toEqual({ shared: false, personal: false });
    expect(imageScreens('everyone', false)).toEqual({ shared: false, personal: true });
    expect(imageScreens('everyone', true)).toEqual({ shared: true, personal: true });
    expect(imageScreens(undefined, true)).toEqual({ shared: false, personal: false });
  });
});

describe('imageOptions', () => {
  it("lists Loxaic's own first, marks the person's own, and rules out git-less images for GitHub", () => {
    const options = imageOptions([choice('a'), choice('b', { scope: 'personal', hasGit: false })], 'github');
    expect(options.map((o) => o.id)).toEqual([null, 'a', 'b']);
    expect(options[2].detail).toContain('yours');
    expect(options[2].disabledReason).toMatch(/No git/);
    expect(imageOptions([choice('b', { hasGit: false })], 'scratch')[1].disabledReason).toBeNull();
  });

  it("falls back to Loxaic's own when the choice can no longer be used here", () => {
    const github = imageOptions([choice('b', { hasGit: false })], 'github');
    expect(effectiveImageChoice('b', github)).toBeNull();
    expect(effectiveImageChoice('gone', github)).toBeNull();
    expect(effectiveImageChoice('b', imageOptions([choice('b', { hasGit: false })], 'scratch'))).toBe('b');
  });
});

describe('imageStatusLine', () => {
  it('says how far a pull has got, and never claims 100% before it is done', () => {
    expect(imageStatusLine(image({ status: 'pulling' }))).toBe('Pulling…');
    expect(imageStatusLine(image({ status: 'pulling', progress: { current: 50, total: 100 } }))).toBe('Pulling… 50%');
    expect(imageStatusLine(image({ status: 'pulling', progress: { current: 100, total: 100 } }))).toBe('Pulling… 99%');
  });

  it('keeps a failed update apart from an image that never worked', () => {
    expect(imageStatusLine(image({ status: 'failed', usable: true, error: 'x' }))).toMatch(/previous pull is still used/);
    expect(imageStatusLine(image({ status: 'failed', usable: false, error: 'nope' }))).toBe('nope');
  });
});

describe('parseLimitsInput', () => {
  it("holds the server's bounds", () => {
    expect(parseLimitsInput({ memoryMb: '2048', cpus: '1.5', pids: '400' })).toEqual({ ok: true, limits: { memoryMb: 2048, cpus: 1.5, pids: 400 } });
    expect(parseLimitsInput({ memoryMb: '100', cpus: '1', pids: '100' }).ok).toBe(false);
    expect(parseLimitsInput({ memoryMb: '512', cpus: '0.1', pids: '100' }).ok).toBe(false);
    expect(parseLimitsInput({ memoryMb: '512', cpus: '1', pids: '1.5' }).ok).toBe(false);
  });
});

describe('chooserImages', () => {
  const current = { id: 'mine', label: 'Mine' };

  it('holds Confirm while the list loads, keeping the image already chosen', () => {
    const state = chooserImages({ choices: null, failed: false, current, chosen: 'mine', source: 'scratch' });
    expect(state.ready).toBe(false);
    expect(state.chosenId).toBe('mine');
  });

  it("keeps the image already chosen when the list can't be loaded, rather than swapping it out", () => {
    const state = chooserImages({ choices: null, failed: true, current, chosen: 'mine', source: 'scratch' });
    expect(state.ready).toBe(true);
    expect(state.chosenId).toBe('mine');
    expect(state.options.map((o) => o.id)).toEqual([null, 'mine']);
  });

  it("offers Loxaic's own alone when nothing was chosen and the list failed", () => {
    const state = chooserImages({ choices: null, failed: true, current: null, chosen: null, source: 'scratch' });
    expect(state).toMatchObject({ ready: true, chosenId: null });
    expect(state.options.map((o) => o.id)).toEqual([null]);
  });

  it('decides from the loaded list once it arrives', () => {
    const loaded = chooserImages({ choices: [choice('b', { hasGit: false })], failed: false, current, chosen: 'b', source: 'github' });
    expect(loaded).toMatchObject({ ready: true, chosenId: null });
  });
});

describe('kvmWarning (#320)', () => {
  it('warns only when the server says it cannot see /dev/kvm', () => {
    expect(kvmWarning(false)).toContain("can't see /dev/kvm");
    expect(kvmWarning(true)).toBeNull();
    expect(kvmWarning(null)).toBeNull();
  });
});
