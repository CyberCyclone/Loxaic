/**
 * Host models: the llama.cpp runtime this server runs, HuggingFace search and
 * downloads, per-model settings, and enabling a model for everyone.
 *
 * Nothing here needs a GPU or a real llama.cpp. The server under test runs a
 * fake router (apps/server/test-fixtures/fake-llama-server.mjs) on fake
 * hardware with one 24 GB GPU, and HuggingFace is `scripts/mock-hf.ts`, whose
 * quants are sized so all three fit labels appear. Each model the fake router
 * loads holds almost all of its GPU, so a second model never fits beside the
 * first: that is what the pinning cases stand on. What is real is everything
 * between: the admin routes, the download queue (Range, checksums, pause), the
 * preset file the router is given, and the server-side gate that makes an
 * enabled model usable.
 *
 * Downloaded models are rows in the shared database, so `after` deletes this
 * run's rows through the API, and the mock's repo names carry a per-run suffix.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browser } from '@wdio/globals';
import { adminCreds, apiToken, provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { attachDocument, TEXT_FIXTURE } from '../helpers/attachments.ts';
import {
  byTestId,
  expectTextAbsent,
  isVisible,
  platform,
  tap,
  testIdSelector,
  typeInto,
  waitForGone,
  waitForTextIn,
  waitForVisible,
  waitForFreshText,
} from '../helpers/selectors.ts';
import {
  goToSurface,
  openSettings,
  openSidebar,
  sendAndAwaitReply,
  sendMessage,
  signIn,
  signOut,
  signUp,
  startNewThread,
} from '../helpers/app.ts';
import { BASE_URL, FAKE_HARDWARE_FILE, FAKE_ROUTER_LOG, LLAMA_DIR, mockHf } from '../../scripts/standup.ts';

interface ApiModel {
  id: string;
  displayName: string;
  status: string;
  enabled: boolean;
  pinned?: boolean;
  runtimeStatus: string | null;
  bytesDone: number;
  sizeBytes: number;
}

/**
 * One admin token for the whole spec. Signing in per call ran into
 * better-auth's sign-in rate limit after a failing run's own sign-ins, and the
 * cleanup's refused sign-in left an *enabled* model row in the shared database.
 */
let adminToken: string | null = null;

