/**
 * The Host models list as an admin uses it day to day: which models are in
 * memory, loading and unloading them, saving a loaded model's settings
 * (which reloads it with them), restarting llama.cpp, and where a loaded
 * model's memory actually is — VRAM, RAM, or the model file on the SSD.
 *
 * Against the fake router, which prints llama.cpp's real allocation lines
 * (b11342's format) for the devices and settings each model loads with. One
 * 24 GB fake GPU on which each model holds 23.5 GB, and every load takes four
 * seconds (standup.ts), so only one model is loaded at a time and a load or a
 * restart can be watched. The mock's "Tabled" model carries a 2 MiB per-layer
 * lookup table — Qwen3.8-Flash-Next's 27.5 GB one in miniature — and the fake
 * splits its graph 17 ways while its GPU layers are automatic, the way
 * llama.cpp's --fit did to Flash-Next on Pheonix.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { LLAMA_DIR, mockHf } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, platform, scrollTo, tap, waitForAbsent, waitForFreshText, waitForVisible } from '../helpers/selectors.ts';
import { openSettings, signIn } from '../helpers/app.ts';
import { adminApi, downloadMockModel, downloadTinyModel, patchModel, removeMockModels, routerEvents, routerName } from '../helpers/hostModels.ts';

/** The model's section of the preset file the router loads models from. */
function presetSection(id: string): string {
  const preset = readFileSync(path.join(LLAMA_DIR, 'models.ini'), 'utf8');
  const start = preset.indexOf(`[${routerName(id)}]`);
  if (start < 0) return '';
  const next = preset.indexOf('\n[', start + 1);
  return preset.slice(start, next < 0 ? undefined : next);
}

async function openHostModels(): Promise<void> {
  await openSettings();
  await scrollTo('settings.nav.localModels');
  await tap('settings.nav.localModels');
  await waitForVisible('localModels.runtime');
}

/** The display name the list shows for the mock's table model. */
async function tabledName(): Promise<string> {
  const res = await adminApi('/v1/admin/local-models');
  const models = ((await res.json()) as { models: { id: string; displayName: string }[] }).models;
  const m = models.find((x) => x.id.startsWith(mockHf().repos.table));
  if (!m) throw new Error('[e2e] the table model is not listed');
  return m.displayName;
}

async function stateIs(id: string, text: string, timeout = 30_000): Promise<void> {
  await scrollTo(`localModels.state.${id}`);
  await waitForFreshText(`localModels.state.${id}`, text, timeout);
}

