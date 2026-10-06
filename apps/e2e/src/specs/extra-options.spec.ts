/**
 * Extra llama.cpp options: `key = value` rows an admin adds, per model on its
 * settings sheet and for every model on the runtime card, for whatever
 * llama.cpp offers that the settings do not.
 *
 * One key llama.cpp does not know stops the router from starting at all, so
 * each key is checked against the running build's own `--help`. The fake
 * router prints one in llama.cpp's layout, lists `keep`, `metrics` and
 * `cont-batching` beyond the keys Loxaic writes, and refuses to start on any
 * key it does not list, as the real one does. Assertions read the preset file
 * and the fake's load log — what llama.cpp is given — never only the screen.
 *
 * The mock releases' older build has no `keep` option: switching to it is how
 * a stored option meets a version that does not know it.
 *
 * The server is shared with every other spec, so this one starts and ends
 * with no extra options, on the bundled build.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { LLAMA_DIR, mockLlamaReleases } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, platform, scrollTo, tap, typeInto, waitForAbsent, waitForFreshText, waitForVisible } from '../helpers/selectors.ts';
import { openSettings, signIn } from '../helpers/app.ts';
import { adminApi, downloadTinyModel, loadsOf, patchModel, removeMockModels, routerName } from '../helpers/hostModels.ts';

interface Runtime {
  state: string;
  restart: unknown;
  version: { kind: string; tag: string | null };
  versionDownloads: { tag: string | null; active: boolean }[];
  extraOptions?: { key: string; value: string }[];
}

async function runtime(): Promise<Runtime> {
  const res = await adminApi('/v1/admin/local-models');
  if (!res.ok) throw new Error(`[e2e] the runtime could not be read (${String(res.status)})`);
  return ((await res.json()) as { runtime: Runtime }).runtime;
}

async function until(what: string, pred: () => Promise<boolean> | boolean, timeout = 60_000): Promise<void> {
  await browser.waitUntil(pred, { timeout, interval: 500, timeoutMsg: `[e2e] timed out waiting for ${what}` });
}

const running = (kind = 'bundled') =>
  until(`the ${kind} build to run`, async () => {
    const r = await runtime();
    return r.state === 'running' && r.restart === null && r.version.kind === kind;
  });

/** One section of the preset the router reads (`*` for every model's). */
function section(name: string): string[] {
  const lines = readFileSync(path.join(LLAMA_DIR, 'models.ini'), 'utf8').split('\n');
  const start = lines.indexOf(`[${name}]`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('['));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
}

