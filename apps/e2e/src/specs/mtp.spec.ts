/**
 * Multi-token prediction for host models: an admin turns it on per model, for
 * a model whose own file carries an MTP head (Qwen3.8-27B's layout) or with a
 * separate head downloaded from the repository's `MTP/` folder (Flash-Next's).
 *
 * What matters is asserted where it lands, not on the switch: the preset file
 * the router loads models from, the section the fake router actually loaded a
 * model with (its log), and the draft figures the fake router reports, which
 * the chat's usage line and the Stats screen read back. The fake router refuses
 * an unknown preset key and a draft file that is not there, as the real one
 * does (both confirmed against llama.cpp b11342).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { LLAMA_DIR, mockHf } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  byTestId,
  isVisible,
  scrollTo,
  tap,
  typeInto,
  waitForAbsent,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import { goToSurface, openSettings, openSidebar, sendAndAwaitReply, sendMessage, signIn, startNewThread } from '../helpers/app.ts';
import {
  adminApi,
  downloadMockModel,
  downloadTinyModel,
  loadsOf,
  patchModel,
  removeMockModels,
  routerName,
} from '../helpers/hostModels.ts';

interface AdminModel {
  id: string;
  status: string;
  enabled: boolean;
  loadSettings: Record<string, unknown>;
  mtpSource?: string | null;
  mtpHead?: { path: string; status: string; error: string | null } | null;
}

async function adminModel(id: string): Promise<AdminModel | undefined> {
  const res = await adminApi('/v1/admin/local-models');
  if (!res.ok) throw new Error(`[e2e] listing local models failed (${String(res.status)})`);
  return ((await res.json()) as { models: AdminModel[] }).models.find((m) => m.id === id);
}

/** The model's section of the preset file the router loads models from. */
function presetSection(id: string): string {
  const preset = readFileSync(path.join(LLAMA_DIR, 'models.ini'), 'utf8');
  const start = preset.indexOf(`[${routerName(id)}]`);
  if (start < 0) return '';
  const next = preset.indexOf('\n[', start + 1);
  return preset.slice(start, next < 0 ? undefined : next);
}

async function waitForSection(id: string, pred: (section: string) => boolean, what: string): Promise<void> {
  await browser.waitUntil(() => pred(presetSection(id)), { timeout: 20_000, interval: 300, timeoutMsg: `[e2e] the preset never ${what}` });
}

async function openHostModels(): Promise<void> {
  await openSettings();
  await scrollTo('settings.nav.localModels');
  await tap('settings.nav.localModels');
  await waitForVisible('localModels.runtime');
}

async function openModelSheet(id: string): Promise<void> {
  await scrollTo(`localModels.settings.${id}`);
  await tap(`localModels.settings.${id}`);
  await waitForVisible('localModels.settingsSheet');
  await waitForVisible('localModels.settingsSheet.fit');
}

/** Saved and closed. Waits on a field in the sheet's body: under UiAutomator2
 * the footer of a dismissed sheet went on reporting itself displayed. */
async function saveSheet(): Promise<void> {
  await scrollTo('localModels.settingsSheet.save');
  await tap('localModels.settingsSheet.save');
  await waitForAbsent('localModels.setting.displayName', 20_000);
}

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  // On a phone the list runs past the fold once a few models are installed.
  await scrollTo(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForAbsent('models.search', 10_000);
}

