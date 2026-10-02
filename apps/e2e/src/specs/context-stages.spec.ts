/**
 * YaRN context stages: a host model can be reloaded at a larger context, one
 * stage at a time, and everything a person sees of that.
 *
 * The model is the mock HuggingFace's small one, on the fake router
 * (apps/server/test-fixtures/fake-llama-server.mjs). What is real is what the
 * feature is: the admin routes and settings sheet, the stage switch that takes
 * the built-in queue and reloads the model, the preset the router is given
 * (its load log is read for the YaRN keys), the stream events behind the pill,
 * and the modals. The fake reports a prompt that says "fill the context" as 80%
 * of the window the model was loaded with, and "overflow the context" as 90%,
 * so crossing the thresholds needs no 200k-token prompt; "take your time N"
 * holds a reply open N ms a word, which is how another person's reply is
 * standing on the model.
 *
 * Stages, for the model: standard 16K (its file says 32K trained), then 64K
 * (YaRN 2×) and 128K (YaRN 4×).
 */
import { browser } from '@wdio/globals';
import { adminCreds, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  byTestId,
  isVisible,
  platform,
  tap,
  testIdSelector,
  typeInto,
  waitForAbsent,
  waitForGone,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  listConversations,
  openPlusMenu,
  openSettings,
  selectThread,
  sendMessage,
  signIn,
  signOut,
  startNewThread,
  waitForComposerReady,
} from '../helpers/app.ts';
import {
  adminApi,
  downloadTinyModel,
  loadsOf,
  patchModel,
  putModelAtStage,
  removeMockModels,
  replyFromElsewhere,
  userApi,
  waitForModelStage,
  waitUntilTrue,
} from '../helpers/hostModels.ts';

const K = 1024;
const STAGES = { enabled: true, whoMayChange: 'everyone', whenFull: 'compact', stages: [{ ctxSize: 64 * K }, { ctxSize: 128 * K }] };

async function pickModel(id: string): Promise<void> {
  await tap('composer.model');
  await waitForVisible(`models.row.${id}`);
  await tap(`models.row.${id}`);
  await waitForGone('models.dialog', 10_000);
}

/** The page goes to the background and comes back — what react-native-web's
 * AppState reads — which makes the chat hook replace its socket and ask the
 * server to catch it up on the conversation's last runs. */
async function leaveAndReturn(): Promise<void> {
  await browser.execute(() => {
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    // Put the page's own visibility back: the override would outlive this case.
    Reflect.deleteProperty(document, 'visibilityState');
  });
}

async function waitForPill(text: string, timeout = 60_000): Promise<void> {
  await waitForTextIn('chat.contextStage.label', text, timeout);
}

/** Opens Context settings from the composer's `+`. */
async function openContextSettings(): Promise<void> {
  await openPlusMenu();
  await waitForVisible('composer.plus.contextSettings');
  await tap('composer.plus.contextSettings');
  await waitForVisible('context.settings');
}

/** A fresh page: the model list is read again, as a person coming back to the app. */
async function relaunch(): Promise<void> {
  if (platform() === 'web' || platform() === 'electron') {
    await browser.refresh();
  } else {
    const app = platform() === 'ios' ? { bundleId: 'com.loxaic.app' } : { appId: 'com.loxaic.app' };
    await browser.execute('mobile: terminateApp', app);
    await browser.execute('mobile: activateApp', app);
  }
  await waitForComposerReady(60_000);
  await dismissStageDialogs();
}

/**
 * A page that opens on a conversation at 80% of its window asks about extending
 * it, as it should — and a case about something else must not be left with that
 * modal over it. Waits a moment for one to appear, since the question comes
 * once the model list has loaded.
 */
async function dismissStageDialogs(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (await isVisible('context.stageModal')) {
      await tap('context.stageModal.notNow');
      await waitForGone('context.stageModal', 10_000);
      return;
    }
    if (await isVisible('context.stageModal.stepDown')) {
      await tap('context.stageModal.keep');
      await waitForGone('context.stageModal.stepDown', 10_000);
      return;
    }
    await browser.pause(500);
  }
}