async function settings(body: Record<string, unknown>): Promise<void> {
  const res = await adminApi('/v1/admin/local-models/settings', { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`[e2e] the settings were refused (${String(res.status)}): ${await res.text()}`);
}

async function loadAndWait(id: string, before: number): Promise<void> {
  const res = await adminApi('/v1/admin/local-models/model/load', { method: 'POST', body: JSON.stringify({ id }) });
  if (res.status !== 202) throw new Error(`[e2e] the load was refused (${String(res.status)}): ${await res.text()}`);
  await until('the model to load', () => loadsOf(id).length > before, 30_000);
}

/** No extra options anywhere, on the bundled build with nothing else on disk. */
async function reset(model: string | null): Promise<void> {
  if ((await runtime()).version.kind !== 'bundled') {
    const res = await adminApi('/v1/admin/local-models/runtime/revert', { method: 'POST' });
    if (!res.ok) throw new Error(`[e2e] could not switch back to the bundled build (${String(res.status)})`);
  }
  await running();
  if ((await runtime()).extraOptions?.length) {
    await settings({ extraOptions: [] });
    await running();
  }
  if (model) await patchModel(model, { extraOptions: null });
  const older = mockLlamaReleases().tags.older;
  await adminApi(`/v1/admin/local-models/runtime/versions?tag=${older}`, { method: 'DELETE' });
}

async function openHostModels(): Promise<void> {
  await openSettings();
  await scrollTo('settings.nav.localModels');
  await tap('settings.nav.localModels');
  await waitForVisible('localModels.runtime');
}

/** Type a row of the model sheet's or the runtime card's editor. */
async function typeRow(scope: 'model' | 'router', i: number, key: string, value: string): Promise<void> {
  const row = `localModels.extraOptions.${scope}.${String(i)}`;
  await scrollTo(`${row}.key`);
  await typeInto(`${row}.key`, key);
  await typeInto(`${row}.value`, value);
  // As a person would before reaching Save, which the keyboard covers on a
  // phone: Return ends editing a single-line field and puts it away.
  // WebDriverAgent's hideKeyboard does not close this one.
  if (platform() === 'ios') await byTestId(`${row}.value`).addValue('\n');
  if (platform() === 'android') await browser.hideKeyboard();
}

/** A row's error or hint, scrolled to first: on a phone it sits below the
 * sheet's fold, under the row just typed. */
async function rowSays(id: string, text: string): Promise<void> {
  await scrollTo(id);
  await waitForFreshText(id, text);
}

describe('extra llama.cpp options', () => {
  let tiny = '';

  before(async function () {
    this.timeout(4 * 60_000);
    await provisionAdmin();
    await removeMockModels();
    tiny = await downloadTinyModel();
    await patchModel(tiny, { enabled: true });
    await reset(tiny);
    await signIn(adminCreds());
    await openHostModels();
  });

  after(async function () {
    this.timeout(2 * 60_000);
    await reset(tiny);
    await removeMockModels();
  });

  it("refuses at the row what llama.cpp can't be given, and loads the model with what it can", async () => {
    await scrollTo(`localModels.settings.${tiny}`);
    await tap(`localModels.settings.${tiny}`);
    await waitForVisible('localModels.settingsSheet');
    await scrollTo('localModels.extraOptions.model.add');
    await tap('localModels.extraOptions.model.add');

    // Loxaic's own wiring, a setting the sheet already has, and a key this
    // build does not list: each refused at the row, with why, and Save held.
    await typeRow('model', 0, 'port', '9000');
    await rowSays('localModels.extraOptions.model.0.error', 'Loxaic runs the llama.cpp router with this itself');
    await shot('extra-options-refused');
    expect(await byTestId('localModels.settingsSheet.save').isEnabled()).toBe(false);
    await typeRow('model', 0, 'ctx-size', '8192');
    await rowSays('localModels.extraOptions.model.0.error', 'Context length');
    await typeRow('model', 0, 'mlock', 'true');
    await rowSays('localModels.extraOptions.model.0.error', 'no option "mlock"');

    // One it lists, with dashes as someone pastes it from --help.
    await typeRow('model', 0, '--keep', '64');
    await rowSays('localModels.extraOptions.model.0.hint', 'number of tokens to keep');
    await shot('extra-options-model');
    await tap('localModels.settingsSheet.save');
    await waitForAbsent('localModels.settingsSheet.save', 20_000);

    await until('the preset to carry the option', () => section(routerName(tiny)).includes('keep = 64'), 10_000);
    await loadAndWait(tiny, loadsOf(tiny).length);
    expect(loadsOf(tiny).at(-1)?.section).toMatchObject({ keep: '64' });
  });

  it('passes options to every model from the runtime card, and a model\'s own win', async () => {
    await scrollTo('localModels.runtime.advanced');
    await tap('localModels.runtime.advanced');
    await scrollTo('localModels.extraOptions.router.add');
    await tap('localModels.extraOptions.router.add');
    await typeRow('router', 0, 'keep', '8');
    await scrollTo('localModels.extraOptions.router.add');
    await tap('localModels.extraOptions.router.add');
    await typeRow('router', 1, 'metrics', 'yes');
    await rowSays('localModels.extraOptions.router.1.error', 'true or false');
    await typeRow('router', 1, 'metrics', 'true');
    await waitForAbsent('localModels.extraOptions.router.1.error');
    await shot('extra-options-router');
    await scrollTo('localModels.extraOptions.router.save');
    await tap('localModels.extraOptions.router.save');

    // Saving restarts the runtime, which writes them into [*].
    await until('the options to be saved', async () => (await runtime()).extraOptions?.length === 2);
    await running();
    expect(section('*')).toEqual(expect.arrayContaining(['keep = 8', 'metrics = true']));
    await loadAndWait(tiny, loadsOf(tiny).length);
    // The model's own `keep = 64` beats the `keep = 8` every model gets.
    expect(loadsOf(tiny).at(-1)?.section).toMatchObject({ keep: '64', metrics: 'true' });
  });

  it("keeps an option the version switched to doesn't know, without passing it, and still starts", async function () {
    this.timeout(3 * 60_000);
    const { older } = mockLlamaReleases().tags;
    const download = await adminApi('/v1/admin/local-models/runtime/versions/download', { method: 'POST', body: JSON.stringify({ tag: older }) });
    expect(download.ok).toBe(true);
    await until('the older build to download', async () => (await runtime()).versionDownloads.every((d) => !d.active));
    const select = await adminApi('/v1/admin/local-models/runtime/select', { method: 'POST', body: JSON.stringify({ kind: 'official', tag: older }) });
    expect(select.ok).toBe(true);
    await running('official');

    // Without the check this preset would name `keep`, and the build would
    // not start (the fake refuses it, as llama.cpp does).
    expect(section('*')).toContain('metrics = true');
    expect(section('*').some((l) => l.startsWith('keep'))).toBe(false);
    await scrollTo('localModels.extraOptions.router.skipped');
    await waitForFreshText('localModels.extraOptions.router.skipped', '"keep"');
    // Kept as it is, not an error: refusing it would block saving anything
    // else beside it.
    expect(await isVisible('localModels.extraOptions.router.0.error')).toBe(false);
    await shot('extra-options-skipped');

    const revert = await adminApi('/v1/admin/local-models/runtime/revert', { method: 'POST' });
    expect(revert.ok).toBe(true);
    await running();
    // Back on a build that has it, it is passed again.
    expect(section('*')).toContain('keep = 8');
  });

  it("fails a model's load with llama.cpp's own words when it can't read a value", async () => {
    await patchModel(tiny, { extraOptions: [{ key: 'keep', value: 'banana' }] });
    const res = await adminApi('/v1/admin/local-models/model/load', { method: 'POST', body: JSON.stringify({ id: tiny }) });
    expect(res.status).toBe(202);
    await scrollTo(`localModels.loadError.${tiny}`, 30_000);
    await waitForFreshText(`localModels.loadError.${tiny}`, 'error while handling argument "--keep"', 30_000);
    await shot('extra-options-bad-value');
  });
});