describe('host models: loaded, loading, and where the memory is', () => {
  const hf = mockHf();
  let tiny = '';
  let tabled = '';

  before(async function () {
    this.timeout(4 * 60_000);
    await provisionAdmin();
    await removeMockModels();
    tiny = await downloadTinyModel();
    tabled = await downloadMockModel(hf.repos.table, 'Q4_K_M');
    for (const id of [tiny, tabled]) await patchModel(id, { enabled: true });
    await signIn(adminCreds());
    await openHostModels();
  });

  after(async () => {
    await removeMockModels();
  });

  it('says which models are loaded, and loads and unloads one on request', async () => {
    await stateIs(tiny, 'Not loaded');
    await tap(`localModels.load.${tiny}`);
    // Said at once, not a poll later: the load takes four seconds. No scroll
    // first — the row is on screen, and a native lookup is slow enough that
    // one more would read the badge after the load had finished. Not on
    // Android: UiAutomator waits for the UI to go idle before every query, so
    // its first read lands after the four seconds; the badge is the same
    // component everywhere and is held on the other three.
    if (platform() !== 'android') await waitForFreshText(`localModels.state.${tiny}`, 'Loading', 3500);
    await shot('host-models-loading');
    await stateIs(tiny, 'Loaded');
    expect(routerEvents().some((e) => e.event === 'load' && e.model === routerName(tiny))).toBe(true);

    await scrollTo(`localModels.unload.${tiny}`);
    await tap(`localModels.unload.${tiny}`);
    await stateIs(tiny, 'Not loaded');
    expect(routerEvents().at(-1)).toMatchObject({ event: 'unload', model: routerName(tiny) });
  });

  it('shows where a loaded model is — the lookup table read from the SSD — and warns about the split graph', async () => {
    await scrollTo(`localModels.load.${tabled}`);
    await tap(`localModels.load.${tabled}`);
    await stateIs(tabled, 'Loaded');
    // The summary, not the bar's container: XCUITest exposes no plain view's testID.
    await scrollTo(`localModels.placement.${tabled}.summary`);
    await waitForFreshText(`localModels.placement.${tabled}.summary`, 'read from SSD');
    await waitForFreshText(`localModels.placement.${tabled}.summary`, 'in VRAM');
    await waitForFreshText(`localModels.placement.${tabled}.warning.0`, '17 pieces');
    await shot('host-models-placement-ssd-split');
  });

  it('moves the table into RAM and the layers onto the GPU, and saving reloads the model with them', async () => {
    const loadsBefore = routerEvents().filter((e) => e.event === 'load' && e.model === routerName(tabled)).length;
    await scrollTo(`localModels.settings.${tabled}`);
    await tap(`localModels.settings.${tabled}`);
    await waitForVisible('localModels.settingsSheet');
    await waitForFreshText('localModels.settingsSheet.placement.part.table', 'on SSD');
    await shot('host-models-sheet-placement');
    // VRAM is shown, and says why it is not a choice.
    await scrollTo('localModels.setting.tablePlacement.vramReason');
    expect(await isVisible('localModels.setting.tablePlacement.vram')).toBe(true);
    await waitForFreshText('localModels.setting.tablePlacement.vramReason', 'stops loading');
    expect(await isVisible('localModels.setting.tablePlacement.warning')).toBe(false);
    await tap('localModels.setting.tablePlacement.ram');
    // Below the fold on a phone, where UiAutomator does not see it until it is
    // scrolled to.
    await scrollTo('localModels.setting.tablePlacement.warning');
    await waitForFreshText('localModels.setting.tablePlacement.warning', 'copied into RAM');
    await shot('host-models-table-ram-setting');
    await scrollTo('localModels.setting.gpuLayers.all');
    await tap('localModels.setting.gpuLayers.all');
    await scrollTo('localModels.settingsSheet.save');
    await tap('localModels.settingsSheet.save');
    await waitForAbsent('localModels.setting.displayName', 20_000);

    // Reloaded by the save, with nobody asking it anything.
    await browser.waitUntil(() => routerEvents().filter((e) => e.event === 'load' && e.model === routerName(tabled)).length > loadsBefore, {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: '[e2e] saving never reloaded the model',
    });
    const section = presetSection(tabled);
    expect(section).toContain('lazy-mode = off');
    expect(section).toContain('load-mode = none');
    await stateIs(tabled, 'Loaded');
    await scrollTo(`localModels.placement.${tabled}.summary`);
    await waitForFreshText(`localModels.placement.${tabled}.summary`, 'in RAM');
    expect(await isVisible(`localModels.placement.${tabled}.warning.0`)).toBe(false);
    await shot('host-models-placement-ram');
  });

  it('will not unload a model that is kept loaded, and says why', async () => {
    await scrollTo(`localModels.pin.${tabled}`);
    await tap(`localModels.pin.${tabled}`);
    await waitForVisible(`localModels.pinned.${tabled}`);
    await scrollTo(`localModels.unloadBlocked.${tabled}`);
    await waitForFreshText(`localModels.unloadBlocked.${tabled}`, 'Keep loaded');
    await tap(`localModels.unload.${tabled}`);
    await browser.pause(1000);
    await stateIs(tabled, 'Loaded');
  });

  it('says it is restarting until the kept-loaded model is back', async () => {
    await scrollTo('localModels.runtime.restart');
    await tap('localModels.runtime.restart');
    await waitForVisible('localModels.runtime.restarting', 3000);
    await waitForFreshText('localModels.runtime.headline', 'Restarting llama.cpp');
    // Only the server can say this: the kept-loaded model loading again, after
    // llama.cpp itself is back (each load takes the fake four seconds).
    await waitForFreshText('localModels.runtime.headline', `loading ${(await tabledName())}`, 20_000);
    await shot('host-models-restarting');
    await waitForAbsent('localModels.runtime.restarting', 60_000);
    await waitForFreshText('localModels.runtime.headline', 'Running');
    await stateIs(tabled, 'Loaded');
    await patchModel(tabled, { pinned: false });
  });
});