describe('YaRN context stages', () => {
  const alice = uniqueCreds();
  const bob = uniqueCreds();
  let model = '';
  /** Alice's small conversations, oldest first, as the API lists them. */
  const conversations = async () => (await listConversations(alice)).map((c) => c.id).reverse();

  before(async function () {
    this.timeout(3 * 60_000);
    await provisionAdmin();
    await provisionUser(alice);
    await provisionUser(bob);
    await removeMockModels();
    model = await downloadTinyModel();
    await patchModel(model, { enabled: true, loadSettings: { ctxSize: 16 * K }, contextStages: STAGES });
  });

  after(async () => {
    await removeMockModels();
  });

  // Bob's slow replies hold the model until stopped. A case that fails before
  // it stops its own must not leave one behind to hold up every case after it.
  const replies: { stop: () => void; close: () => void }[] = [];
  afterEach(() => {
    for (const r of replies.splice(0)) {
      r.stop();
      r.close();
    }
  });

  it('an admin sees each stage priced, a context past the trained length is a warning, and a bad stage blocks Save', async function () {
    this.timeout(3 * 60_000);
    // The Host models row sits below the fold of the Settings modal on a phone,
    // where XCUITest and UiAutomator report it not displayed; the model is set
    // up through the API for every other case, so nothing else depends on this.
    if (platform() === 'ios' || platform() === 'android') this.skip();
    await signIn(adminCreds());
    await openSettings();
    await tap('settings.nav.localModels');
    await waitForVisible('localModels.runtime');
    await tap(`localModels.settings.${model}`);
    await waitForVisible('localModels.stages');

    // The factor follows the context: 64K and 128K over a 32K-trained file.
    await waitForTextIn('localModels.stage.0.factor', 'YaRN 2×');
    await waitForTextIn('localModels.stage.1.factor', 'YaRN 4×');
    await waitForVisible('localModels.stage.0.fit');
    await waitForVisible('localModels.stage.1.fit');
    await shot('context-stages-admin-editor');

    // The trained context is advice: past it is a warning, and Save stays.
    await typeInto('localModels.setting.ctxSize.input', '40000');
    await waitForTextIn('localModels.setting.ctxSize.warning', '32,768');
    expect(await byTestId('localModels.settingsSheet.save').isEnabled()).toBe(true);
    await shot('context-stages-admin-ctx-warning');
    await typeInto('localModels.setting.ctxSize.input', '16384');
    await waitForAbsent('localModels.setting.ctxSize.warning');

    // A stage that does not grow is said so, and blocks Save.
    await typeInto('localModels.stage.1.ctx', '1000');
    await waitForTextIn('localModels.stage.1.error', 'larger than');
    expect(await byTestId('localModels.settingsSheet.save').isEnabled()).toBe(false);
    await typeInto('localModels.stage.1.ctx', '131072');
    await waitForAbsent('localModels.stage.1.error');

    // Extending automatically is the admin's choice, and is saved with the rest.
    await tap('localModels.stages.whenFull.extend');
    await tap('localModels.settingsSheet.save');
    await waitForGone('localModels.settingsSheet', 15_000);
    const saved = (await (await adminApi('/v1/admin/local-models')).json()) as {
      models: { id: string; contextStages: { whenFull: string; stages: unknown[] } | null }[];
    };
    expect(saved.models.find((m) => m.id === model)?.contextStages).toMatchObject({ whenFull: 'extend' });
    await patchModel(model, { contextStages: STAGES });
    await signOut();
  });

  it('a new chat can choose its stage from the + menu, and the first send moves the model there', async function () {
    this.timeout(4 * 60_000);
    await signIn(alice);
    await pickModel(model);
    await openContextSettings();
    await waitForVisible('context.settings.stage.2');
    await waitForVisible('context.settings.stage.0.fit');
    await shot('context-stages-settings-sheet');
    await tap('context.settings.stage.1');
    await waitForGone('context.settings', 10_000);
    await waitForTextIn('composer.contextChip', 'Context: 64K');

    await sendMessage('a first message');
    await waitForPill('Context extended to 64K (YaRN 2×)');
    await waitForTextIn('chat.messageList', 'Hello from');
    await shot('context-stages-new-chat-chose-64k');

    // What the router was given: the stage's context and the YaRN keys the
    // real one accepts.
    const load = loadsOf(model).at(-1);
    expect(load?.section).toMatchObject({ 'ctx-size': '65536', 'rope-scaling': 'yarn', 'rope-scale': '2', 'yarn-orig-ctx': '32768' });
    await waitForModelStage(alice, model, 1);
  });

  it('a new chat steps the model back down to standard by itself, without asking', async function () {
    this.timeout(4 * 60_000);
    await startNewThread();
    await sendMessage('a short question');
    await waitForPill('Switched to standard context (16K)');
    await waitForTextIn('chat.messageList', 'Hello from');
    expect(await isVisible('context.stageModal')).toBe(false);
    await shot('context-stages-new-chat-stepped-down');

    const load = loadsOf(model).at(-1);
    expect(load?.section?.['ctx-size']).toBe('16384');
    expect(load?.section).not.toHaveProperty('rope-scaling');
    await waitForModelStage(alice, model, 0);
  });

  it('a conversation nearing its window is offered Compact or Extend, with what each costs — and Compact compacts', async function () {
    this.timeout(4 * 60_000);
    if (platform() === 'ios') this.skip(); // overlay testIDs, a known harness limit
    await startNewThread();
    await sendMessage('please fill the context');
    await waitForTextIn('chat.messageList', 'Hello from');
    // 80% of the 16K the model is loaded with: past the 75% that asks.
    await waitForVisible('context.stageModal', 30_000);
    await waitForTextIn('context.stageModal', 'nearly full');
    await waitForTextIn('context.stageModal', 'Extend to 64K (YaRN 2×)');
    await waitForVisible('context.stageModal.fit');
    // Other conversations on the model are affected too, and the modal says so.
    await waitForTextIn('context.stageModal.others', 'using this model');
    await shot('context-stages-approaching-modal');

    await tap('context.stageModal.compact');
    await waitForGone('context.stageModal', 10_000);
    // The fake router answers a compaction in milliseconds, so the live card is
    // not there to catch (compaction-live.spec.ts slows one for that).
    await waitForTextIn('chat.messageList', 'Compacted', 60_000);
    // Compacting left the model where it was.
    await waitForModelStage(alice, model, 0);
  });

  it('Extend reloads the model at the next stage, and shows it working', async function () {
    this.timeout(4 * 60_000);
    if (platform() === 'ios') this.skip();
    await startNewThread();
    await sendMessage('please fill the context');
    await waitForTextIn('chat.messageList', 'Hello from');
    await waitForVisible('context.stageModal.extend', 30_000);
    await tap('context.stageModal.extend');
    await waitForGone('context.stageModal', 10_000);
    await waitForPill('reloading at 64K');
    await shot('context-stages-reloading');
    // Then the re-read, with the backend's own progress: a percentage that
    // moves, not one stuck at the 0% llama.cpp reports as the slot starts.
    let seen = '';
    await browser.waitUntil(
      async () => {
        seen = await byTestId('chat.contextStage.label').getText();
        return /Re-reading conversation · [1-9]\d*%/.test(seen);
      },
      { timeout: 30_000, interval: 100, timeoutMsg: `the re-read never showed progress past 0% (last: "${seen}")` },
    );
    await shot('context-stages-rereading');
    await waitForPill('Context extended to 64K (YaRN 2×)');
    await shot('context-stages-extended');
    await waitForModelStage(alice, model, 1);
    expect(loadsOf(model).at(-1)?.section).toMatchObject({ 'rope-scale': '2', 'ctx-size': '65536' });
  });

  it('reopening a small conversation on an extended model offers to switch back — and Switch does', async function () {
    this.timeout(4 * 60_000);
    if (platform() === 'ios') this.skip();
    const [first] = await conversations();
    await relaunch(); // the model list is read again: the model is at 64K
    await selectThread(first);
    await waitForVisible('context.stageModal.stepDown', 30_000);
    await waitForTextIn('context.stageModal.stepDown', 'extended context on');
    await shot('context-stages-step-down-modal');
    await tap('context.stageModal.switchDown');
    await waitForGone('context.stageModal.stepDown', 10_000);
    await waitForPill('Switched to standard context (16K)');
    await waitForModelStage(alice, model, 0);
  });

  it("another person's reply makes a switch wait for it, and says so first", async function () {
    this.timeout(5 * 60_000);
    if (platform() === 'ios') this.skip();
    await relaunch();
    // The fourth conversation: the one that was extended.
    const inConversation = (await conversations())[3];
    await selectThread(inConversation);

    // Bob is replying on the model — a reply that takes a while.
    const bobs = await replyFromElsewhere(bob, model, 'take your time 60000');
    replies.push(bobs);
    await waitUntilTrue(
      async () => {
        const res = await userApi(alice, `/v1/models/context-stage?model=${encodeURIComponent(model)}&conversation_id=${inConversation}`);
        return ((await res.json()) as { others?: { running: number } }).others?.running === 1;
      },
      30_000,
      "Bob's reply never reached the model",
    );

    await openContextSettings();
    await waitForTextIn('context.settings.others', 'replying right now');
    await waitForTextIn('context.settings.others', 'the switch will wait');
    await shot('context-stages-others-replying');
    const loadsBefore = loadsOf(model).length;
    await tap('context.settings.stage.2');
    await waitForGone('context.settings', 10_000);

    // Waiting, not reloading: the model is not touched under Bob's reply.
    await waitForPill('Waiting for another reply to finish');
    await shot('context-stages-waiting');
    const during = (await (await userApi(alice, `/v1/models/context-stage?model=${encodeURIComponent(model)}`)).json()) as { pending: number | null };
    expect(during.pending).toBe(2);
    expect(loadsOf(model).length).toBe(loadsBefore);

    // Bob's reply ends; then, and only then, the model reloads at 128K.
    bobs.stop();
    await bobs.done;
    await waitForPill('Context extended to 128K (YaRN 4×)', 90_000);
    expect(loadsOf(model).at(-1)?.section).toMatchObject({ 'ctx-size': '131072', 'rope-scale': '4' });
    await waitForModelStage(alice, model, 2);
    bobs.close();
  });

  it('a switch that is waiting can be cancelled, and leaves the stage as it was', async function () {
    this.timeout(5 * 60_000);
    if (platform() === 'ios') this.skip();
    await putModelAtStage(adminCreds(), model, 0);
    await relaunch();
    const bobs = await replyFromElsewhere(bob, model, 'take your time 60000');
    replies.push(bobs);
    await waitUntilTrue(
      async () => ((await (await userApi(alice, `/v1/models/context-stage?model=${encodeURIComponent(model)}`)).json()) as { others?: { running: number } }).others?.running === 1,
      30_000,
      "Bob's reply never reached the model",
    );
    await openContextSettings();
    await tap('context.settings.stage.2');
    await waitForGone('context.settings', 10_000);
    await waitForPill('Waiting for another reply to finish');

    // The context popup says what it is waiting to do, and can stop it.
    await tap('composer.context');
    await waitForTextIn('context.stage.pending', 'Switching to 128K after the current reply');
    await shot('context-stages-pending-in-popup');
    await tap('context.stage.cancel');
    await waitUntilTrue(
      async () => ((await (await userApi(alice, `/v1/models/context-stage?model=${encodeURIComponent(model)}`)).json()) as { pending: number | null }).pending === null,
      20_000,
      'the switch was never withdrawn',
    );
    if (platform() === 'web' || platform() === 'electron') await browser.keys('Escape');
    // Its pill goes: nothing was switched, so there is nothing to say.
    await waitForAbsent('chat.contextStage', 20_000);
    bobs.stop();
    await bobs.done;
    bobs.close();
    // Withdrawn, so the stage is as it was.
    await waitForModelStage(alice, model, 0);
  });

  it('a model an admin keeps to themselves shows the row disabled, with the reason', async function () {
    this.timeout(3 * 60_000);
    await patchModel(model, { contextStages: { ...STAGES, whoMayChange: 'admins' } });
    await relaunch();
    await openPlusMenu();
    await waitForVisible('composer.plus.contextSettings');
    await waitForTextIn('composer.plus.contextSettings', "An admin controls this model's context");
    await shot('context-stages-admins-only');
    if (platform() === 'web' || platform() === 'electron') {
      expect(await byTestId('composer.plus.contextSettings').getAttribute('aria-disabled')).toBe('true');
    }
    if (platform() === 'web' || platform() === 'electron') await browser.keys('Escape');
    await patchModel(model, { contextStages: STAGES });
  });

  it('a model set to extend by itself does, with no modal — and says why', async function () {
    this.timeout(5 * 60_000);
    await putModelAtStage(adminCreds(), model, 0);
    await patchModel(model, { contextStages: { ...STAGES, whenFull: 'extend' } });
    await relaunch();
    await startNewThread();
    await sendMessage('please overflow the context');
    await waitForTextIn('chat.messageList', 'Hello from');
    await waitForPill('Context full', 60_000);
    await waitForPill('Context extended to 64K (YaRN 2×)', 90_000);
    expect(await isVisible('context.stageModal')).toBe(false);
    await shot('context-stages-extended-automatically');
    await waitForModelStage(alice, model, 1);
    await patchModel(model, { contextStages: STAGES });
  });

  it('a stage smaller than the conversation asks to compact first — Cancel changes nothing, Compact and switch does both', async function () {
    this.timeout(6 * 60_000);
    if (platform() === 'ios') this.skip();
    // The model is at 64K (from the case before). Another conversation still
    // needs that much, so it could not be stepped down now — and does not need
    // to be: a chat that chooses 128K moves it up from wherever it is.
    await relaunch();
    // A new chat that starts at 128K: chosen in Context settings, so the model
    // is not stepped back down for it.
    await startNewThread();
    await openContextSettings();
    await tap('context.settings.stage.2');
    await waitForTextIn('composer.contextChip', 'Context: 128K');
    await sendMessage('please fill the context');
    await waitForTextIn('chat.messageList', 'Hello from', 90_000);
    await waitForPill('Context extended to 128K (YaRN 4×)');
    // 80% of 128K, at the last stage: there is no larger one to offer.
    expect(await isVisible('context.stageModal')).toBe(false);

    await openContextSettings();
    await tap('context.settings.stage.1');
    await waitForVisible('context.stageModal.compactFirst');
    await waitForTextIn('context.stageModal.compactFirst.message', "can't hold it");
    await shot('context-stages-compact-first');
    await tap('context.stageModal.cancel');
    await waitForGone('context.stageModal.compactFirst', 10_000);
    await waitForModelStage(alice, model, 2);

    await openContextSettings();
    await tap('context.settings.stage.1');
    await waitForVisible('context.stageModal.compactFirst');
    await tap('context.stageModal.compactAndSwitch');
    await waitForGone('context.stageModal.compactFirst', 10_000);
    // Compacted first, then the model moves down to the stage that now fits.
    await waitForTextIn('chat.messageList', 'Compacted', 60_000);
    await waitForPill('Context set to 64K (YaRN 2×)', 90_000);
    await waitForModelStage(alice, model, 1);
    await shot('context-stages-compacted-then-switched');
  });

  it('a card the person has moved past does not come back when the connection is replaced', async function () {
    this.timeout(4 * 60_000);
    // Replacing the socket from a script is a page's trick; on a phone it is a
    // return from the background, which connection-lifecycle.spec.ts drives.
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    // The case before leaves its thread showing "Context set to 64K": a finished
    // switch, which is what a reconnect's catch-up would bring back.
    await waitForPill('Context set to 64K (YaRN 2×)', 10_000);
    // Sending again is what dismisses it.
    await sendMessage('thank you');
    await waitForGone('chat.contextStage', 30_000);
    await waitForComposerReady();
    await shot('context-stages-card-dismissed');

    // The connection is replaced, and the server catches the client up on the
    // conversation's last runs — the finished stage run's card is still in the
    // stream log. It must stay gone, above a reply that has already superseded it.
    await leaveAndReturn();
    await browser.pause(4_000);
    if (await isVisible('chat.contextStage')) throw new Error('the stage card came back after a reconnect');
    await shot('context-stages-card-stays-dismissed');
  });

  it('a turn that jumps past the compaction threshold asks first — and compacts on the next one if nobody chose', async function () {
    this.timeout(6 * 60_000);
    // Counting replies reads the page; the rule itself is the server's, the
    // same on every platform.
    if (platform() !== 'web' && platform() !== 'electron') this.skip();
    const replies = (): Promise<number> =>
      browser.execute(
        (selector: string) => (document.querySelector(selector)?.textContent ?? '').split('Hello from').length - 1,
        testIdSelector('chat.messageList'),
      );
    const listText = (): Promise<string> =>
      browser.execute((selector: string) => document.querySelector(selector)?.textContent ?? '', testIdSelector('chat.messageList'));

    await relaunch();
    await startNewThread();
    // Enough of a conversation for automatic compaction to apply at all (its
    // 8-message floor), all of it small.
    for (let i = 1; i <= 4; i++) {
      await sendMessage(`note number ${String(i)}`);
      await browser.waitUntil(async () => (await replies()) >= i, { timeout: 60_000, timeoutMsg: `reply ${String(i)} never arrived` });
      await waitForComposerReady();
    }
    // One turn that reports 90% of the window: from well below the prompt
    // (75%) straight past automatic compaction (85%). It used to compact at
    // once, so Extend was never offered.
    await sendMessage('please overflow the context');
    await browser.waitUntil(async () => (await replies()) >= 5, { timeout: 60_000, timeoutMsg: 'the overflowing reply never arrived' });
    await waitForVisible('context.stageModal', 30_000);
    await waitForVisible('context.stageModal.extend');
    await shot('context-stages-asked-before-compacting');
    await browser.pause(3_000);
    if ((await listText()).includes('Compacted')) throw new Error('it compacted instead of asking');

    // Nobody chose: the next turn past the threshold compacts, as it always did.
    await tap('context.stageModal.notNow');
    await waitForGone('context.stageModal', 10_000);
    await sendMessage('please overflow the context');
    await waitForTextIn('chat.messageList', 'Compacted', 90_000);
    await shot('context-stages-compacted-when-nobody-chose');
  });
});