async function adminApi(pathname: string, init: RequestInit = {}): Promise<Response> {
  adminToken ??= await apiToken(adminCreds());
  return fetch(`${BASE_URL}${pathname}`, {
    ...init,
    // A content type with no body is refused (FST_ERR_CTP_EMPTY_JSON_BODY):
    // the cleanup's DELETE failed that way the first time a ready model was
    // still there for it to remove.
    headers: { authorization: `Bearer ${adminToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
}

/**
 * Remove every model a run of this spec downloaded — this run's, and any an
 * earlier run failed to clean up (the mock's repos are all under `e2e-org/`
 * and `pixel-lab/`). Throws rather than logging: a row left behind is an
 * enabled model in the shared database whose files are gone.
 */
async function removeSpecModels(): Promise<void> {
  const res = await adminApi('/v1/admin/local-models');
  if (!res.ok) throw new Error(`[e2e] listing local models for cleanup failed (${String(res.status)})`);
  const { models } = (await res.json()) as { models: ApiModel[] };
  for (const m of models) {
    if (!m.id.startsWith('e2e-org/') && !m.id.startsWith('pixel-lab/')) continue;
    const r =
      m.status === 'ready' || m.status === 'failed'
        ? await adminApi(`/v1/admin/local-models/model?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' })
        : await adminApi('/v1/admin/local-models/cancel', { method: 'POST', body: JSON.stringify({ id: m.id }) });
    if (!r.ok) throw new Error(`[e2e] could not remove ${m.id} (${String(r.status)}): ${await r.text()}`);
  }
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

async function waitForRuntimeStatus(id: string, runtimeStatus: string, timeout = 30_000): Promise<void> {
  let found: ApiModel | undefined;
  await browser.waitUntil(
    async () => {
      found = (await apiModels()).find((m) => m.id === id);
      return found?.runtimeStatus === runtimeStatus;
    },
    { timeout, interval: 300, timeoutMsg: `expected ${id} to be ${runtimeStatus}; it is ${String(found?.runtimeStatus)}` },
  );
}

/** The fake router's load and unload events, oldest first. */
function routerEvents(): { event: string; model: string }[] {
  if (!existsSync(FAKE_ROUTER_LOG)) return [];
  return readFileSync(FAKE_ROUTER_LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; model: string });
}

/** The message box's current text — where an unsent message is put back. */
async function composerText(): Promise<string> {
  return browser.execute((selector: string) => {
    const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
    return el?.value ?? '';
  }, testIdSelector('composer.input'));
}

/** Whether the open thread shows `text` as a message. */
async function threadShows(text: string): Promise<boolean> {
  return browser.execute(
    (selector: string, needle: string) => (document.querySelector(selector)?.textContent ?? '').includes(needle),
    testIdSelector('chat.messageList'),
    text,
  );
}

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForGone('models.dialog', 10_000);
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
  /** What the router knows it by — the id with "@" for ":" (routerModelName in
   * apps/server/src/llama/preset.ts). The router rewrites a "UD-" quant after
   * a ":", so the preset, the router's load log and its replies all use this. */
  const routerName = downloadId.replace(':', '@');
  const cancelId = `${tiny}:${hf.quants.cancel}`;
  /** A second model, downloaded after the first is loaded: the one there is
   * no room for beside it. The same quant the cancel case uses. */
  const secondId = cancelId;
  const secondRouterName = secondId.replace(':', '@');
  const user = uniqueCreds();

  before(async () => {
    await provisionAdmin();
    await removeSpecModels();
  });

  after(async () => {
    await removeSpecModels();
    // Leave the runtime on its default backend, on fake hardware with a GPU,
    // for whatever runs next.
    writeFileSync(FAKE_HARDWARE_FILE, 'gpu', 'utf8');
    await adminApi('/v1/admin/local-models/settings', { method: 'PATCH', body: JSON.stringify({ backend: 'auto' }) });
  });

  it('an admin opens Host Models and sees the runtime running on the GPU', async () => {
    await signIn(adminCreds());
    await openLocalModels();
    await waitForTextIn('localModels.runtime.headline', 'Running on E2E Fake GPU');
    await shot('local-models-runtime');

    // Each GPU is a switch, and says what is free as well as its size — the
    // size alone read as "60 GB" on a box where another program held one card.
    await tap('localModels.runtime.advanced');
    await waitForTextIn('localModels.runtime.device.FAKE0.memory', '23.4 GB free of 24.0 GB');
    const isSwitch = await browser.execute((selector: string) => {
      const el = document.querySelector(selector);
      return Boolean(el && (el.getAttribute('role') === 'switch' || el.querySelector('[role="switch"], input[type="checkbox"]')));
    }, testIdSelector('localModels.runtime.device.FAKE0'));
    expect(isSwitch).toBe(true);
    await shot('local-models-gpu-switches');
    await tap('localModels.runtime.advanced');
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
    // The card's HTML is drawn, not shown as tags: its words and its links
    // are there, and none of its markup is.
    await waitForTextIn('localModels.details.card', 'See our collection for every version of Tiny.');
    if (platform() === 'web' || platform() === 'electron') {
      const card = await byTestId('localModels.details.card').getText();
      expect(card).not.toMatch(/<\/?(div|p|strong|a|img)\b/);
      // The words take their block's size and colour. On the web the text
      // inside a markdown block used to fall back to react-native-web's own
      // defaults (black, 14px): the heading came out the size of body text.
      const styles = await browser.execute((selector: string) => {
        const root = document.querySelector(selector);
        const measure = (words: string) => {
          const leaf = root
            ? [...root.querySelectorAll('*')].find((e) =>
                [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().startsWith(words)),
              )
            : undefined;
          const block = leaf?.closest('span.font-sans');
          if (!leaf || !block) return null;
          const l = getComputedStyle(leaf);
          const b = getComputedStyle(block);
          return { size: l.fontSize, color: l.color, blockSize: b.fontSize, blockColor: b.color };
        };
        return { heading: measure('Tiny Test Model'), body: measure('model for the end-to-end suite') };
      }, testIdSelector('localModels.details.card'));
      expect(styles.heading).not.toBeNull();
      expect(styles.body).not.toBeNull();
      for (const s of [styles.heading, styles.body]) {
        expect(s?.size).toBe(s?.blockSize);
        expect(s?.color).toBe(s?.blockColor);
      }
      expect(Number.parseFloat(styles.heading?.size ?? '0')).toBeGreaterThan(Number.parseFloat(styles.body?.size ?? '0'));
      const links = await browser.execute((selector: string) => {
        const el = document.querySelector(selector);
        return el ? [...el.querySelectorAll('[role="link"]')].map((l) => l.textContent) : [];
      }, testIdSelector('localModels.details.card'));
      // A badge is a link labelled by where it goes; its image is not fetched.
      expect(links).toEqual(expect.arrayContaining(['our collection', 'discord.gg/e2e-org']));
      await browser.execute((selector: string) => {
        document.querySelector(selector)?.scrollIntoView({ block: 'start' });
      }, testIdSelector('localModels.details.card'));
      await shot('local-models-details-card');
    } else {
      // Native has no concatenated text to search (see waitForTextIn), so
      // look for a leaf still showing a tag.
      await expectTextAbsent('<strong>');
      await expectTextAbsent('<div');
    }
    await waitForTextIn('localModels.details.stats', '12.3k');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.download}`, 'Will fit');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.mightFit}`, 'Might fit');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.wontFit}`, "Won't fit");
    // Every quant can be brought into view, not merely rendered below a fold.
    expect(await reachable(`localModels.quant.${hf.quants.wontFit}`)).toBe(true);
    // And the list has room to be read. Reachable alone passed while the
    // sheet stayed pinned at the size of its loading spinner (an 84px strip
    // to scroll the whole list in): the content arrives a second after the
    // sheet opens, as it does from real HuggingFace.
    const listHeight = await browser.execute((selector: string) => {
      const sheet = document.querySelector(selector);
      const body = sheet ? [...sheet.children].find((c) => getComputedStyle(c).overflowY === 'auto') : undefined;
      return body?.clientHeight ?? 0;
    }, testIdSelector('localModels.details'));
    expect(listHeight).toBeGreaterThan(300);
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
    // The trained context is advice, not a limit (RoPE scaling exists to exceed
    // it): a value past it is a warning, and Save stays possible.
    await typeInto('localModels.setting.ctxSize.input', '99999');
    await waitForTextIn('localModels.setting.ctxSize.warning', '32,768');
    expect(await isVisible('localModels.setting.ctxSize.error')).toBe(false);
    expect(await byTestId('localModels.settingsSheet.save').isEnabled()).toBe(true);
    // What is still a limit: llama.cpp's own 32-bit ceiling.
    await typeInto('localModels.setting.ctxSize.input', '99999999999');
    await waitForTextIn('localModels.setting.ctxSize.error', 'at most 2147483647');
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
        return preset.includes(`[${routerName}]`) && preset.includes('ctx-size = 8192');
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

  it('with no GPU at all, offers the CPU only behind its own warning — and never picks it on its own', async () => {
    writeFileSync(FAKE_HARDWARE_FILE, 'none', 'utf8');
    // Restart re-detects the hardware; automatic finds nothing and stops there.
    await tap('localModels.runtime.restart');
    await waitForTextIn('localModels.runtime.headline', 'No supported GPU found', 30_000);
    await waitForTextIn('localModels.runtime.reason', 'No GPU was found');
    await waitForVisible('localModels.runtime.useCpu');
    await shot('local-models-no-gpu');

    await tap('localModels.runtime.useCpu');
    await waitForVisible('localModels.cpuConfirm.dialog');
    await waitForTextIn('localModels.cpuConfirm.dialog', 'Run models on the CPU?');
    await waitForTextIn('localModels.cpuConfirm.dialog', 'small models');
    await shot('local-models-no-gpu-cpu-warning');
    await tap('localModels.cpuConfirm.confirm');
    await waitForTextIn('localModels.runtime.headline', 'Running on the CPU', 30_000);
    await waitForTextIn('localModels.runtime.cpuWarning', 'Only small models reply at a usable speed');

    // Back to a GPU machine, on the automatic backend.
    writeFileSync(FAKE_HARDWARE_FILE, 'gpu', 'utf8');
    await tap('localModels.runtime.backend.auto');
    await waitForTextIn('localModels.runtime.headline', 'Running on E2E Fake GPU', 30_000);
  });

  it('an ordinary user cannot open Host Models, but sees the enabled model in their picker', async () => {
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

  it('an ordinary user chats with the local model, served by the router with the settings the admin chose', async () => {
    await startNewThread();
    await tap('composer.model');
    await waitForVisible(`models.row.${downloadId}`);
    await tap(`models.row.${downloadId}`);
    await waitForGone('models.dialog', 10_000);
    // The fake router's own reply, not the mock backend's: the request went
    // through the router, with the key it was started with — and under the
    // router name (the id with "@" for ":"), since the router rewrites a
    // "UD-" quant after a ":" and would answer "not found".
    await sendAndAwaitReply('Hello there', `Hello from ${routerName}`);
    await shot('local-models-chat-reply');

    // And the router loaded the model with the settings saved earlier, on the GPU.
    expect(existsSync(FAKE_ROUTER_LOG)).toBe(true);
    const loads = readFileSync(FAKE_ROUTER_LOG, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; model: string; section: Record<string, string> });
    const load = loads.filter((l) => l.event === 'load' && l.model === routerName).at(-1);
    expect(load?.section['ctx-size']).toBe('8192');
    expect(load?.section['n-gpu-layers']).toBe('20');
    expect(load?.section['flash-attn']).toBe('on');
    expect(load?.section.device).toBe('FAKE0');
  });

  it('the picker marks the loaded model, so a faster answer is easy to choose', async () => {
    await tap('composer.model');
    await waitForVisible(`models.row.${downloadId}.loaded`);
    await shot('local-models-picker-loaded');
    await browser.keys('Escape');
    await waitForGone('models.dialog', 10_000);
  });

  it('an admin pins the model, and a second model is refused for lack of room beside it', async () => {
    await signOut();
    await signIn(adminCreds());

    // A second model, enabled for everyone.
    const queued = await adminApi('/v1/admin/local-models/downloads', {
      method: 'POST',
      body: JSON.stringify({ repo: tiny, quant: hf.quants.cancel }),
    });
    expect(queued.status).toBe(201);
    await waitForStatus(secondId, 'ready', 90_000);
    const enabled = await adminApi('/v1/admin/local-models/model', {
      method: 'PATCH',
      body: JSON.stringify({ id: secondId, enabled: true }),
    });
    expect(enabled.ok).toBe(true);

    await openLocalModels();
    await waitForVisible(`localModels.pin.${downloadId}`);
    await tap(`localModels.pin.${downloadId}`);
    await waitForVisible(`localModels.pinned.${downloadId}`);
    await browser.waitUntil(async () => (await apiModels()).find((m) => m.id === downloadId)?.pinned === true, {
      timeout: 10_000,
      timeoutMsg: 'the pin never reached the server',
    });
    await shot('local-models-pinned');

    const firstName = (await apiModels()).find((m) => m.id === downloadId)?.displayName ?? '';
    await browser.keys('Escape');
    await goToSurface('chat');
    await startNewThread();
    // In the picker: the pinned model is loaded, the second is not.
    await tap('composer.model');
    await waitForVisible(`models.row.${downloadId}.loaded`);
    expect(await isVisible(`models.row.${secondId}.loaded`)).toBe(false);
    await tap(`models.row.${secondId}`);
    await waitForGone('models.dialog', 10_000);

    await sendMessage('Is there room for me?');
    await waitForVisible('chat.noRoom');
    await waitForTextIn('chat.noRoom.message', `while "${firstName}" is pinned`);
    // An admin gets the way to fix it.
    await waitForVisible('chat.noRoom.manage');
    await shot('local-models-no-room-admin');
    await tap('chat.noRoom.close');
    await waitForGone('chat.noRoom', 10_000);
    // Nothing was sent: the message is back in the box, not in the thread.
    expect(await composerText()).toBe('Is there room for me?');
    expect(await threadShows('Is there room for me?')).toBe(false);
    // And the pinned model was never unloaded for it.
    expect((await apiModels()).find((m) => m.id === downloadId)?.runtimeStatus).toBe('loaded');
  });

  it('an ordinary user is told the same, and to ask an admin', async () => {
    await signOut();
    await signIn(user);
    await startNewThread();
    await pickModel(secondId);
    await sendMessage('Still no room?');
    await waitForVisible('chat.noRoom');
    await waitForTextIn('chat.noRoom.message', 'ask an admin to unpin it');
    await waitForTextIn('chat.noRoom.unsent', 'It is back in the message box');
    expect(await isVisible('chat.noRoom.manage')).toBe(false);
    await shot('local-models-no-room-user');
    await tap('chat.noRoom.close');
    await waitForGone('chat.noRoom', 10_000);

    // An attachment-only send has no text to put back, and its file cannot be
    // put back at all: the modal says so rather than promising the message is
    // in the box.
    await typeInto('composer.input', '');
    await attachDocument(TEXT_FIXTURE);
    await tap('composer.send');
    await waitForVisible('chat.noRoom');
    await waitForTextIn('chat.noRoom.unsent', 'Add its attachments again');
    await shot('local-models-no-room-attachment-only');
    await tap('chat.noRoom.close');
    await waitForGone('chat.noRoom', 10_000);
  });

  it('once unpinned, the first model is unloaded to make room for the second', async () => {
    await signOut();
    await signIn(adminCreds());
    await openLocalModels();
    await tap(`localModels.pin.${downloadId}`);
    await waitForGone(`localModels.pinned.${downloadId}`, 10_000);
    await browser.keys('Escape');

    await goToSurface('chat');
    await startNewThread();
    await pickModel(secondId);
    await sendAndAwaitReply('Room now?', `Hello from ${secondRouterName}`);
    await shot('local-models-evicted-for-second');

    // Unloaded by the server to make room, before the second loaded — not a
    // load that failed for want of memory.
    const events = routerEvents();
    const lastIndex = (event: string, model: string) =>
      events.map((e, i) => (e.event === event && e.model === model ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const unloaded = lastIndex('unload', routerName);
    const loaded = lastIndex('load', secondRouterName);
    expect(unloaded).toBeGreaterThanOrEqual(0);
    expect(unloaded).toBeLessThan(loaded);
    // These two models only: the router log is the whole run's, and another
    // spec (mtp.spec.ts) fails a load on purpose.
    expect(events.some((e) => e.event === 'load-failed' && (e.model === routerName || e.model === secondRouterName))).toBe(false);

    // The picker's badge moved with it.
    await tap('composer.model');
    await waitForVisible(`models.row.${secondId}.loaded`);
    expect(await isVisible(`models.row.${downloadId}.loaded`)).toBe(false);
    await browser.keys('Escape');
    await waitForGone('models.dialog', 10_000);
  });

  it('pinning loads a model straight away, and it is loaded again after a restart', async () => {
    await openLocalModels();
    await tap(`localModels.pin.${downloadId}`);
    await waitForVisible(`localModels.pinned.${downloadId}`);
    await waitForRuntimeStatus(downloadId, 'loaded');
    await waitForRuntimeStatus(secondId, 'unloaded');
    await waitForFreshText(`localModels.state.${downloadId}`, 'Loaded');
    await shot('local-models-pinned-loaded');

    // Its quant in the HuggingFace sheet counts its own memory as its own:
    // it was labelled "Won't fit" there while loaded, against a GPU it was
    // itself filling, though its installed row said "Will fit".
    await tap('localModels.tab.discover');
    await typeInto('localModels.search', 'tiny');
    await tap(`localModels.result.${tiny}`);
    await waitForTextIn(`localModels.quant.fit.${hf.quants.download}`, 'Will fit');
    await waitForTextIn(`localModels.quant.fit.${hf.quants.cancel}`, "Won't fit");
    await tap('localModels.details.close');
    await waitForGone('localModels.details', 10_000);
    await tap('localModels.tab.installed');

    await tap('localModels.runtime.restart');
    await waitForTextIn('localModels.runtime.headline', 'Running on E2E Fake GPU', 30_000);
    await waitForRuntimeStatus(downloadId, 'loaded');

    // Leave it unpinned for the delete below.
    await tap(`localModels.pin.${downloadId}`);
    await waitForGone(`localModels.pinned.${downloadId}`, 10_000);
  });

  it('an admin deletes the model, and it leaves the picker', async () => {
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
