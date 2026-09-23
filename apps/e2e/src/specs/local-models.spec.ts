/**
 * Local models: the llama.cpp runtime this server runs, HuggingFace search and
 * downloads, per-model settings, and enabling a model for everyone.
 *
 * Nothing here needs a GPU or a real llama.cpp. The server under test runs a
 * fake router (apps/server/test-fixtures/fake-llama-server.mjs) on fake
 * hardware with one 24 GB GPU, and HuggingFace is `scripts/mock-hf.ts`, whose
 * quants are sized so all three fit labels appear. What is real is everything
 * between: the admin routes, the download queue (Range, checksums, pause), the
 * preset file the router is given, and the server-side gate that makes an
 * enabled model usable.
 *
 * Downloaded models are rows in the shared database, so `after` deletes this
 * run's rows through the API, and the mock's repo names carry a per-run suffix.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { adminCreds, apiToken, provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  isVisible,
  tap,
  testIdSelector,
  typeInto,
  waitForGone,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import { openSettings, openSidebar, signIn, signOut, signUp } from '../helpers/app.ts';
import { BASE_URL, LLAMA_DIR, mockHf } from '../../scripts/standup.ts';

interface ApiModel {
  id: string;
  status: string;
  enabled: boolean;
  bytesDone: number;
  sizeBytes: number;
}

async function adminApi(pathname: string, init: RequestInit = {}): Promise<Response> {
  const token = await apiToken(adminCreds());
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
}

async function apiModels(): Promise<ApiModel[]> {
  const res = await adminApi('/v1/admin/local-models');
  if (!res.ok) throw new Error(`[e2e] listing local models failed (${String(res.status)})`);
  return ((await res.json()) as { models: ApiModel[] }).models;
}

async function waitForStatus(id: string, status: string, timeout = 60_000): Promise<ApiModel> {
  let found: ApiModel | undefined;
  await browser.waitUntil(
    async () => {
      found = (await apiModels()).find((m) => m.id === id);
      return found?.status === status;
    },
    { timeout, interval: 300, timeoutMsg: `expected ${id} to reach ${status}; it is ${String(found?.status)}` },
  );
  if (!found) throw new Error(`[e2e] ${id} disappeared`);
  return found;
}

/** Whether an element's nearest scrolling ancestor can bring it into view —
 * the same assertion checkin-settings.spec.ts makes. Visibility alone passes
 * for a row below the fold. */
async function reachable(id: string): Promise<boolean> {
  return browser.execute((selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return false;
    let node = el.parentElement;
    while (node) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        node.scrollTop = node.scrollHeight;
        const box = el.getBoundingClientRect();
        const frame = node.getBoundingClientRect();
        return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
      }
      node = node.parentElement;
    }
    // Nothing scrolls, so the whole body must already fit.
    const box = el.getBoundingClientRect();
    return box.bottom <= window.innerHeight;
  }, testIdSelector(id));
}

/**
 * Wait for text in an element, looking the element up afresh each time.
 *
 * `waitForTextIn` holds one element reference, and a download finishing
 * replaces the row's in-progress status line with the finished row's pill —
 * a different node under the same testID — so a reference taken before that
 * never becomes displayed.
 */
async function waitForFreshText(id: string, text: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const el = $(testIdSelector(id));
      return (await el.isExisting()) && (await el.getText()).includes(text);
    },
    { timeout, interval: 300, timeoutMsg: `expected "${text}" in [${id}] within ${String(timeout)}ms` },
  );
}

async function openLocalModels(): Promise<void> {
  await openSettings();
  await tap('settings.nav.localModels');
  await waitForVisible('localModels.runtime');
}

