/**
 * The progress review, end to end: a second model call that looks at a long
 * run every few steps and decides on its own whether it is still getting
 * somewhere. It replaced the step check-in and the loop detector, and it never
 * asks anyone anything — so every case here also asserts that nothing waits
 * for a person.
 *
 * The mock reviewer answers from keywords in the task (REVIEW_* prompts in
 * helpers/app.ts). Reviews are set to every three steps through the API; the
 * settings screen has its own spec.
 */
import { $$, browser } from '@wdio/globals';
import { provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, platform, tap, testIdSelector, waitForFreshText, waitForGone, waitForTextIn } from '../helpers/selectors.ts';
import {
  ANSWER_NOW_TEXT,
  PROGRESS_NOTE_TEXT,
  REVIEW_FINISHED_PROMPT,
  REVIEW_LINGER_DONE,
  REVIEW_LINGER_PROMPT,
  REVIEW_LINGER_SLOW_PROMPT,
  REVIEW_STEADY_DONE,
  REVIEW_STEADY_PROMPT,
  REVIEW_STUCK_PROMPT,
  REVIEW_STUCK_SLOW_PROMPT,
  REVIEW_SUBAGENT_DONE,
  REVIEW_SUBAGENT_PROMPT,
  chooseScratchWorkspace,
  closeThreadKeyboard,
  getMessageTexts,
  getToolResults,
  goToSurface,
  listConversations,
  patchInferenceSettings,
  patchPrefs,
  resetInferenceSettings,
  selectThread,
  sendInNewRun,
  sendMessage,
  signUp,
  startNewAgentRun,
  startNewThread,
  waitForComposerReady,
  waitForRunDone,
} from '../helpers/app.ts';

type Surface = 'chat' | 'agent';

/** A new thread on `surface` (an Agent one in Auto, on a scratch workspace),
 * the prompt sent, and the new conversation's id. */
async function runIn(creds: { email: string; password: string }, surface: Surface, prompt: string): Promise<string> {
  await goToSurface(surface);
  if (surface === 'agent') {
    await startNewAgentRun();
    await chooseScratchWorkspace();
    await tap('agent.mode.auto');
    return sendInNewRun(creds, prompt);
  }
  await startNewThread('chat');
  const before = new Set((await listConversations(creds)).map((c) => c.id));
  await sendMessage(prompt);
  let id = '';
  await browser.waitUntil(
    async () => {
      id = (await listConversations(creds)).find((c) => !before.has(c.id))?.id ?? '';
      return id !== '';
    },
    { timeout: 20_000, timeoutMsg: 'the new chat never reached the conversation list' },
  );
  // On an iPhone the keyboard stays up and hides the newest lines.
  await closeThreadKeyboard();
  return id;
}

const notesIn = (texts: string[]) => texts.filter((t) => t.startsWith('[Progress check] '));

/** Wait for `text` in any element under `id`. A thread with two notes keeps
 * both in the native tree, and `$` would read only the first: the one
 * scrolled above the screen. */
async function waitForTextInAny(id: string, text: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const el of await $$(testIdSelector(id)).getElements()) {
        if ((await el.getText()).includes(text)) return true;
      }
      return false;
    },
    { timeout, interval: 300, timeoutMsg: `expected "${text}" in some [${id}] within ${String(timeout)}ms` },
  );
}

/** Nothing on screen asks a person anything while it runs. */
async function expectNobodyAsked(): Promise<void> {
  for (const id of ['checkin.banner', 'agent.permission.bar']) {
    if (await isVisible(id)) throw new Error(`${id} is showing: a progress review must never ask anyone`);
  }
}

