/**
 * The progress review, end to end: a second model call that looks at a long
 * run every few steps and decides on its own whether it is still getting
 * somewhere. It replaced the step check-in and the loop detector, and it never
 * asks anyone anything — so every case here also asserts that nothing waits
 * for a person.
 *
 * Every review is a card in the thread where it was taken, a review that
 * found nothing wrong included, live and after a reload; pressing one opens
 * a panel with everything it has to show. The note under a card is what the
 * run was told, and only that is ever part of the model's prompt.
 *
 * The mock reviewer answers from keywords in the task (REVIEW_* prompts in
 * helpers/app.ts). Reviews are set to every three steps through the API; the
 * settings screen has its own spec.
 */
import { $$, browser } from '@wdio/globals';
import { provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  expectTextAbsent,
  isVisible,
  platform,
  scrollTo,
  tap,
  testIdSelector,
  waitForAbsent,
  waitForFreshText,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  ANSWER_NOW_TEXT,
  MOCK_THOUGHT_TEXT,
  PROGRESS_NOTE_TEXT,
  REVIEW_FINISHED_PROMPT,
  REVIEW_LINGER_DONE,
  REVIEW_LINGER_PROMPT,
  REVIEW_LINGER_SLOW_PROMPT,
  REVIEW_NEVER_ANSWERS_PROMPT,
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
  scrollThreadBackTo,
  sendMessage,
  signUp,
  startNewAgentRun,
  startNewThread,
  waitForComposerReady,
  waitForRunDone,
  waitForRunReviews,
  waitForSubAgents,
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

const cardTitle = (reviewId: string) => `review.card.${reviewId}.title`;

/** Whether the thread's list really scrolls and `id` is inside what it shows:
 * `isDisplayed()` is true below the fold. Web and Electron. */
async function reachableInPanel(id: string): Promise<boolean> {
  return browser.execute((selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    let scroller: Element | null = el.parentElement;
    while (scroller) {
      const overflow = getComputedStyle(scroller).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    // Nothing scrolls around it: it is reachable only if it is on screen.
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.bottom <= view.bottom + 1 && rect.bottom > view.top;
  }, testIdSelector(id));
}

/**
 * Opens the review's card and checks its panel: the verdict and why, what
 * was done, how and when it ran, what the request cost, and the digest the
 * reviewer read — which only the record carries, so it proves the detail read.
 */
async function expectPanel(
  reviewId: string,
  want: { verdict: string; action: string; reason?: string; mode: string; trigger: string; step: string; task: string },
  shotName: string,
): Promise<void> {
  await scrollTo(`review.card.${reviewId}.open`);
  await tap(`review.card.${reviewId}.open`);
  await waitForFreshText('review.panel.verdict', want.verdict);
  await waitForFreshText('review.panel.action', want.action);
  if (want.reason) await waitForFreshText('review.panel.reason', want.reason);
  await waitForFreshText('review.panel.mode', want.mode);
  await waitForFreshText('review.panel.trigger', want.trigger);
  await waitForFreshText('review.panel.step', want.step);
  await waitForFreshText('review.panel.worked', 's');
  // From the record: the mock model's name, its token counts and its timing.
  await waitForFreshText('review.panel.model', 'llama', 20_000);
  await waitForFreshText('review.panel.input', 'tokens in');
  await waitForVisible('review.panel.total');
  await shot(shotName);
  const p = platform();
  if (p === 'web' || p === 'electron') {
    await waitForFreshText('review.panel.digest', want.task, 20_000);
    await waitForFreshText('review.panel.digest', '## ');
    expect(await reachableInPanel('review.panel.digest')).toBe(true);
    await shot(`${shotName}-digest`);
  } else {
    await scrollTo('review.panel.digest');
    await waitForFreshText('review.panel.digest', want.task, 20_000);
  }
  await tap('review.close');
  await waitForAbsent('review.panel.verdict');
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
      // Reviewed twice (after steps 3 and 6), and the run was told nothing.
      expect(await isVisible('progress.note')).toBe(false);
      expect(notesIn(await getMessageTexts(creds, conversationId))).toEqual([]);
      expect((await getToolResults(creds, conversationId)).length).toBe(7);
      await expectNobodyAsked();

      // Each review is a card in the thread all the same, saying what it found.
      const reviews = await waitForRunReviews(creds, conversationId, 2);
      expect(reviews.map((r) => [r.verdict, r.action, r.step])).toEqual([
        ['progressing', 'none', 3],
        ['progressing', 'none', 6],
      ]);
      await waitForFreshText(cardTitle(reviews[1].id), 'Progress check · progressing');
      await waitForFreshText(`review.card.${reviews[1].id}.meta`, 'Step 6');
      await shot(`progress-review-card-progressing-${surface}`);
      // No quiet line left over under the thread once nothing is under way.
      expect(await isVisible('run.review.status')).toBe(false);
      await expectPanel(
        reviews[1].id,
        {
          verdict: 'progressing',
          action: 'Nothing: the run carried on',
          mode: 'The run paused',
          trigger: 'Enough steps',
          step: '6',
          task: REVIEW_STEADY_PROMPT,
        },
        `progress-review-panel-progressing-${surface}`,
      );
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

      // The review that steered it and the one that had it answer are cards,
      // each above the note it wrote. The older one is read where the whole
      // list is in the tree and can be scrolled to by id: web and Electron.
      const reviews = await waitForRunReviews(creds, conversationId, 2);
      expect(reviews.map((r) => [r.verdict, r.action])).toEqual([
        ['stuck', 'steer'],
        ['stuck', 'answer'],
      ]);
      const p = platform();
      const wholeList = p === 'web' || p === 'electron';
      await waitForFreshText(cardTitle(reviews[1].id), 'Progress check · stuck · told to answer');
      if (wholeList) {
        // Rendered text is read only from what is on screen: bring it there.
        await scrollTo(cardTitle(reviews[0].id));
        await waitForFreshText(cardTitle(reviews[0].id), 'Progress check · stuck · told to change approach');
      }
      await shot(`progress-review-card-stuck-${surface}`);
      await expectPanel(
        reviews[wholeList ? 0 : 1].id,
        {
          verdict: 'stuck',
          action: wholeList ? 'Told to change approach' : 'Told to stop and answer',
          reason: 'says stuck',
          mode: 'The run paused',
          trigger: 'Enough steps',
          step: wholeList ? '3' : '6',
          task: 'review-stuck',
        },
        `progress-review-panel-stuck-${surface}`,
      );

      // From history, with the offline copy dropped, the notes read the same
      // and the cards are back where they were.
      if (wholeList) {
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
        await waitForFreshText(cardTitle(reviews[1].id), 'Progress check · stuck · told to answer');
        await scrollTo(cardTitle(reviews[0].id));
        await waitForFreshText(cardTitle(reviews[0].id), 'Progress check · stuck · told to change approach');
        // Each card sits above the note it wrote: steer card, its note, answer
        // card, its note, top to bottom.
        const tops = await browser.execute(
          (first: string, second: string, outcome: string) => {
            const top = (el: Element | null) => el?.getBoundingClientRect().top ?? Number.NaN;
            const notes = [...document.querySelectorAll(outcome)];
            return {
              steerCard: top(document.querySelector(first)),
              answerCard: top(document.querySelector(second)),
              steerNote: top(notes.find((n) => n.textContent.includes('change approach')) ?? null),
              answerNote: top(notes.find((n) => n.textContent.includes('answer now')) ?? null),
            };
          },
          testIdSelector(`review.card.${reviews[0].id}`),
          testIdSelector(`review.card.${reviews[1].id}`),
          testIdSelector('progress.note.outcome'),
        );
        expect(tops.steerCard).toBeLessThan(tops.steerNote);
        expect(tops.steerNote).toBeLessThan(tops.answerCard);
        expect(tops.answerCard).toBeLessThan(tops.answerNote);
        await shot(`progress-review-stuck-${surface}-after-reload`);
        await expectPanel(
          reviews[1].id,
          {
            verdict: 'stuck',
            action: 'Told to stop and answer',
            reason: 'says stuck',
            mode: 'The run paused',
            trigger: 'Enough steps',
            step: '6',
            task: 'review-stuck',
          },
          `progress-review-panel-stuck-${surface}-after-reload`,
        );
      }
    });
  }

  it('ends a run that is told to answer and never does, on a note that gives only the reason', async function () {
    this.timeout(3 * 60_000);
    const conversationId = await runIn(creds, 'chat', REVIEW_NEVER_ANSWERS_PROMPT);
    // Told to answer after step 6, the mock only thinks; asked once more
    // with thinking off, it only thinks again. Nothing would ever end that
    // reply, and nobody is here to press Stop: the run ends itself.
    await waitForRunDone(creds, conversationId, 120_000);
    await waitForTextInAny('progress.note.outcome', 'Ended without an answer', 60_000);
    await waitForTextInAny('progress.note.reason', 'says stuck');
    await shot('progress-review-never-answers');
    await expectNobodyAsked();

    const texts = await getMessageTexts(creds, conversationId);
    expect(texts.some((t) => t.includes(ANSWER_NOW_TEXT))).toBe(false);
    expect((await getToolResults(creds, conversationId)).length).toBe(6);
    // Steered, told to answer, asked once more, ended. Each of the last two
    // rows carries the end of the reply it cut, for the model to go on from...
    const notes = notesIn(texts);
    expect(notes).toHaveLength(4);
    expect(notes[2]).toContain('have not written one');
    expect(notes[3]).toContain('was ended here');
    for (const note of notes.slice(2)) {
      expect(note).toContain('Your reply was interrupted. Its thinking ended with:');
      expect(note).toContain(MOCK_THOUGHT_TEXT);
    }
    // ...and none of that is in a note on screen: a reader gets the reason.
    // Every note in the tree where the whole list is (web and Electron, by
    // its text content); elsewhere the ones on screen, which is all a native
    // lookup can read.
    const onScreen = async (): Promise<string[]> => {
      if (platform() === 'web' || platform() === 'electron') {
        return browser.execute(
          (selector: string) => [...document.querySelectorAll(selector)].map((el) => el.textContent),
          testIdSelector('progress.note'),
        );
      }
      const shown: string[] = [];
      for (const el of await $$(testIdSelector('progress.note')).getElements()) shown.push(await el.getText());
      return shown.filter((t) => t !== '');
    };
    const live = await onScreen();
    expect(live.some((t) => t.includes('Ended without an answer'))).toBe(true);
    for (const text of live) {
      expect(text).toContain(PROGRESS_NOTE_TEXT);
      expect(text).not.toContain(MOCK_THOUGHT_TEXT);
      expect(text).not.toContain('interrupted');
    }

    // The same from history, with the offline copy dropped.
    const p = platform();
    if (p === 'web' || p === 'electron') {
      await browser.execute(() => {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith('loxaic-cache:')) window.localStorage.removeItem(key);
        }
      });
      await browser.refresh();
      await waitForComposerReady();
      await goToSurface('chat');
      await selectThread(conversationId, 'chat');
      await waitForTextInAny('progress.note.outcome', 'Ended without an answer', 60_000);
      const reloaded = await onScreen();
      expect(reloaded.length).toBeGreaterThan(0);
      for (const text of reloaded) {
        expect(text).not.toContain(MOCK_THOUGHT_TEXT);
        expect(text).not.toContain('interrupted');
      }
      await shot('progress-review-never-answers-after-reload');
    }
  });

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
    // Its card says so, in the thread where the review is being taken; the
    // quiet line under the thread is not shown beside it.
    await waitForTextIn('chat.messageList', 'Paused to check progress', 60_000);
    expect(await isVisible('run.review.status')).toBe(false);
    await shot('progress-review-paused');
    await expectNobodyAsked();
    // The same card, finished: what the review found.
    const [review] = await waitForRunReviews(creds, conversationId, 1, 60_000);
    // The run carries on meanwhile, and on a phone the card is soon above
    // the fold, where its words cannot be read: brought back by its pressable.
    await scrollThreadBackTo(`review.card.${review.id}.open`);
    await waitForFreshText(cardTitle(review.id), 'Progress check · progressing', 30_000);
    await browser.waitUntil(async () => expectTextAbsent('Paused to check progress').then(() => true, () => false), {
      timeout: 30_000,
      timeoutMsg: 'the card still said the review was under way after it ended',
    });
    await shot('progress-review-paused-finished');
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
      await waitForTextIn('chat.messageList', 'Checking progress', 60_000);
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

    // The child was reviewed, not its parent: the review's card is in the
    // sub-agent's own transcript, and opens in the sub-agent's panel (no
    // sheet goes over another).
    expect(await waitForRunReviews(creds, conversationId, 0)).toEqual([]);
    const [child] = await waitForSubAgents(creds, conversationId, 1);
    const [review] = await waitForRunReviews(creds, child.conversation_id, 1);
    expect([review.verdict, review.action]).toEqual(['stuck', 'answer']);
    await tap(`subagent.card.${child.call_id}.open`);
    await waitForFreshText(cardTitle(review.id), 'Progress check · stuck · told to answer', 30_000);
    await shot('progress-review-subagent-card');
    await tap(`review.card.${review.id}.open`);
    await waitForFreshText('subagent.panel.review.title', 'Progress check · stuck · told to answer');
    await waitForFreshText('review.panel.verdict', 'stuck');
    await waitForFreshText('review.panel.action', 'Told to stop and answer');
    await waitForFreshText('review.panel.model', 'llama', 20_000);
    await shot('progress-review-subagent-panel');
    await tap('subagent.panel.review.back');
    await waitForAbsent('review.panel.verdict');
    await waitForVisible(`review.card.${review.id}.open`);
    await tap('subagent.close');
  });
});
