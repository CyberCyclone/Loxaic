/**
 * Choosing which llama.cpp the host runs (#270): the bundled version, any
 * official release, or a third-party build added by its download address.
 *
 * GitHub's release list and downloads are a mock (scripts/mock-llama-releases.ts)
 * whose archives each hold a `llama-server` that is a wrapper around the fake
 * router, saying which release it is. So a version chosen here is really
 * downloaded, verified against the digest the list published, unpacked and
 * started, and what the server then reports is that release — which is what
 * the assertions read, never only the label on screen.
 *
 * One of the releases refuses a setting Loxaic always writes, the way an older
 * llama.cpp or a fork really fails. It must stay failed, say why, and offer the
 * way back; nothing may fall back by itself.
 *
 * The server is shared with every other spec, so this one starts and ends on
 * the bundled build with nothing downloaded or added.
 */
import { $$, browser } from '@wdio/globals';
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { mockLlamaReleases } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, platform, scrollTo, tap, testIdSelector, typeInto, waitForAbsent, waitForFreshText, waitForVisible } from '../helpers/selectors.ts';
import { openSettings, signIn } from '../helpers/app.ts';
import { adminApi } from '../helpers/hostModels.ts';

interface RuntimeAnswer {
  runtime: {
    state: string;
    reason: string | null;
    tag: string;
    restart: unknown;
    version: { kind: string; tag: string | null; name: string | null; reported: string | null; bundledTag: string; canRevert: boolean };
    versionDownloads: { tag: string | null; customId: string | null; active: boolean; error: string | null }[];
  };
}

interface VersionsAnswer {
  selected: { kind: string };
  bundled: { tag: string };
  official: { downloadedTags: string[] };
  custom: { id: string; name: string; downloaded: boolean; sha256: string | null }[];
}

async function runtime(): Promise<RuntimeAnswer['runtime']> {
  const res = await adminApi('/v1/admin/local-models');
  if (!res.ok) throw new Error(`[e2e] the runtime could not be read (${String(res.status)})`);
  return ((await res.json()) as RuntimeAnswer).runtime;
}

async function versions(): Promise<VersionsAnswer> {
  const res = await adminApi('/v1/admin/local-models/runtime/versions');
  if (!res.ok) throw new Error(`[e2e] the versions could not be read (${String(res.status)}): ${await res.text()}`);
  return (await res.json()) as VersionsAnswer;
}

async function until(what: string, pred: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  await browser.waitUntil(pred, { timeout, interval: 500, timeoutMsg: `[e2e] timed out waiting for ${what}` });
}

const settled = async (): Promise<RuntimeAnswer['runtime']> => {
  await until('the runtime to settle', async () => {
    const r = await runtime();
    return r.restart === null && ['running', 'error'].includes(r.state);
  });
  return runtime();
};

/** Ask the mock releases to publish a release, slow page two down, or undo both. */
async function control(what: string): Promise<void> {
  const res = await fetch(`${mockLlamaReleases().controlUrl}/${what}`, { method: 'POST' });
  if (!res.ok) throw new Error(`[e2e] the mock releases refused ${what} (${String(res.status)})`);
}

/** Back on the bundled build, with nothing downloaded and nothing added. */
async function reset(): Promise<void> {
  await control('reset');
  if ((await versions()).selected.kind !== 'bundled') {
    const res = await adminApi('/v1/admin/local-models/runtime/revert', { method: 'POST' });
    if (!res.ok) throw new Error(`[e2e] could not switch back to the bundled build (${String(res.status)}): ${await res.text()}`);
  }
  await until('the bundled build to run', async () => {
    const r = await runtime();
    return r.state === 'running' && r.restart === null && r.version.kind === 'bundled';
  });
  await until('downloads to end', async () => (await runtime()).versionDownloads.every((d) => !d.active));
  const v = await versions();
  for (const b of v.custom) {
    const res = await adminApi(`/v1/admin/local-models/runtime/custom/${b.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`[e2e] could not remove the build ${b.name} (${String(res.status)}): ${await res.text()}`);
  }
  for (const tag of v.official.downloadedTags) {
    if (tag === v.bundled.tag) continue;
    const res = await adminApi(`/v1/admin/local-models/runtime/versions?tag=${tag}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`[e2e] could not remove ${tag} (${String(res.status)}): ${await res.text()}`);
  }
}

async function openHostModels(): Promise<void> {
  await openSettings();
  await scrollTo('settings.nav.localModels');
  await tap('settings.nav.localModels');
  await waitForVisible('localModels.runtime');
}

