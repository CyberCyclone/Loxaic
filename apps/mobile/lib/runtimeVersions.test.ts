import { describe, expect, it } from 'vitest';
import type {
  CustomRuntimeBuild,
  LocalRuntimeVersion,
  LocalRuntimeView,
  RuntimeReleaseRow,
  RuntimeVersionDownload,
  RuntimeVersionsView,
} from '@loxaic/api-client';
import { pollIntervalMs } from './localModels';
import {
  bundledNewerNote,
  canDeleteRelease,
  changeVersionControl,
  customAction,
  customBuildProblem,
  offersRevert,
  prereleaseLabelling,
  releaseAction,
  releaseRows,
  shortHash,
  staleNote,
  switchWarning,
  versionLabel,
} from './runtimeVersions';

const version = (over: Partial<LocalRuntimeVersion> = {}): LocalRuntimeVersion => ({
  kind: 'bundled',
  tag: 'b11342',
  name: null,
  reported: null,
  bundledTag: 'b11342',
  bundledNewer: false,
  canRevert: false,
  envPinned: false,
  customAllowed: true,
  ...over,
});

const row = (over: Partial<RuntimeReleaseRow> = {}): RuntimeReleaseRow => ({
  tag: 'b9001',
  publishedAt: '2026-10-01T00:00:00Z',
  prerelease: false,
  availability: 'ok',
  sizeBytes: 100,
  bundled: false,
  downloaded: false,
  inUse: false,
  ...over,
});

const dl = (over: Partial<RuntimeVersionDownload> = {}): RuntimeVersionDownload => ({
  key: 'b9001-vulkan',
  kind: 'official',
  tag: 'b9001',
  customId: null,
  doneBytes: 0,
  totalBytes: 0,
  active: true,
  error: null,
  ...over,
});

const build = (over: Partial<CustomRuntimeBuild> = {}): CustomRuntimeBuild => ({
  id: 'aaaaaaaaaaaa',
  name: 'Fork',
  host: 'example.com',
  backend: 'vulkan',
  sha256: null,
  sha256Expected: null,
  addedAt: '2026-10-01T00:00:00Z',
  downloaded: false,
  inUse: false,
  ...over,
});

const view = (over: Partial<RuntimeVersionsView> = {}): RuntimeVersionsView => ({
  selected: { kind: 'bundled' },
  envPinned: false,
  flavour: 'vulkan',
  bundled: { tag: 'b11342', downloaded: true, inUse: true },
  official: { releases: [], hasMore: false, stale: null, unavailable: null, downloadedTags: [] },
  customAllowed: true,
  custom: [],
  ...over,
});

describe('what the card says about the version', () => {
  it('names the tag alone for the bundled build, and says when another was chosen', () => {
    expect(versionLabel({ tag: 'b11342', version: version() })).toBe('b11342');
    expect(versionLabel({ tag: 'b9001', version: version({ kind: 'official', tag: 'b9001' }) })).toBe('b9001 (chosen)');
    expect(versionLabel({ tag: 'Fork', version: version({ kind: 'custom', tag: null, name: 'Fork' }) })).toBe('Fork (third-party)');
    expect(versionLabel({ tag: 'b11342', version: version({ kind: 'external', tag: null }) })).toBe("the container's own build");
  });

  it('falls back to the tag from a server that predates choosing one', () => {
    expect(versionLabel({ tag: 'b11149' })).toBe('b11149');
  });

  it('says so when the bundled version has moved past the chosen one, and only then', () => {
    expect(bundledNewerNote({ version: version() })).toBeNull();
    expect(bundledNewerNote({})).toBeNull();
    expect(bundledNewerNote({ version: version({ kind: 'official', tag: 'b9001', bundledNewer: true }) })).toMatch(/now b11342/);
  });
});

