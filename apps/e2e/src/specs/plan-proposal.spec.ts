/**
 * A planning run hands its plan over in a full-height panel — #199.
 *
 * The plan used to be the last prose message of a planning run: hard to read,
 * and nothing to press. Planning mode now ends its turn with `propose_plan`,
 * the panel opens by itself on a plan nobody has answered, and the buttons at
 * its foot are the decision:
 *
 * - **Offer suggestion** stays in planning, and the revised plan opens the
 *   panel again when it arrives;
 * - **Reject** says so, and stays in planning — the agent answers it with
 *   questions about what to do instead, never with another plan;
 * - **Accept** leaves planning for the Default mode (named on the button), or
 *   for whichever mode its dropdown picks, on whichever model was chosen for
 *   the work.
 *
 * Until a plan is accepted or rejected, closing the panel leaves a bar above
 * the toolbar; the newest plan is always in the ⋮ menu; and all of it is read
 * from stored messages, so a reload reopens a pending plan and keeps a decided
 * one's status.
 *
 * Sandbox-free: the mock's plan call runs in-process, and nothing here writes.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, tap, typeInto, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  assistantModels,
  chooseScratchWorkspace,
  getMessageTexts,
  goToSurface,
  listConversations,
  selectThread,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

/** The mock answers "propose a plan" with a `propose_plan` call — offered in
 * planning mode only — whose plan quotes the prompt it answered, so a
 * revision is visibly a different plan (apps/server/src/inference/provider.ts). */
const PLAN_PROMPT = 'Look around, then propose a plan.';
const SUGGESTION = 'Run the tests first, then propose a plan again.';
/** Mirrors PLAN_ACCEPTED_MESSAGE / PLAN_REJECTED_MESSAGE in @loxaic/types. */
const ACCEPTED = 'I accept this plan. Go ahead and implement it.';
const REJECTED = "I'm rejecting this plan — don't implement it.";
/** The mock's second model, for running the work on something other than
 * what planned it. */
const EXECUTION_MODEL = 'qwen2.5-14b-instruct';

/**
 * Waits for the message list's text to contain `text`. `innerText` rather
 * than WebDriver's getText, which leaves out a card scrolled just out of the
 * list's view — true of the first plan once a revision is below it.
 */
async function waitForListText(text: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((t: string) => {
        const list = document.querySelector('[data-testid="chat.messageList"]');
        return !!list && (list as HTMLElement).innerText.includes(t);
      }, text),
    { timeout: 30_000, interval: 500, timeoutMsg: `expected "${text}" in the message list` },
  );
}

/**
 * Back to `convId` after a reload. The app restores the open thread by
 * itself, and when its newest plan is pending the panel opens over it at once
 * — which is the behaviour under test, and also covers the sidebar a
 * navigation would click. So only navigate if the thread did not come back.
 */
async function reopenAfterReload(convId: string, expectPanel: boolean): Promise<void> {
  const restored = await byTestId('agent.plan.panel')
    .waitForDisplayed({ timeout: expectPanel ? 15_000 : 3_000 })
    .then(() => true, () => false);
  if (restored) return;
  await goToSurface('agent');
  await selectThread(convId, 'agent');
}

async function newestConversationId(creds: Parameters<typeof listConversations>[0]): Promise<string> {
  const [conversation] = await listConversations(creds);
  return conversation.id;
}

/**
 * The panel's footer is the point of it, so "displayed" is not enough: a
 * WebDriver visibility check passes for a button below the fold. On a short
 * window, the buttons' rects must be inside the viewport and the body — not
 * the sheet — must be what scrolls.
 */
async function expectFooterReachable(): Promise<void> {
  const verdict = await browser.execute(() => {
    const inView = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return `${id}: missing`;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0 ? null : `${id}: ${JSON.stringify(r)}`;
    };
    const problems = ['agent.plan.accept', 'agent.plan.suggest', 'agent.plan.reject'].map(inView).filter(Boolean);
    const body = document.querySelector('[data-testid="agent.plan.body"]');
    let scrolls = false;
    for (let el = body; el; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) {
        scrolls = true;
        break;
      }
      if (el.getAttribute('data-testid') === 'agent.plan.panel') break;
    }
    if (!scrolls) problems.push('the plan body does not scroll');
    return problems;
  });
  if (verdict.length) throw new Error(`the plan panel's decision is not reachable: ${verdict.join('; ')}`);
}