/** The index the settings sheet lists a head at: the server's own order. */
async function headIndex(repo: string, headPath: string): Promise<number> {
  const res = await adminApi(`/v1/admin/local-models/hf/details?repo=${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`[e2e] repo details failed (${String(res.status)})`);
  const heads = ((await res.json()) as { files: { mtpHeads?: { path: string }[] } }).files.mtpHeads ?? [];
  const i = heads.findIndex((h) => h.path === headPath);
  if (i < 0) throw new Error(`[e2e] ${headPath} is not among ${repo}'s heads`);
  return i;
}

describe('multi-token prediction', () => {
  const hf = mockHf();
  let plain = '';
  let embedded = '';
  let sidecar = '';
  let crashy = '';

  before(async function () {
    this.timeout(4 * 60_000);
    await provisionAdmin();
    await removeMockModels();
    plain = await downloadTinyModel();
    embedded = await downloadMockModel(hf.repos.mtpEmbedded, 'Q4_K_M');
    sidecar = await downloadMockModel(hf.repos.mtpSidecar, 'Q4_K_M');
    crashy = await downloadMockModel(hf.repos.mtpCrashy, 'Q4_K_M');
    for (const id of [plain, embedded, sidecar, crashy]) await patchModel(id, { enabled: true });
    await signIn(adminCreds());
    await openHostModels();
  });

  after(async () => {
    await removeMockModels();
  });

  it('offers no MTP setting for a model with no head anywhere', async () => {
    await openModelSheet(plain);
    // The repository is asked for heads as the sheet opens; give it the time.
    await browser.pause(1500);
    expect(await isVisible('localModels.setting.mtp.on')).toBe(false);
    expect(await isVisible('localModels.mtp.source')).toBe(false);
    await tap('localModels.settingsSheet.close');
    await waitForAbsent('localModels.setting.displayName', 20_000);
  });

  it("drafts with a model's own head: on, with a warning about concurrency, written to the preset and used", async function () {
    this.timeout(3 * 60_000);
    await openModelSheet(embedded);
    await scrollTo('localModels.mtp.source');
    await waitForTextIn('localModels.mtp.source', 'carries its own MTP head');
    await tap('localModels.setting.mtp.on');
    // llama.cpp serves four conversations at once unless told otherwise, and
    // MTP is a loss when several run together: said, never refused.
    await scrollTo('localModels.mtp.warning');
    await waitForTextIn('localModels.mtp.warning', 'up to four conversations');
    await shot('mtp-embedded-warning');
    await scrollTo('localModels.setting.mtpDraftMax.input');
    await typeInto('localModels.setting.mtpDraftMax.input', '2');
    await scrollTo('localModels.setting.parallel.input');
    await typeInto('localModels.setting.parallel.input', '1');
    await waitForAbsent('localModels.mtp.warning');
    await shot('mtp-embedded-on');
    await saveSheet();

    await waitForSection(embedded, (s) => s.includes('spec-type = draft-mtp'), 'turned MTP on');
    const section = presetSection(embedded);
    expect(section).toContain('spec-draft-n-max = 2');
    expect(section).toContain('parallel = 1');
    // The model's own head: no draft file.
    expect(section).not.toContain('spec-draft-model');
    await waitForTextIn(`localModels.mtpBadge.${embedded}`, 'MTP');

    // A reply on it reports what was drafted and accepted (the fake router's
    // 30 and 20), beside the answer.
    await goToSurface('chat');
    await startNewThread('chat');
    await pickModel(embedded);
    await sendAndAwaitReply('hello there', 'Hello from');
    await waitForTextIn('chat.usage.mtp', 'MTP 66% of 30 drafted');
    expect(loadsOf(embedded).at(-1)?.section?.['spec-type']).toBe('draft-mtp');
    await shot('mtp-chat-acceptance');

    // And Stats keeps it per model: 20 of 30, floored to a tenth.
    // Not goToSurface: its anchor (the composer) is one Chat renders too.
    await openSidebar();
    await tap('sidebar.nav.stats');
    await waitForTextIn('shell.header.title', 'Usage & Performance', 20_000);
    await scrollTo(`stats.model.mtp.${embedded}`);
    await waitForTextIn(`stats.model.mtp.${embedded}`, '66.6%');
    await shot('mtp-stats');

    // Off again: the lines go.
    await openHostModels();
    await openModelSheet(embedded);
    await scrollTo('localModels.setting.mtp.off');
    await tap('localModels.setting.mtp.off');
    await saveSheet();
    await waitForSection(embedded, (s) => s.length > 0 && !s.includes('spec-'), 'turned MTP off');
  });

  it("downloads a separate head from the sheet while the model stays usable, then drafts with it, and removes it", async function () {
    this.timeout(3 * 60_000);
    const good = await headIndex(hf.repos.mtpSidecar, hf.mtpHeads.good);
    const shared = await headIndex(hf.repos.mtpSidecar, hf.mtpHeads.shared);
    await openModelSheet(sidecar);
    await scrollTo(`localModels.mtp.head.${String(good)}.download`);
    // A shared head is listed, with why it cannot be used.
    expect(await byTestId(`localModels.mtp.head.${String(shared)}.download`).isEnabled()).toBe(false);
    await shot('mtp-sidecar-heads');
    await tap(`localModels.mtp.head.${String(good)}.download`);
    // "Downloading …" or, on a slow lane, already "Drafts with …": either names it.
    await waitForTextIn('localModels.mtp.head.status', 'mtp-Sidecar-Q8_0.gguf');
    // MTP can be switched on while the head comes, and saved; nothing is
    // written until the head is here.
    await tap('localModels.setting.mtp.on');
    await shot('mtp-sidecar-downloading');
    await saveSheet();
    expect(await adminModel(sidecar)).toMatchObject({ status: 'ready', enabled: true });
    // Nothing is written while the head is still coming. Read the preset
    // first and the head after: if the head is still not ready, the preset
    // was read before it could have been rewritten for it. (A slow lane can
    // finish the head before Save; then there is nothing to check here.)
    const before = presetSection(sidecar);
    if ((await adminModel(sidecar))?.mtpHead?.status !== 'ready') expect(before).not.toContain('spec-type');

    await browser.waitUntil(async () => (await adminModel(sidecar))?.mtpHead?.status === 'ready', {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: '[e2e] the head never finished',
    });
    await waitForSection(sidecar, (s) => s.includes('spec-type = draft-mtp') && s.includes('spec-draft-model'), 'took the head');
    expect(presetSection(sidecar)).toContain(hf.mtpHeads.good.split('/').at(-1) ?? '');

    await goToSurface('chat');
    await startNewThread('chat');
    await pickModel(sidecar);
    await sendAndAwaitReply('hello again', 'Hello from');
    await waitForTextIn('chat.usage.mtp', 'MTP 66%');
    // The fake router opened the draft file the preset named.
    expect(loadsOf(sidecar).at(-1)?.section?.['spec-draft-model']).toContain('mtp-Sidecar-Q8_0.gguf');

    await openHostModels();
    await openModelSheet(sidecar);
    await scrollTo('localModels.mtp.head.status');
    await waitForTextIn('localModels.mtp.head.status', 'Drafts with mtp-Sidecar-Q8_0.gguf');
    await shot('mtp-sidecar-ready');
    await tap('localModels.mtp.head.remove');
    await browser.waitUntil(async () => (await adminModel(sidecar))?.mtpHead === null, {
      timeout: 15_000,
      timeoutMsg: '[e2e] the head was never removed',
    });
    expect((await adminModel(sidecar))?.loadSettings.mtp).toBeUndefined();
    await waitForSection(sidecar, (s) => s.length > 0 && !s.includes('spec-'), 'dropped the removed head');
    await tap('localModels.settingsSheet.close');
    await waitForAbsent('localModels.setting.displayName', 20_000);
  });

  it('refuses a head made for another architecture, and says why', async function () {
    this.timeout(2 * 60_000);
    const other = await headIndex(hf.repos.mtpSidecar, hf.mtpHeads.otherArch);
    await openModelSheet(sidecar);
    await scrollTo(`localModels.mtp.head.${String(other)}.download`);
    await tap(`localModels.mtp.head.${String(other)}.download`);
    await browser.waitUntil(async () => (await adminModel(sidecar))?.mtpHead?.status === 'failed', {
      timeout: 30_000,
      timeoutMsg: '[e2e] the wrong head was never refused',
    });
    await scrollTo('localModels.mtp.head.status');
    await waitForTextIn('localModels.mtp.head.status', 'qwen35');
    await shot('mtp-head-refused');
    await tap('localModels.mtp.head.remove');
    await browser.waitUntil(async () => (await adminModel(sidecar))?.mtpHead === null, { timeout: 15_000 });
    await tap('localModels.settingsSheet.close');
    await waitForAbsent('localModels.setting.displayName', 20_000);
  });

  it("tells the person in the chat why a model with MTP on could not be loaded, and what to change", async function () {
    this.timeout(3 * 60_000);
    // Nothing refuses MTP ahead of time — a patched llama.cpp may run what the
    // bundled one cannot. The fake router crashes loading this model with MTP
    // on, as b11342 crashes loading Qwen3.8-Flash-Next with unsloth's head.
    await openModelSheet(crashy);
    await scrollTo('localModels.mtp.source');
    await waitForTextIn('localModels.mtp.source', 'carries its own MTP head');
    await tap('localModels.setting.mtp.on');
    await saveSheet();
    await waitForSection(crashy, (s) => s.includes('spec-type = draft-mtp'), 'turned MTP on');

    await goToSurface('chat');
    await startNewThread('chat');
    await pickModel(crashy);
    await sendMessage('hello, crashy');
    // The router itself says only "model name=… failed to load".
    await waitForTextIn('chat.message.error', 'GGML_ASSERT(buffer) failed', 60_000);
    await waitForTextIn('chat.message.error', 'turn multi-token prediction off');
    await shot('mtp-load-failure');

    // Turned off, the same model answers.
    await patchModel(crashy, { loadSettings: {} });
    await waitForSection(crashy, (s) => s.length > 0 && !s.includes('spec-'), 'turned MTP off');
    await sendAndAwaitReply('hello again, crashy', 'Hello from');
    await openHostModels();
  });

  it('downloads a head with the model from the download dialog, and lists the split quant beside the MTP folder', async function () {
    this.timeout(3 * 60_000);
    // The sidecar model goes, so the dialog downloads it again with a head.
    const del = await adminApi(`/v1/admin/local-models/model?id=${encodeURIComponent(sidecar)}`, { method: 'DELETE' });
    if (!del.ok) throw new Error(`[e2e] deleting ${sidecar} failed (${String(del.status)})`);
    await scrollTo('localModels.tab.discover');
    await tap('localModels.tab.discover');
    await typeInto('localModels.search', hf.repos.mtpSidecar.split('/')[1] ?? '');
    await waitForVisible(`localModels.result.${hf.repos.mtpSidecar}`);
    await tap(`localModels.result.${hf.repos.mtpSidecar}`);
    // `MTP/mtp-…-Q8_0.gguf` once joined the split Q8_0 as one quant and made
    // it vanish; both are here, each where it belongs.
    await scrollTo('localModels.quant.Q8_0');
    await scrollTo('localModels.details.mtp');
    await waitForTextIn('localModels.details.mtp', 'Include MTP head');
    await tap('localModels.details.mtp');
    await waitForTextIn('localModels.details.mtp', '✓');
    await shot('mtp-download-dialog');
    await scrollTo('localModels.download.Q4_K_M');
    await tap('localModels.download.Q4_K_M');
    await browser.waitUntil(
      async () => {
        const m = await adminModel(sidecar);
        return m?.status === 'ready' && m.mtpHead?.status === 'ready';
      },
      { timeout: 90_000, interval: 500, timeoutMsg: '[e2e] the model and its head never both finished' },
    );
    await scrollTo('localModels.tab.installed');
    await tap('localModels.tab.installed');
    await scrollTo(`localModels.row.${sidecar}`);
    await shot('mtp-downloaded-with-head');
  });
});