describe('local models', () => {
  const hf = mockHf();
  const tiny = hf.repos.tiny;
  const downloadId = `${tiny}:${hf.quants.download}`;
  const cancelId = `${tiny}:${hf.quants.cancel}`;
  const user = uniqueCreds();

  before(async () => {
    await provisionAdmin();
  });

  after(async () => {
    for (const m of await apiModels().catch(() => [] as ApiModel[])) {
      if (!m.id.startsWith(tiny)) continue;
      if (m.status === 'ready' || m.status === 'failed') {
        await adminApi(`/v1/admin/local-models/model?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' });
      } else {
        await adminApi('/v1/admin/local-models/cancel', { method: 'POST', body: JSON.stringify({ id: m.id }) });
      }
    }
    // Leave the runtime on its default backend for whatever runs next.
    await adminApi('/v1/admin/local-models/settings', { method: 'PATCH', body: JSON.stringify({ backend: 'auto' }) });
  });

  it('an admin opens Local Models and sees the runtime running on the GPU', async () => {
    await signIn(adminCreds());
    await openLocalModels();
    await waitForTextIn('localModels.runtime.headline', 'Running on E2E Fake GPU');
    await shot('local-models-runtime');
  });

  it('searches HuggingFace by name and by publisher, with a fit label and stats on each result', async () => {
    await tap('localModels.tab.discover');
    await typeInto('localModels.search', `tiny-${tiny.split('-')[2] ?? ''}`);
    await waitForVisible(`localModels.result.${tiny}`);
    await waitForTextIn(`localModels.result.fit.${tiny}`, 'Will fit');
    await waitForTextIn(`localModels.result.${tiny}`, 'e2e-org');

    // publisher/name in the one box.
    await typeInto('localModels.search', 'e2e-org/huge');
    await waitForVisible(`localModels.result.${hf.repos.huge}`);
    await waitForTextIn(`localModels.result.fit.${hf.repos.huge}`, "Won't fit");
    // The mock also lists a text-to-image repo from this publisher; the
    // server drops it, since it is not a model the router can chat with.
    expect(await isVisible(`localModels.result.${hf.repos.huge.replace('Huge', 'Image')}`)).toBe(false);

    // And the publisher filter on its own.
    await typeInto('localModels.search', '');
    await typeInto('localModels.search.publisher', 'pixel-lab');
    await waitForVisible(`localModels.result.${hf.repos.vision}`);
    await shot('local-models-search-by-publisher');
    await typeInto('localModels.search.publisher', '');
  });

  it("shows a model's description, stats, and every quant labelled will / might / won't fit", async () => {
    await typeInto('localModels.search', 'tiny');
    await tap(`localModels.result.${tiny}`);
    await waitForVisible('localModels.details');
    await waitForTextIn('localModels.details.publisher', 'e2e-org');
    await waitForTextIn('localModels.details.card', 'A small model for the end-to-end suite');
    await waitForTextIn('localModels.details.stats', '12.3k');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.download}`, 'Will fit');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.mightFit}`, 'Might fit');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.wontFit}`, "Won't fit");
    await shot('local-models-details-fit-labels');

    // Won't fit asks first, inline; cancelling downloads nothing.
    await tap(`localModels.download.${hf.quants.wontFit}`);
    await waitForVisible('localModels.wontFit');
    await shot('local-models-wont-fit-warning');
    await tap('localModels.wontFit.cancel');
    await waitForGone('localModels.wontFit', 5000);
    expect((await apiModels()).some((m) => m.id === `${tiny}:${hf.quants.wontFit}`)).toBe(false);
  });

  it('downloads a model with progress, pauses and resumes it, and cancels another', async () => {
    await tap(`localModels.download.${hf.quants.download}`);
    await waitForVisible(`localModels.row.${downloadId}`);
    await waitForTextIn(`localModels.status.${downloadId}`, 'Downloading');
    await shot('local-models-downloading');

    await tap(`localModels.pause.${downloadId}`);
    const paused = await waitForStatus(downloadId, 'paused');
    expect(paused.bytesDone).toBeLessThan(paused.sizeBytes);
    await waitForTextIn(`localModels.status.${downloadId}`, 'Paused');
    await shot('local-models-paused');
    await tap(`localModels.resume.${downloadId}`);

    // A second download, cancelled part-way: its row and bytes go.
    await tap('localModels.tab.discover');
    await tap(`localModels.result.${tiny}`);
    await waitForVisible(`localModels.download.${hf.quants.cancel}`);
    await tap(`localModels.download.${hf.quants.cancel}`);
    await waitForVisible(`localModels.row.${cancelId}`);
    await tap(`localModels.cancel.${cancelId}`);
    await waitForVisible('localModels.cancelConfirm.dialog');
    await tap('localModels.cancelConfirm.confirm');
    await waitForGone(`localModels.row.${cancelId}`, 15_000);

    await waitForStatus(downloadId, 'ready', 90_000);
    await waitForFreshText(`localModels.status.${downloadId}`, 'Not offered to users');
  });

  it('per-model settings: a live fit estimate, validation, and the router loads it with them', async () => {
    await tap(`localModels.settings.${downloadId}`);
    await waitForVisible('localModels.settingsSheet');
    await waitForVisible('localModels.settingsSheet.fit');
    // The GGUF header was read at download: 22 layers, 32k trained context.
    await typeInto('localModels.setting.ctxSize.input', '99999');
    await waitForTextIn('localModels.setting.ctxSize.error', 'at most 32768');
    await typeInto('localModels.setting.ctxSize.input', '8192');
    await tap('localModels.setting.gpuLayers.number');
    await typeInto('localModels.setting.gpuLayers.input', '20');
    await waitForTextIn('localModels.settingsSheet', 'of 23 layers on the GPU');
    await tap('localModels.setting.flashAttention.on');
    // The lowest row is reachable, not merely present.
    // No vision projector was downloaded, so the vision switch is not offered.
    expect(await isVisible('localModels.setting.vision.default')).toBe(false);
    // The sheet's last row is reachable by scrolling, not merely present.
    expect(await reachable('localModels.setting.seed.input')).toBe(true);
    await shot('local-models-settings');
    await tap('localModels.settingsSheet.save');
    await waitForGone('localModels.settingsSheet', 10_000);

    await tap(`localModels.toggle.${downloadId}`);
    await waitForFreshText(`localModels.status.${downloadId}`, 'In everyone');
    await browser.waitUntil(
      () => {
        const preset = readFileSync(path.join(LLAMA_DIR, 'models.ini'), 'utf8');
        return preset.includes(`[${downloadId}]`) && preset.includes('ctx-size = 8192');
      },
      { timeout: 10_000, timeoutMsg: 'the preset never carried the saved settings' },
    );
    const preset = readFileSync(path.join(LLAMA_DIR, 'models.ini'), 'utf8');
    expect(preset).toContain('n-gpu-layers = 20');
    expect(preset).toContain('flash-attn = on');
    await shot('local-models-enabled');
  });

  it('CPU is offered only behind a warning that names the GPU it would leave unused', async () => {
    await tap('localModels.tab.installed');
    await tap('localModels.runtime.advanced');
    await tap('localModels.runtime.backend.cpu');
    await waitForVisible('localModels.cpuConfirm.dialog');
    await waitForTextIn('localModels.cpuConfirm.dialog', 'Leave E2E Fake GPU unused?');
    await shot('local-models-cpu-warning');
    await tap('localModels.cpuConfirm.confirm');
    await waitForVisible('localModels.runtime.cpuWarning', 30_000);
    await waitForTextIn('localModels.runtime.headline', 'Running on the CPU', 30_000);
    await shot('local-models-running-on-cpu');
    await tap('localModels.runtime.backend.auto');
    await waitForTextIn('localModels.runtime.headline', 'Running on E2E Fake GPU', 30_000);
  });

  it('an ordinary user cannot open Local Models, but sees the enabled model in their picker', async () => {
    await signOut();
    await signUp(user);
    await openSidebar();
    await tap('sidebar.settings');
    expect(await isVisible('settings.nav.localModels')).toBe(false);
    await browser.keys('Escape');
    const token = await apiToken(user);
    const denied = await fetch(`${BASE_URL}/v1/admin/local-models`, { headers: { authorization: `Bearer ${token}` } });
    expect(denied.status).toBe(403);

    await tap('composer.model');
    await waitForVisible('models.dialog');
    await waitForVisible(`models.row.${downloadId}`);
    await shot('local-models-in-user-picker');
    await browser.keys('Escape');
  });

  it('an admin deletes the model, and it leaves the picker', async () => {
    await signOut();
    await signIn(adminCreds());
    await openLocalModels();
    await tap(`localModels.delete.${downloadId}`);
    await waitForVisible('localModels.deleteConfirm.dialog');
    await waitForTextIn('localModels.deleteConfirm.dialog', 'This frees');
    await tap('localModels.deleteConfirm.confirm');
    await waitForGone(`localModels.row.${downloadId}`, 15_000);
    const token = await apiToken(user);
    const models = (await (await fetch(`${BASE_URL}/v1/models`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      id: string;
    }[];
    expect(models.some((m) => m.id === downloadId)).toBe(false);
  });
});