describe('reviewing a proposed plan', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('opens by itself, stays reachable on a short window, and keeps a bar once closed', async function () {
    this.timeout(3 * 60_000);
    await goToSurface('agent');
    await chooseScratchWorkspace();
    await tap('agent.mode.planning');
    await sendMessage(PLAN_PROMPT);

    await waitForVisible('agent.plan.panel', 90_000);
    await waitForTextIn('agent.plan.body', PLAN_PROMPT);
    // A fresh device's Default mode is Manual.
    await waitForTextIn('agent.plan.accept', 'Accept · Manual');
    await shot('plan-panel-proposed');

    const { width, height } = await browser.getWindowSize();
    await browser.setWindowSize(width, 560);
    try {
      await expectFooterReachable();
      await shot('plan-panel-short-window');
    } finally {
      await browser.setWindowSize(width, height);
    }

    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
    await waitForTextIn('agent.plan.bar', 'Plan ready for review');
    await shot('plan-bar-after-close');
    await tap('agent.plan.bar');
    await waitForVisible('agent.plan.panel');
  });

  it('sends a suggestion, and opens the revised plan when it arrives', async function () {
    this.timeout(3 * 60_000);
    await tap('agent.plan.suggest');
    await typeInto('agent.plan.suggestion.input', SUGGESTION);
    await shot('plan-panel-suggestion');
    await tap('agent.plan.suggestion.send');
    await waitForGone('agent.plan.panel');

    // The revision is a new plan, pending, which opens by itself.
    await waitForVisible('agent.plan.panel', 90_000);
    await waitForTextIn('agent.plan.body', SUGGESTION);
    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
    await waitForListText('Replaced by a newer plan');
    await waitForListText('Awaiting review');
    // A suggestion never leaves planning.
    await waitForVisible('agent.planning.banner');
    await shot('plan-cards-after-suggestion');
  });

  it('rejects from the menu, stays in planning, and is asked what to do instead', async function () {
    this.timeout(3 * 60_000);
    await tap('agent.header.menu');
    await tap('agent.header.viewPlan');
    await waitForVisible('agent.plan.panel');
    await tap('agent.plan.reject');
    await waitForGone('agent.plan.panel');

    const convId = await newestConversationId(creds);
    await waitForRunDone(creds, convId);
    await waitForVisible('agent.planning.banner');
    const texts = await getMessageTexts(creds, convId);
    if (!texts.some((t) => t.startsWith(REJECTED))) {
      throw new Error(`the rejection was not sent: ${JSON.stringify(texts)}`);
    }
    // Not another plan: questions, which open by themselves like one.
    await waitForVisible('agent.questions.panel', 30_000);
    await tap('agent.questions.close');
    await waitForGone('agent.questions.panel');
    await waitForTextIn('agent.plan.bar.label', 'Questions waiting for your answers');
    await waitForListText('Proposed plan · Rejected');
    await shot('plan-rejected-then-questions');
    // The menu follows the newest item, which is now the questions.
    await tap('agent.header.menu');
    await waitForTextIn('agent.header.viewPlan', 'View questions');
    await tap('agent.header.viewPlan');
    await waitForVisible('agent.questions.panel');
    await tap('agent.questions.close');
    await waitForGone('agent.questions.panel');
  });

  it('accepts in Auto from the dropdown, on a chosen model, and reopens a pending plan after a reload', async function () {
    this.timeout(4 * 60_000);
    await sendMessage(PLAN_PROMPT);
    await waitForVisible('agent.plan.panel', 90_000);

    // A reload before deciding: the plan is still pending, so it opens again.
    const convId = await newestConversationId(creds);
    await waitForRunDone(creds, convId);
    await browser.refresh();
    await reopenAfterReload(convId, true);
    await waitForVisible('agent.plan.panel', 30_000);
    // The selector is this device's, and a reload resets it; put it back in
    // Planning so that Accept leaving it is something this case can see.
    await tap('agent.plan.close');
    await tap('agent.mode.planning');
    await waitForVisible('agent.planning.banner');
    await tap('agent.plan.bar');
    await waitForVisible('agent.plan.panel');

    // The work runs on a different model from the planning — chosen here,
    // with the panel handing over to the model list and coming back.
    await tap('agent.plan.model');
    await waitForVisible('models.dialog');
    await tap(`models.row.${EXECUTION_MODEL}`);
    await waitForGone('models.dialog');
    await waitForVisible('agent.plan.panel');
    await waitForTextIn('agent.plan.model', EXECUTION_MODEL);
    await shot('plan-panel-model-chosen');

    // The dropdown beside Accept: either mode, whatever the Default is, and
    // choosing one accepts at once.
    await tap('agent.plan.accept.more');
    await waitForVisible('agent.plan.accept.menu');
    await shot('plan-accept-menu');
    await tap('agent.plan.accept.auto');
    await waitForGone('agent.plan.panel');
    // Accepting is what leaves planning mode — the banner goes with it — and
    // this time for Auto, not the Default (Manual).
    await waitForGone('agent.planning.banner', 20_000);
    await browser.waitUntil(async () => (await byTestId('agent.mode.auto').getAttribute('aria-selected')) === 'true', {
      timeout: 10_000,
      timeoutMsg: 'accepting from the dropdown did not switch to Auto',
    });
    await waitForRunDone(creds, convId);
    const texts = await getMessageTexts(creds, convId);
    if (!texts.includes(ACCEPTED)) throw new Error(`the acceptance was not sent: ${JSON.stringify(texts)}`);
    const models = await assistantModels(creds, convId);
    if (models.at(-1) !== EXECUTION_MODEL) {
      throw new Error(`the accepted plan ran on ${String(models.at(-1))}, not ${EXECUTION_MODEL}`);
    }
    await shot('plan-accepted');

    // A decided plan keeps its status across a reload, and does not reopen.
    await browser.refresh();
    await reopenAfterReload(convId, false);
    // Decided, so it does not open by itself.
    if (await byTestId('agent.plan.panel').isDisplayed().catch(() => false)) {
      throw new Error('an accepted plan opened its panel again after a reload');
    }
    await waitForListText(ACCEPTED);
    await tap('agent.header.menu');
    await tap('agent.header.viewPlan');
    await waitForTextIn('agent.plan.status', 'accepted');
    await shot('plan-panel-after-reload');
  });
});