async function openPicker(): Promise<void> {
  await scrollTo('localModels.runtime.changeVersion');
  await tap('localModels.runtime.changeVersion');
  await waitForVisible('localModels.versions.close');
  await waitForVisible('localModels.versions.bundled.inUse', 20_000).catch(() => undefined);
}

async function closePicker(): Promise<void> {
  if (!(await isVisible('localModels.versions.close'))) return;
  await tap('localModels.versions.close');
  // An element inside a closed modal goes on reporting "displayed" under
  // UiAutomator2; absence is asked afresh each time, and on Android each ask
  // waits for the UI to go idle, so allow what the other closes here allow.
  await waitForAbsent('localModels.versions.close', 20_000);
}

const row = (tag: string): string => `localModels.versions.row.${tag}`;

describe('choosing the llama.cpp version', () => {
  const mock = mockLlamaReleases();
  const { tags } = mock;
  let bundledTag = '';

  before(async function () {
    this.timeout(3 * 60_000);
    await provisionAdmin();
    await reset();
    bundledTag = (await runtime()).version.bundledTag;
    await signIn(adminCreds());
    await openHostModels();
  });

  after(async function () {
    this.timeout(2 * 60_000);
    await reset();
  });

  afterEach(async () => {
    // UiAutomator2's default, in case a case that lifted it failed partway.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 }).catch(() => undefined);
    await closePicker().catch(() => undefined);
  });

  // First, so the picker is mounted fresh: an older build kept its pages
  // across a close.
  it('lists a release that moved pages once, and keeps an older page through a download starting', async function () {
    this.timeout(2 * 60_000);
    await openPicker();
    await scrollTo(row(tags.edge));
    // A release published while the picker is open moves the last one on page
    // one onto page two, so page two starts with a release already listed.
    await control('publish');
    await scrollTo('localModels.versions.loadMore');
    await tap('localModels.versions.loadMore');
    await scrollTo(`${row(tags.older)}.download`);
    // One row for it: two would share a testID.
    expect(await $$(testIdSelector(row(tags.edge))).length).toBe(1);

    // A download starting or ending asks for page one again. One request
    // counter for both threw away an older page that was on its way, so the
    // admin's "Load older versions" did nothing.
    await closePicker();
    await openPicker();
    await control('slow?ms=8000');
    // UiAutomator2 waits for the UI to go idle before each lookup, and the
    // "Load older versions" spinner never lets it: each one would outlast the
    // slow page (as in compaction-live.spec.ts).
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
    await scrollTo('localModels.versions.loadMore');
    await tap('localModels.versions.loadMore');
    // The newly published release has nothing to download, so this download
    // starts and fails at once: two changes, each asking for page one.
    await scrollTo(`${row(tags.published)}.download`);
    await tap(`${row(tags.published)}.download`);
    await scrollTo(row(tags.older), 40_000);
    await waitForVisible(`${row(tags.older)}.download`);
    await shot('llama-versions-older-page');
    await control('reset');
  });

  it('lists the official versions, with pre-releases and what cannot be installed here marked', async () => {
    await waitForFreshText('localModels.runtime.version', `llama.cpp ${bundledTag}`);
    await openPicker();
    await waitForVisible('localModels.versions.caveat');
    await waitForFreshText('localModels.versions.bundled.inUse', 'In use');

    await scrollTo(row(tags.prerelease));
    await waitForFreshText(`${row(tags.prerelease)}.prerelease`, 'Pre-release');
    expect(await isVisible(`${row(tags.good)}.prerelease`)).toBe(false);
    await waitForVisible(`${row(tags.good)}.download`);
    await scrollTo(`${row(tags.noBuild)}.unavailable`);
    await waitForFreshText(`${row(tags.noBuild)}.unavailable`, 'No build for this machine');
    await waitForFreshText(`${row(tags.noChecksum)}.unavailable`, 'No checksum published');
    // Neither can be downloaded: there is no button to press.
    expect(await isVisible(`${row(tags.noChecksum)}.download`)).toBe(false);
    await shot('llama-versions-list');

    // Older releases are a page away, and one can be found by its tag.
    await scrollTo('localModels.versions.loadMore');
    await tap('localModels.versions.loadMore');
    await scrollTo(row(tags.older));
    await waitForVisible(`${row(tags.older)}.download`);
    await scrollTo('localModels.versions.search');
    await typeInto('localModels.versions.search', tags.prerelease.slice(1));
    if (platform() === 'android') await browser.hideKeyboard().catch(() => undefined);
    await tap('localModels.versions.search.go');
    await waitForAbsent(row(tags.good));
    await waitForVisible(row(tags.prerelease));
    await tap('localModels.versions.search.clear');
    await scrollTo(row(tags.good));
  });

  it('downloads a version without touching what is running, then switches to it', async function () {
    this.timeout(3 * 60_000);
    await openPicker();
    await scrollTo(`${row(tags.good)}.download`);
    await tap(`${row(tags.good)}.download`);
    // The mock sends the archive in pieces over two seconds. Not asserted on
    // Android, where each lookup beside a spinner waits for the UI to idle.
    if (platform() !== 'android') await waitForFreshText(`${row(tags.good)}.progress`, 'Downloading', 5000);
    await waitForVisible(`${row(tags.good)}.switch`, 30_000);
    await waitForFreshText(`${row(tags.good)}.downloaded`, 'Downloaded');
    await shot('llama-versions-downloaded');
    // Nothing restarted: the bundled build is still what runs.
    expect(await runtime()).toMatchObject({ state: 'running', version: { kind: 'bundled' } });

    await tap(`${row(tags.good)}.switch`);
    await scrollTo('localModels.versions.confirm.ok');
    await waitForFreshText('localModels.versions.confirm.title', `Switch to llama.cpp ${tags.good}?`);
    await shot('llama-versions-switch-confirm');
    await tap('localModels.versions.confirm.ok');
    await waitForAbsent('localModels.versions.close', 20_000);

    const now = await settled();
    // The server's word, and the binary's own: the release that was chosen.
    expect(now).toMatchObject({ state: 'running', tag: tags.good, version: { kind: 'official', tag: tags.good, reported: tags.good } });
    await scrollTo('localModels.runtime.version');
    await waitForFreshText('localModels.runtime.version', `llama.cpp ${tags.good} (chosen)`);
    await waitForFreshText('localModels.runtime.headline', 'Running', 60_000);
    await waitForFreshText('localModels.runtime.bundledNewer', bundledTag);
    await shot('llama-version-chosen');

    await openPicker();
    await scrollTo(`${row(tags.good)}.inUse`);
    await waitForFreshText(`${row(tags.good)}.inUse`, 'In use');
    // What is in use cannot be removed from here.
    expect(await isVisible(`${row(tags.good)}.delete`)).toBe(false);
    await waitForVisible('localModels.versions.bundled.switch');
  });

  it('leaves a version that will not start failed, says why, and switches back in one press', async function () {
    this.timeout(4 * 60_000);
    await openPicker();
    await scrollTo(`${row(tags.broken)}.download`);
    await tap(`${row(tags.broken)}.download`);
    await waitForVisible(`${row(tags.broken)}.switch`, 30_000);
    await tap(`${row(tags.broken)}.switch`);
    await scrollTo('localModels.versions.confirm.ok');
    await tap('localModels.versions.confirm.ok');
    await waitForAbsent('localModels.versions.close', 20_000);

    const failed = await settled();
    expect(failed.state).toBe('error');
    expect(failed.reason).toMatch(/option 'jinja' not recognized in preset/);
    expect(failed.version).toMatchObject({ kind: 'official', tag: tags.broken, canRevert: true });
    await scrollTo('localModels.runtime.reason');
    await waitForFreshText('localModels.runtime.reason', 'not recognized in preset');
    await scrollTo('localModels.runtime.revert');
    // The label, not the button: a native lookup of a pressable has no text.
    await waitForFreshText('localModels.runtime.revert.label', `Switch back to the bundled version (${bundledTag})`);
    await shot('llama-version-failed-to-start');
    // Nothing fell back by itself, however long it is left.
    await browser.pause(4000);
    expect(await runtime()).toMatchObject({ state: 'error', version: { kind: 'official', tag: tags.broken } });

    await tap('localModels.runtime.revert');
    await until('the bundled build to run', async () => {
      const r = await runtime();
      return r.state === 'running' && r.restart === null && r.version.kind === 'bundled';
    });
    await waitForAbsent('localModels.runtime.revert', 30_000);
    await scrollTo('localModels.runtime.version');
    await waitForFreshText('localModels.runtime.version', `llama.cpp ${bundledTag}`);
    await waitForFreshText('localModels.runtime.headline', 'Running', 60_000);
    await shot('llama-version-reverted');
  });

  it('removes a downloaded version that is not in use', async () => {
    await openPicker();
    await scrollTo(`${row(tags.broken)}.delete`);
    await tap(`${row(tags.broken)}.delete`);
    await waitForVisible(`${row(tags.broken)}.download`, 20_000);
    expect((await versions()).official.downloadedTags).not.toContain(tags.broken);
    // The other one is still there to switch to.
    expect((await versions()).official.downloadedTags).toContain(tags.good);
  });

  it('refuses a third-party build whose hash is not the one given, and keeps the reason on its row', async function () {
    this.timeout(3 * 60_000);
    await openPicker();
    await scrollTo('localModels.versions.custom.name');
    await typeInto('localModels.versions.custom.name', 'E2E Wrong Hash');
    await scrollTo('localModels.versions.custom.url');
    await typeInto('localModels.versions.custom.url', mock.fork.url);
    await scrollTo('localModels.versions.custom.sha256');
    await typeInto('localModels.versions.custom.sha256', '0'.repeat(64));
    if (platform() === 'android') await browser.hideKeyboard().catch(() => undefined);
    await scrollTo('localModels.versions.custom.backend.vulkan');
    await tap('localModels.versions.custom.backend.vulkan');
    await scrollTo('localModels.versions.custom.add');
    await tap('localModels.versions.custom.add');

    await until('the build to be listed', async () => (await versions()).custom.some((b) => b.name === 'E2E Wrong Hash'));
    const bad = (await versions()).custom.find((b) => b.name === 'E2E Wrong Hash');
    if (!bad) throw new Error('[e2e] the build was not added');
    const base = `localModels.versions.custom.row.${bad.id}`;
    await scrollTo(`${base}.error`);
    await waitForFreshText(`${base}.error`, 'did not match its recorded checksum', 30_000);
    await shot('llama-versions-fork-refused');
    // Never unpacked, so there is nothing to switch to.
    expect(await isVisible(`${base}.switch`)).toBe(false);
    expect((await versions()).custom.find((b) => b.id === bad.id)).toMatchObject({ downloaded: false, sha256: null });
    await tap(`${base}.delete`);
    await waitForAbsent(`${base}.name`, 20_000);
  });

  it('adds a third-party build, shows what it hashed to, and runs it when chosen', async function () {
    this.timeout(4 * 60_000);
    await openPicker();
    await scrollTo('localModels.versions.custom.name');
    await typeInto('localModels.versions.custom.name', 'E2E Fork');
    await scrollTo('localModels.versions.custom.url');
    await typeInto('localModels.versions.custom.url', mock.fork.url);
    await scrollTo('localModels.versions.custom.sha256');
    await typeInto('localModels.versions.custom.sha256', mock.fork.sha256);
    if (platform() === 'android') await browser.hideKeyboard().catch(() => undefined);
    await scrollTo('localModels.versions.custom.backend.vulkan');
    await tap('localModels.versions.custom.backend.vulkan');
    await scrollTo('localModels.versions.custom.add');
    await tap('localModels.versions.custom.add');

    await until('the fork to download', async () => Boolean((await versions()).custom.find((b) => b.name === 'E2E Fork')?.downloaded), 60_000);
    const fork = (await versions()).custom.find((b) => b.name === 'E2E Fork');
    if (!fork) throw new Error('[e2e] the fork was not added');
    expect(fork.sha256).toBe(mock.fork.sha256);
    const base = `localModels.versions.custom.row.${fork.id}`;
    await scrollTo(`${base}.switch`);
    await waitForFreshText(`${base}.hash`, `SHA-256 ${mock.fork.sha256.slice(0, 8)}`);
    await waitForFreshText(`${base}.hash`, 'matches the one given');
    await waitForFreshText(`${base}.source`, 'from 127.0.0.1');
    await shot('llama-versions-fork-downloaded');

    await tap(`${base}.switch`);
    await scrollTo('localModels.versions.confirm.ok');
    await waitForFreshText('localModels.versions.confirm.title', 'Switch to E2E Fork?');
    await tap('localModels.versions.confirm.ok');
    await waitForAbsent('localModels.versions.close', 20_000);
    const now = await settled();
    expect(now).toMatchObject({ state: 'running', version: { kind: 'custom', name: 'E2E Fork', reported: mock.fork.version } });
    await scrollTo('localModels.runtime.version');
    await waitForFreshText('localModels.runtime.version', 'llama.cpp E2E Fork (third-party)');
    await waitForFreshText('localModels.runtime.headline', 'Running', 60_000);
    await shot('llama-version-fork-in-use');

    // And back, from the picker this time.
    await openPicker();
    await scrollTo('localModels.versions.bundled.switch');
    await tap('localModels.versions.bundled.switch');
    await scrollTo('localModels.versions.confirm.ok');
    await waitForFreshText('localModels.versions.confirm.title', 'Switch back to the bundled version?');
    await tap('localModels.versions.confirm.ok');
    await waitForAbsent('localModels.versions.close', 20_000);
    expect(await settled()).toMatchObject({ state: 'running', version: { kind: 'bundled', reported: null } });
    await scrollTo('localModels.runtime.version');
    await waitForFreshText('localModels.runtime.version', `llama.cpp ${bundledTag}`);
  });
});
