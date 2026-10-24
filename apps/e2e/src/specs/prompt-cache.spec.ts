/**
 * A conversation's prompt cache across a host-model reload: kept when the
 * reload changes nothing it was computed with (and loaded back, under a pill,
 * at the conversation's next turn), and said to be gone — above the composer,
 * before the next message pays for it — when a reload took it.
 *
 * On the fake router (apps/server/test-fixtures/fake-llama-server.mjs), which
 * keeps per-slot state, saves and restores slots under the `slot-save-path`
 * the server writes, and reports `cache_n` on each chat in its log. Like the
 * hybrid models on Pheonix, it reuses a restored slot only when the next
 * request extends it exactly. A restore reads for three seconds
 * (`LOXAIC_FAKE_RESTORE_MS` in standup.ts), so the pill can be watched; "fill
 * the context" makes a conversation big enough (80% of 16K) for the banner.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, platform, scrollTo, tap, waitForAbsent, waitForFreshText, waitForTextIn, waitForVisible, waitForGone } from '../helpers/selectors.ts';
import {
  listConversations,
  openSettings,
  selectThread,
  sendMessage,
  signIn,
  signOut,
  startNewThread,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';
import { SLOT_FREE_FILE } from '../../scripts/standup.ts';
import { adminApi, downloadTinyModel, patchModel, putModelAtStage, removeMockModels, routerEvents, routerName, type RouterEvent } from '../helpers/hostModels.ts';

const K = 1024;
const SETTINGS = { ctxSize: 16 * K };
// Set to extend when full, which never asks: at 80% the "nearly full" modal
// would cover the conversation, and on iOS nothing behind it can be read. The
// one case about that modal turns asking back on.
const STAGES = { enabled: true, whoMayChange: 'everyone', whenFull: 'extend', stages: [{ ctxSize: 64 * K }] };

/**
 * Send, and on Android make sure it went: with the idle wait off (see
 * `before`), a tap can land before the button is enabled, and the text sits in
 * the composer. Only then is it tapped again, so nothing is sent twice.
 */
async function send(text: string): Promise<void> {
  await sendMessage(text);
  if (platform() !== 'android') return;
  for (let i = 0; i < 3; i++) {
    await browser.pause(1500);
    const left = await byTestId('composer.input').getText().catch(() => '');
    if (left !== text) return;
    await tap('composer.send');
  }
}

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForGone('models.dialog', 10_000);
}

/** A conversation at 80% of its window asks about extending it; these cases
 * are about something else. */
async function dismissStageDialog(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (await isVisible('context.stageModal')) {
      await tap('context.stageModal.notNow');
      await waitForAbsent('context.stageModal', 10_000);
      return;
    }
    await browser.pause(500);
  }
}

/** A fresh page or app: what the composer is told is asked for again. */
async function relaunch(): Promise<void> {
  if (platform() === 'web' || platform() === 'electron') {
    await browser.refresh();
  } else {
    const app = platform() === 'ios' ? { bundleId: 'com.loxaic.app' } : { appId: 'com.loxaic.app' };
    await browser.execute('mobile: terminateApp', app);
    await browser.execute('mobile: activateApp', app);
  }
  await waitForComposerReady(60_000);
  await dismissStageDialog();
}

const eventsSince = (from: number, model: string): RouterEvent[] => routerEvents().slice(from).filter((e) => e.model === routerName(model));

async function waitForEvent(from: number, model: string, test: (e: RouterEvent) => boolean, what: string, timeout = 60_000): Promise<RouterEvent> {
  let found: RouterEvent | undefined;
  await browser.waitUntil(
    () => {
      found = eventsSince(from, model).find(test);
      return Promise.resolve(Boolean(found));
    },
    { timeout, interval: 250, timeoutMsg: `[e2e] the router never logged ${what}` },
  );
  if (!found) throw new Error(`[e2e] the router never logged ${what}`);
  return found;
}

