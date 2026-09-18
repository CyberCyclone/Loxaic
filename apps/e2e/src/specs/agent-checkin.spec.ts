/**
 * A run that uses up its step budget asks what to do instead of dying — #157.
 *
 * It used to end the stream with "Stopped after N tool iterations without a
 * final answer.", which rode only on `stream.end.error` — a field no client
 * ever read, and which nothing persisted. What a user saw was a run going red
 * with no reason given, and nothing at all after a reload.
 *
 * So the three assertions that matter here are: the question appears and says
 * which of the two reasons it has; the transcript stays readable behind it,
 * because reading what the agent already did is the only way to answer; and
 * each of the three answers leads somewhere different and visibly ends the
 * pause.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  ANSWER_NOW_TEXT,
  CHECKIN_ANSWER_NUDGE,
  CHECKIN_SCENARIO_DONE,
  CHECKIN_SCENARIO_PROMPT,
  LOOP_SCENARIO_PROMPT,
  chooseScratchWorkspace,
  getMessageTexts,
  getToolResults,
  goToSurface,
  listConversations,
  patchPrefs,
  selectThread,
  sendMessage,
  signUp,
  startNewAgentRun,
  waitForRunDone,
} from '../helpers/app.ts';

describe('a run that pauses to ask whether to keep going', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  after(async () => {
    // Back to the shipped cadence: prefs are per-user and this account is
    // this spec's own, but leaving a 1 behind would make any later reuse of
    // it behave very strangely.
    await patchPrefs(creds, { maxIterations: 100 });
  });

  it('asks at the end of the budget, and carries on when told to', async function () {
    this.timeout(3 * 60_000);
    // Two steps, and a scenario with exactly two — so the window ends on the
    // last step that had work to do and the run asks exactly once.
    await patchPrefs(creds, { maxIterations: 2 });

    await goToSurface('agent');
    await chooseScratchWorkspace();
    await tap('agent.mode.auto');
    await sendMessage(CHECKIN_SCENARIO_PROMPT);

    await waitForVisible('checkin.banner', 90_000);
    // "steps", not "loop": nothing is repeating, the window simply ran out.
    await waitForTextIn('checkin.reason', 'steps');
    await waitForTextIn('agent.run.status', 'Waiting for you');
    await shot('checkin-budget-banner');

    // The whole point of a banner rather than a dialog: the transcript is
    // what the decision is made from, so it has to still be there. Scrolling
    // it must not disturb the question.
    await browser.execute(() => {
      const list = document.querySelector('[data-testid="chat.messageList"]');
      let el: Element | null = list;
      while (el) {
        const o = getComputedStyle(el).overflowY;
        if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) {
          el.scrollTop = 0;
          return;
        }
        el = el.parentElement;
      }
      throw new Error('message list is not scrollable behind the check-in banner');
    });
    await waitForVisible('checkin.banner');
    await shot('checkin-transcript-still-readable');

    await tap('checkin.continue');
    await waitForGone('checkin.banner');
    await waitForTextIn('chat.messageList', CHECKIN_SCENARIO_DONE, 90_000);
    await waitForTextIn('agent.run.status', 'Done');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    // Both steps ran: "keep going" granted a further window rather than
    // merely dismissing the question.
    const results = await getToolResults(creds, conversation.id);
    if (results.length !== 2) {
      throw new Error(`expected both steps to have run, got ${String(results.length)}`);
    }
    await shot('checkin-keep-going-finished');
  });

  it('wraps up with what it has when told to answer now, and says so after a reload', async function () {
    this.timeout(3 * 60_000);
    // One step, so the run asks before the scenario's second step.
    await patchPrefs(creds, { maxIterations: 1 });

    await goToSurface('agent');
    await startNewAgentRun();
    await chooseScratchWorkspace();
    await tap('agent.mode.auto');
    await sendMessage(CHECKIN_SCENARIO_PROMPT);

    await waitForVisible('checkin.banner', 90_000);
    await tap('checkin.answer');
    await waitForGone('checkin.banner');

    // The mock's own evidence that the final request really went out with
    // `tool_choice: "none"` — it answers differently when it may not call a
    // tool at all.
    await waitForTextIn('chat.messageList', ANSWER_NOW_TEXT, 90_000);
    await waitForTextIn('agent.run.status', 'Done');
    await waitForVisible('chat.message.checkinNudge');
    await shot('checkin-answer-now');

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    // The second step never ran — "answer now" is not "finish quietly".
    const results = await getToolResults(creds, conversation.id);
    if (results.length !== 1) {
      throw new Error(`expected only the first step to have run, got ${String(results.length)}`);
    }

    // #157's other half: the reason has to survive a reload, not live only in
    // the events of a socket that has since closed. Two separate facts, so two
    // separate checks — the row is stored (the API returns the instruction
    // verbatim, which is also what the next turn replays), and the client
    // still renders it as a notice rather than as something the user typed.
    const texts = await getMessageTexts(creds, conversation.id);
    if (!texts.includes(CHECKIN_ANSWER_NUDGE)) {
      throw new Error(`the instruction was not persisted: ${JSON.stringify(texts)}`);
    }
    await browser.refresh();
    await goToSurface('agent');
    await selectThread(conversation.id, 'agent');
    await waitForVisible('chat.message.checkinNudge', 30_000);
    await shot('checkin-answer-now-after-reload');
  });

  it('asks early when it notices itself repeating, and stops when told to', async function () {
    this.timeout(3 * 60_000);
    // Deliberately generous, so nothing here can be the budget: the detector
    // speaks at the third identical step, a long way short of 100.
    await patchPrefs(creds, { maxIterations: 100 });

    await goToSurface('agent');
    await startNewAgentRun();
    await chooseScratchWorkspace();
    await tap('agent.mode.auto');
    await sendMessage(LOOP_SCENARIO_PROMPT);

    await waitForVisible('checkin.banner', 90_000);
    await waitForTextIn('checkin.reason', 'loop');
    // The step count proves this was the loop detector and not the window.
    await waitForTextIn('agent.run.status', 'Waiting for you · 3/100');
    await shot('checkin-loop-banner');

    await tap('checkin.stop');
    await waitForGone('checkin.banner');
    await waitForTextIn('agent.run.status', 'Done', 60_000);

    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    // The three steps that ran before the question are real work and stay;
    // the fourth never ran.
    const results = await getToolResults(creds, conversation.id);
    if (results.length !== 3) {
      throw new Error(`expected the three completed steps to remain, got ${String(results.length)}`);
    }
    await shot('checkin-loop-stopped');
  });
});