describe('the progress review', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await patchPrefs(creds, { progressReview: true, progressCheckSteps: 3, progressCheckMs: null });
  });

  for (const surface of ['chat', 'agent'] as const) {
    it(`leaves a run that is making progress alone (${surface})`, async function () {
      this.timeout(3 * 60_000);
      const conversationId = await runIn(creds, surface, REVIEW_STEADY_PROMPT);
      await waitForRunDone(creds, conversationId);
      if (surface === 'chat') await waitForTextIn('chat.messageList', REVIEW_STEADY_DONE, 90_000);
      else await waitForTextIn('agent.run.status', 'Done', 90_000);
      // Reviewed twice (after steps 3 and 6), and nothing said about it.
      expect(await isVisible('progress.note')).toBe(false);
      expect(notesIn(await getMessageTexts(creds, conversationId))).toEqual([]);
      expect((await getToolResults(creds, conversationId)).length).toBe(7);
      await expectNobodyAsked();
    });

    it(`steers a stuck run, then has it answer, with nobody asked (${surface})`, async function () {
      this.timeout(3 * 60_000);
      const conversationId = await runIn(creds, surface, REVIEW_STUCK_PROMPT);
      // The mock runs the drill in moments, so the newest note is what is on
      // screen by now; the earlier one has scrolled out of the virtualised
      // list, and is read from the server below.
      await waitForRunDone(creds, conversationId);
      await waitForTextInAny('progress.note.reason', PROGRESS_NOTE_TEXT, 90_000);
      await waitForTextInAny('progress.note.outcome', 'Told to answer now');
      await shot(`progress-review-stuck-${surface}`);
      const texts = await getMessageTexts(creds, conversationId);
      expect(texts.some((t) => t.includes(ANSWER_NOW_TEXT))).toBe(true);

      // Steered after step 3, so it went on to step 6; told to answer there.
      expect((await getToolResults(creds, conversationId)).length).toBe(6);
      const notes = notesIn(await getMessageTexts(creds, conversationId));
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain('Change your approach');
      expect(notes[1]).toContain('give your best final answer now');
      await expectNobodyAsked();

      // From history, with the offline copy dropped, the notes read the same.
      const p = platform();
      if (p === 'web' || p === 'electron') {
        await browser.execute(() => {
          for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith('loxaic-cache:')) window.localStorage.removeItem(key);
          }
        });
        await browser.refresh();
        await waitForComposerReady();
        await goToSurface(surface);
        await selectThread(conversationId, surface);
        await waitForTextInAny('progress.note.outcome', 'Told to answer now');
        await shot(`progress-review-stuck-${surface}-after-reload`);
      }
    });
  }

  it('tells a run the reviewer calls finished so once, and has it answer the second time', async function () {
    this.timeout(3 * 60_000);
    const conversationId = await runIn(creds, 'agent', REVIEW_FINISHED_PROMPT);
    await waitForRunDone(creds, conversationId);
    await waitForTextInAny('progress.note.reason', 'says finished', 90_000);
    await waitForTextInAny('progress.note.outcome', 'Told to answer now');
    await shot('progress-review-finished');
    // One "finished" alone never ends a run somebody started: told so after
    // step 3, it went on to step 6, and was told to answer there.
    expect((await getToolResults(creds, conversationId)).length).toBe(6);
    const texts = await getMessageTexts(creds, conversationId);
    const notes = notesIn(texts);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('says finished');
    expect(notes[0]).toContain('If you already have what you need');
    expect(notes[1]).toContain('give your best final answer now');
    expect(texts.some((t) => t.includes(ANSWER_NOW_TEXT))).toBe(true);
    await expectNobodyAsked();
  });

  it('says a review is under way while the run waits for it, then carries on', async function () {
    this.timeout(3 * 60_000);
    // The mock backend has one slot, so the run lends its own and pauses.
    const conversationId = await runIn(creds, 'agent', REVIEW_LINGER_PROMPT);
    await waitForFreshText('run.review.status', 'Paused to check progress', 60_000);
    await shot('progress-review-paused');
    await expectNobodyAsked();
    await waitForGone('run.review.status', 60_000);
    await waitForRunDone(creds, conversationId, 180_000);
    await waitForTextIn('agent.run.status', 'Done', 60_000);
    expect(notesIn(await getMessageTexts(creds, conversationId))).toEqual([]);
    expect((await getMessageTexts(creds, conversationId)).some((t) => t.includes(REVIEW_LINGER_DONE))).toBe(true);
  });

  it('reviews on the clock alone when the steps are slow, with nobody asked', async function () {
    this.timeout(5 * 60_000);
    // Five seconds of work between reviews, five hundred steps: only the
    // clock can make one due. Every step of this drill takes eight seconds.
    await patchPrefs(creds, { progressCheckMs: 5_000, progressCheckSteps: 500 });
    try {
      const conversationId = await runIn(creds, 'agent', REVIEW_STUCK_SLOW_PROMPT);
      await waitForRunDone(creds, conversationId, 240_000);
      // Steered after its first slow step and told to answer after its
      // second. On the step cadence it would have run all twelve.
      expect((await getToolResults(creds, conversationId)).length).toBe(2);
      const notes = notesIn(await getMessageTexts(creds, conversationId));
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain('Change your approach');
      expect(notes[1]).toContain('give your best final answer now');
      // Read once the run is over: on Android a lookup beside a slow step
      // takes longer than the step.
      await waitForTextInAny('progress.note.outcome', 'Told to answer now', 60_000);
      await shot('progress-review-on-the-clock');
      await expectNobodyAsked();
    } finally {
      await patchPrefs(creds, { progressCheckMs: null, progressCheckSteps: 3 });
    }
  });

  describe('with a spare inference slot', () => {
    before(async () => {
      await provisionAdmin();
      await patchInferenceSettings({ maxConcurrentRuns: 2 });
    });
    after(async () => {
      await resetInferenceSettings();
    });

    it('reviews beside the run without pausing it', async function () {
      // Not on Android: every step here is slow, and while one streams the app
      // keeps the emulator's UI thread busy, so a UiAutomator2 lookup takes
      // 30-40 s (with waitForIdleTimeout 0) and never lands inside a
      // 12-second review. The status line itself is checked on Android by the
      // paused case above, the wording by apps/mobile/lib/progressReview.test.ts,
      // and running beside the run by the server's progress-review-run.test.ts.
      if (platform() === 'android') this.skip();
      this.timeout(5 * 60_000);
      const conversationId = await runIn(creds, 'agent', REVIEW_LINGER_SLOW_PROMPT);
      await waitForFreshText('run.review.status', 'Checking progress', 60_000);
      await shot('progress-review-alongside');
      // The run kept going meanwhile: steps finished while the review ran.
      const during = (await getToolResults(creds, conversationId)).length;
      await browser.waitUntil(async () => (await getToolResults(creds, conversationId)).length > during, {
        timeout: 11_000,
        interval: 250,
        timeoutMsg: 'the run stood still while a review ran beside it',
      });
      await waitForRunDone(creds, conversationId, 240_000);
      expect(notesIn(await getMessageTexts(creds, conversationId))).toEqual([]);
    });
  });

  it("tells a stuck sub-agent to report, and its parent carries on", async function () {
    this.timeout(3 * 60_000);
    const conversationId = await runIn(creds, 'agent', REVIEW_SUBAGENT_PROMPT);
    await waitForRunDone(creds, conversationId, 150_000);
    await waitForTextIn('chat.messageList', REVIEW_SUBAGENT_DONE, 60_000);
    // The child's report is what it answered when told to: its result says so.
    const [report] = await getToolResults(creds, conversationId);
    expect(report.ok).toBe(true);
    expect(report.output).toContain(ANSWER_NOW_TEXT);
    await shot('progress-review-subagent');
    await expectNobodyAsked();
  });
});