describe('the prompt cache across a host-model reload', () => {
  const alice = uniqueCreds();
  let model = '';
  const newestConversation = async () => (await listConversations(alice))[0].id;

  before(async function () {
    this.timeout(3 * 60_000);
    await provisionAdmin();
    await provisionUser(alice);
    await removeMockModels();
    model = await downloadTinyModel();
    await patchModel(model, { enabled: true, loadSettings: SETTINGS, contextStages: STAGES });
    await signIn(alice);
    await pickModel(model);
    // The pill sits beside a spinner and a ticking counter, and lasts three
    // seconds: UiAutomator2's wait for an idle screen (~11 s a query) misses it.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
    // The last case's slow reply may still be finishing: the model is removed
    // once it is idle, and a refusal that outlasts that still throws.
    let lastError: unknown = null;
    for (let i = 0; i < 30; i++) {
      try {
        await removeMockModels();
        return;
      } catch (err) {
        lastError = err;
        await browser.pause(1000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  });

  it('a settings change that keeps the cache: the next turn loads it back, with the pill', async function () {
    this.timeout(4 * 60_000);
    await startNewThread();
    await send('please fill the context');
    await waitForTextIn('chat.messageList', 'Hello from');
    await dismissStageDialog();
    const conversation = await newestConversation();

    // An admin changes how the model samples: nothing its cache was computed with.
    const from = routerEvents().length;
    await patchModel(model, { loadSettings: { ...SETTINGS, temperature: 0.4 } });
    const saved = await waitForEvent(from, model, (e) => e.event === 'slot-save' && (e.file ?? '').includes(conversation), 'the slot saved');
    await waitForEvent(from, model, (e) => e.event === 'unload', 'the reload');
    expect(saved.tokens).toBeGreaterThan(10_000);

    // Kept, so nothing warns.
    await relaunch();
    await selectThread(conversation);
    await browser.pause(2000);
    expect(await isVisible('chat.promptCache.banner')).toBe(false);

    const before = routerEvents().length;
    await send('and once more');
    await waitForTextIn('chat.promptCache.pill.label', 'Loading cached context', 30_000);
    await shot('prompt-cache-loading');
    // A second reply in a thread: the first "Hello from" is scrolled off, and a
    // native lookup takes that one. The run's end is what says it answered.
    await waitForRunDone(alice, conversation);
    await waitForEvent(before, model, (e) => e.event === 'slot-restore' && (e.file ?? '').includes(conversation), 'the restore');
    // The turn's request reused what came back, not a re-read (the fake
    // prices this short message at 10 tokens, so the reuse is the 9 it may).
    const chat = await waitForEvent(before, model, (e) => e.event === 'chat', 'the turn');
    expect(chat.cache_n).toBeGreaterThan(0);
    // Gone with the reply's first words.
    await waitForAbsent('chat.promptCache.pill', 30_000);
  });

  it('an Unload and Load keep it too', async function () {
    this.timeout(4 * 60_000);
    await startNewThread();
    await send('please fill the context again');
    await waitForTextIn('chat.messageList', 'Hello from');
    await dismissStageDialog();
    const conversation = await newestConversation();

    const from = routerEvents().length;
    const res = await adminApi('/v1/admin/local-models/model/unload', { method: 'POST', body: JSON.stringify({ id: model }) });
    expect(res.ok).toBe(true);
    await waitForEvent(from, model, (e) => e.event === 'slot-save' && (e.file ?? '').includes(conversation), 'the slot saved');

    await send('still there?');
    await waitForTextIn('chat.promptCache.pill.label', 'Loading cached context', 60_000);
    await waitForRunDone(alice, conversation);
    const chat = await waitForEvent(from, model, (e) => e.event === 'chat' && e.last_user === 'still there?', 'the turn');
    expect(chat.cache_n).toBeGreaterThan(0);
  });

  it('a stage change says the cache is rebuilt, and a conversation it took warns before re-reading', async function () {
    this.timeout(5 * 60_000);
    // A long conversation at the standard stage...
    await startNewThread();
    await send('please fill the context, the long one');
    await waitForTextIn('chat.messageList', 'Hello from');
    await dismissStageDialog();
    const long = await newestConversation();

    // ...and the modal that offers a larger stage says what it costs everyone.
    await patchModel(model, { contextStages: { ...STAGES, whenFull: 'compact' } });
    await startNewThread();
    await send('please fill the context too');
    // It opens once the reply is in, over it.
    await waitForVisible('context.stageModal', 60_000);
    await waitForTextIn('context.stageModal.cacheRebuilt', 'prompt cache is rebuilt');
    await shot('prompt-cache-stage-modal');
    await tap('context.stageModal.notNow');
    await waitForAbsent('context.stageModal', 10_000);
    await patchModel(model, { contextStages: STAGES });

    const from = routerEvents().length;
    await putModelAtStage(alice, model, 1);
    // A different context computes different keys: nothing is saved.
    expect(eventsSince(from, model).some((e) => e.event === 'slot-save')).toBe(false);

    await relaunch();
    await selectThread(long);
    await waitForTextIn('chat.promptCache.banner.text', 'at a different context size', 30_000);
    await waitForTextIn('chat.promptCache.banner.text', 're-reads all 13k tokens');
    await shot('prompt-cache-lost-banner');

    const before = routerEvents().length;
    await send('carry on');
    await waitForAbsent('chat.promptCache.banner', 30_000);
    await waitForRunDone(alice, long);
    const chat = await waitForEvent(before, model, (e) => e.event === 'chat' && e.last_user === 'carry on', 'the turn');
    expect(chat.cache_n).toBe(0);
    expect(eventsSince(before, model).some((e) => e.event === 'slot-restore')).toBe(false);
  });

  it('a conversation no reload touched shows neither', async function () {
    this.timeout(3 * 60_000);
    await startNewThread();
    await send('please fill the context, quietly');
    await waitForTextIn('chat.messageList', 'Hello from');
    await dismissStageDialog();
    const before = routerEvents().length;
    await send('take your time 2000 and answer again');
    await waitForVisible('chat.status', 30_000);
    expect(await isVisible('chat.promptCache.pill')).toBe(false);
    // Once the reply has ended, when the composer asks again: still nothing.
    await waitForRunDone(alice, await newestConversation());
    await browser.pause(3000);
    expect(await isVisible('chat.promptCache.banner')).toBe(false);
    expect(eventsSince(before, model).some((e) => e.event === 'slot-restore')).toBe(false);
    // Reused live, as any next turn on a loaded model is.
    const chat = await waitForEvent(before, model, (e) => e.event === 'chat', 'the turn');
    expect(chat.cache_n).toBeGreaterThan(0);
  });


  it('a disk too full to keep the cache: the conversation says so, and so does the admin\'s Host models card', async function () {
    this.timeout(5 * 60_000);
    await startNewThread();
    await send('please fill the context, with no room to keep it');
    await waitForTextIn('chat.messageList', 'Hello from');
    await dismissStageDialog();
    const conversation = await newestConversation();

    // The server sees one free byte where saved caches go.
    writeFileSync(SLOT_FREE_FILE, '1');
    try {
      const from = routerEvents().length;
      await patchModel(model, { loadSettings: { ...SETTINGS, temperature: 0.55 } });
      await waitForEvent(from, model, (e) => e.event === 'unload', 'the reload');
      expect(eventsSince(from, model).some((e) => e.event === 'slot-save')).toBe(false);
    } finally {
      rmSync(SLOT_FREE_FILE, { force: true });
    }

    await relaunch();
    await selectThread(conversation);
    await waitForTextIn('chat.promptCache.banner.text', "didn't have the disk space", 30_000);
    await shot('prompt-cache-no-disk-banner');

    // The admin is the one who can free the disk, and is told so.
    await signOut();
    await signIn(adminCreds());
    await openSettings();
    await scrollTo('settings.nav.localModels');
    await tap('settings.nav.localModels');
    await waitForVisible('localModels.runtime');
    await waitForFreshText('localModels.runtime.slotCacheDisk.message', "Prompt caches weren't saved", 30_000);
    await shot('prompt-cache-no-disk-admin');
  });
});