describe('whether "Change version" is offered', () => {
  const settings = { envOverrides: { mode: false, backend: false, modelsMax: false, hfToken: false, runtime: false } };

  it('is, on a server that runs llama.cpp itself', () => {
    expect(changeVersionControl({ mode: 'managed', version: version() }, settings)).toEqual({ show: true, disabled: false, note: null });
  });

  it('is not, from a server that predates it', () => {
    expect(changeVersionControl({ mode: 'managed' }, settings)).toMatchObject({ show: false, note: null });
  });

  it('is replaced by the reason where the version is the container image', () => {
    const c = changeVersionControl({ mode: 'attach', version: version({ kind: 'external', tag: null }) }, settings);
    expect(c.show).toBe(false);
    expect(c.note).toMatch(/container's image/);
  });

  it('is shown read-only, with the reason, when the operator pinned it', () => {
    const c = changeVersionControl({ mode: 'managed', version: version({ envPinned: true }) }, settings);
    expect(c).toMatchObject({ show: true, disabled: true });
    expect(c.note).toMatch(/LLAMA_RUNTIME_TAG/);
  });

  it('is not, with local models off', () => {
    expect(changeVersionControl({ mode: 'off', version: version() }, settings).show).toBe(false);
  });
});

describe('whether the card offers switching back', () => {
  const rt = (over: Partial<Pick<LocalRuntimeView, 'state' | 'version' | 'restart'>>) => ({ state: 'error' as const, version: version({ kind: 'official', tag: 'b9001', canRevert: true }), restart: null, ...over });

  it('does when a chosen build is in error', () => {
    expect(offersRevert(rt({}))).toBe(true);
  });

  it('does not while it is running, restarting, bundled, pinned, or on an older server', () => {
    expect(offersRevert(rt({ state: 'running' }))).toBe(false);
    expect(offersRevert(rt({ restart: { phase: 'starting', cause: 'requested', startedAt: '' } }))).toBe(false);
    expect(offersRevert(rt({ version: version() }))).toBe(false);
    expect(offersRevert(rt({ version: version({ kind: 'official', canRevert: false, envPinned: true }) }))).toBe(false);
    expect(offersRevert({ state: 'error' })).toBe(false);
  });
});

describe('what a release row offers', () => {
  it('download, for one this machine can install', () => {
    expect(releaseAction(row(), [])).toEqual({ kind: 'download', retry: false });
    expect(releaseAction(row(), undefined)).toEqual({ kind: 'download', retry: false });
  });

  it('switch, once it is downloaded — never before', () => {
    expect(releaseAction(row({ downloaded: true }), [])).toEqual({ kind: 'switch' });
  });

  it('nothing but "in use" for the one running', () => {
    expect(releaseAction(row({ downloaded: true, inUse: true }), [dl()])).toEqual({ kind: 'in-use' });
  });

  it('progress while it downloads, with a percentage only when the size is known', () => {
    expect(releaseAction(row(), [dl({ doneBytes: 999, totalBytes: 1000 })])).toEqual({ kind: 'downloading', percent: 99 });
    expect(releaseAction(row(), [dl()])).toEqual({ kind: 'downloading', percent: null });
    // Another release's download is not this one's.
    expect(releaseAction(row({ tag: 'b9002' }), [dl()])).toEqual({ kind: 'download', retry: false });
  });

  it('"try again" after a failed download', () => {
    expect(releaseAction(row(), [dl({ active: false, error: 'stalled' })])).toEqual({ kind: 'download', retry: true });
  });

  it('the reason, for one that cannot be installed here', () => {
    expect(releaseAction(row({ availability: 'no-build' }), [])).toEqual({ kind: 'unavailable', reason: 'No build for this machine' });
    expect(releaseAction(row({ availability: 'no-checksum' }), [])).toEqual({ kind: 'unavailable', reason: 'No checksum published' });
  });

  it('may be removed when downloaded, unless it is in use or the bundled release', () => {
    expect(canDeleteRelease(row({ downloaded: true }))).toBe(true);
    expect(canDeleteRelease(row())).toBe(false);
    expect(canDeleteRelease(row({ downloaded: true, inUse: true }))).toBe(false);
    expect(canDeleteRelease(row({ downloaded: true, bundled: true }))).toBe(false);
  });
});

describe('what a third-party build row offers', () => {
  const custom = (over: Partial<RuntimeVersionDownload>) => dl({ key: 'custom-aaaaaaaaaaaa', kind: 'custom', tag: null, customId: 'aaaaaaaaaaaa', ...over });

  it('follows its download, then offers the switch', () => {
    expect(customAction(build(), [custom({ doneBytes: 1, totalBytes: 4 })])).toEqual({ kind: 'downloading', percent: 25 });
    expect(customAction(build({ downloaded: true }), [])).toEqual({ kind: 'switch' });
    expect(customAction(build({ downloaded: true, inUse: true }), [])).toEqual({ kind: 'in-use' });
  });

  it('offers another try when it is not on this machine', () => {
    expect(customAction(build(), [custom({ active: false, error: 'did not match' })])).toEqual({ kind: 'download', retry: true });
    expect(customAction(build(), [])).toEqual({ kind: 'download', retry: true });
  });
});

describe('the release list', () => {
  it('shows a downloaded release that is not on the loaded page, first', () => {
    const v = view({ official: { releases: [], hasMore: true, stale: null, unavailable: null, downloadedTags: ['b8000', 'b9001'] } });
    const rows = releaseRows(v, [row({ tag: 'b9002' }), row({ tag: 'b9001' })], false);
    expect(rows.map((r) => [r.tag, r.downloaded])).toEqual([['b8000', true], ['b9002', false], ['b9001', true]]);
  });

  it('takes "downloaded" and "in use" from the newest answer, whatever page a row came on', () => {
    const v = view({
      selected: { kind: 'official', tag: 'b9001' },
      official: { releases: [], hasMore: false, stale: null, unavailable: null, downloadedTags: ['b9001'] },
    });
    const rows = releaseRows(v, [row({ tag: 'b9001', downloaded: false, inUse: false }), row({ tag: 'b9002', downloaded: true, inUse: true })], false);
    expect(rows).toMatchObject([{ tag: 'b9001', downloaded: true, inUse: true }, { tag: 'b9002', downloaded: false, inUse: false }]);
  });

  it('leaves the bundled release to its own row', () => {
    const v = view({ official: { releases: [], hasMore: false, stale: null, unavailable: null, downloadedTags: ['b11342'] } });
    expect(releaseRows(v, [row({ tag: 'b11342', bundled: true }), row()], false).map((r) => r.tag)).toEqual(['b9001']);
  });

  it('shows only what was found when searching', () => {
    const v = view({ official: { releases: [], hasMore: false, stale: null, unavailable: null, downloadedTags: ['b8000'] } });
    expect(releaseRows(v, [row()], true).map((r) => r.tag)).toEqual(['b9001']);
    expect(releaseRows(v, [], true)).toEqual([]);
  });

  it('labels pre-releases per row only when that tells some rows from others', () => {
    expect(prereleaseLabelling([row(), row()])).toEqual({ perRow: false, note: null });
    expect(prereleaseLabelling([row({ prerelease: true }), row()])).toEqual({ perRow: true, note: null });
    // llama.cpp flags every build: said once, not on every row.
    const all = prereleaseLabelling([row({ prerelease: true }), row({ prerelease: true })]);
    expect(all.perRow).toBe(false);
    expect(all.note).toMatch(/every one of these builds marked as a pre-release/);
    // One row found by its tag is labelled as itself.
    expect(prereleaseLabelling([row({ prerelease: true })])).toEqual({ perRow: true, note: null });
    expect(prereleaseLabelling([])).toEqual({ perRow: false, note: null });
  });

  it('says a list GitHub would not refresh may be out of date', () => {
    expect(staleNote(null)).toBeNull();
    expect(staleNote({ since: '2026-10-01T00:00:00Z', retryAt: null })).toMatch(/may be out of date\.$/);
    expect(staleNote({ since: '2026-10-01T00:00:00Z', retryAt: '2026-10-01T01:00:00Z' })).toMatch(/Try again after/);
    expect(staleNote({ since: 'x', retryAt: 'not a date' })).toMatch(/may be out of date\.$/);
  });
});

describe('what a switch says before it is done', () => {
  it('always says the runtime restarts and models are unloaded', () => {
    for (const t of [{ kind: 'bundled' as const }, { kind: 'official' as const, tag: 'b9001' }, { kind: 'custom' as const, name: 'Fork' }]) {
      expect(switchWarning(t).message).toMatch(/restarts and every loaded model is unloaded/);
    }
  });

  it('says an official release is untested, and a third-party build is not vouched for', () => {
    expect(switchWarning({ kind: 'official', tag: 'b9001' })).toMatchObject({ title: 'Switch to llama.cpp b9001?' });
    expect(switchWarning({ kind: 'official', tag: 'b9001' }).message).toMatch(/has not been tested with Loxaic/);
    expect(switchWarning({ kind: 'custom', name: 'Fork' }).message).toMatch(/third-party build/);
    expect(switchWarning({ kind: 'bundled' }).message).not.toMatch(/tested/);
  });
});

describe('a third-party build form', () => {
  const ok = { name: 'Fork', url: 'https://example.com/llama.tar.gz', sha256: '' };

  it('accepts a name and an https link, with or without a hash', () => {
    expect(customBuildProblem(ok)).toBeNull();
    expect(customBuildProblem({ ...ok, sha256: `sha256:${'A'.repeat(64)}` })).toBeNull();
  });

  it('says what is wrong otherwise', () => {
    expect(customBuildProblem({ ...ok, name: '  ' })).toMatch(/name/);
    expect(customBuildProblem({ ...ok, name: 'x'.repeat(61) })).toMatch(/60/);
    expect(customBuildProblem({ ...ok, url: 'ftp://example.com/llama.tar.gz' })).toMatch(/https/);
    expect(customBuildProblem({ ...ok, url: 'example.com' })).toMatch(/https/);
    expect(customBuildProblem({ ...ok, sha256: 'abc' })).toMatch(/SHA-256/);
  });

  it('shortens a hash to something a person can compare', () => {
    expect(shortHash('a'.repeat(8) + 'b'.repeat(52) + 'c'.repeat(4))).toBe('aaaaaaaa…cccc');
    expect(shortHash(null)).toBeNull();
  });
});

describe('polling', () => {
  it('is fast while a version downloads, and not for a download that failed', () => {
    const runtime = (versionDownloads: RuntimeVersionDownload[]) =>
      ({ state: 'running', restart: null, versionDownloads }) as unknown as LocalRuntimeView;
    const base = { settings: {} as never, models: [], freeDiskBytes: null, settingSpecs: [] };
    expect(pollIntervalMs({ ...base, runtime: runtime([dl()]) })).toBe(1000);
    expect(pollIntervalMs({ ...base, runtime: runtime([dl({ active: false, error: 'x' })]) })).toBe(15_000);
    expect(pollIntervalMs({ ...base, runtime: runtime([]) })).toBe(15_000);
  });
});
