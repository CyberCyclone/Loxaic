/**
 * Planning mode always ends in a plan or questions — #199, second round.
 *
 * Whatever is asked in Planning mode, the turn ends with one of two hand-offs:
 * a plan (the panel `plan-proposal.spec.ts` covers) or questions whose answers
 * would change it. Questions open in a panel of their own, one at a time, each
 * with its options and an "Other" row to write your own; Submit sends every
 * answer as one message, still in planning, and the plan that follows opens.
 *
 * A model that answers in prose anyway is reminded once — a notice in the
 * thread, not a bubble nobody typed — and then plans.
 *
 * Sandbox-free, like the plan spec: every hand-off runs in-process.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, tap, typeInto, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  getMessageTexts,
  goToSurface,
  listConversations,
  sendMessage,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

/** No trigger words at all: planning plans it anyway. */
const ANY_PROMPT = "What's the weather like today?";
/** The mock answers "ask me" with two questions, the second multi-select
 * (MOCK_QUESTIONS in apps/server/src/inference/provider.ts). */
const QUESTIONS_PROMPT = 'Ask me what you need to know first.';
const Q1 = 'Which part should the plan cover first?';
const Q2 = 'Which checks should the plan include?';
const OTHER = 'Only the flaky ones';
/** The mock answers in prose until the server insists (MOCK_PROSE_MATCH). */
const PROSE_PROMPT = 'Answer in prose: which files matter here?';
/** Mirrors QUESTIONS_ANSWERED_PREFIX in @loxaic/types. */
const ANSWERED_PREFIX = 'Answers to your questions:';

async function newestConversationId(creds: Parameters<typeof listConversations>[0]): Promise<string> {
  const [conversation] = await listConversations(creds);
  return conversation.id;
}

/** react-native-web renders a disabled Pressable as `aria-disabled`, which
 * WebDriver's isEnabled does not read. */
async function isDisabled(id: string): Promise<boolean> {
  return (await byTestId(id).getAttribute('aria-disabled')) === 'true';
}

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

/** The footer's buttons inside the viewport — displayed is not enough, since
 * WebDriver reports a below-the-fold element as displayed. */
async function expectInView(ids: string[]): Promise<void> {
  const problems = await browser.execute((list: string[]) => {
    return list
      .map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return `${id}: missing`;
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0 ? null : `${id}: ${JSON.stringify(r)}`;
      })
      .filter(Boolean);
  }, ids);
  if (problems.length) throw new Error(`not reachable: ${problems.join('; ')}`);
}

describe('planning ends in a plan or questions', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('plans whatever is asked, with no trigger words', async function () {
    this.timeout(3 * 60_000);
    await goToSurface('agent');
    await chooseScratchWorkspace();
    await tap('agent.mode.planning');
    await sendMessage(ANY_PROMPT);

    await waitForVisible('agent.plan.panel', 90_000);
    await waitForTextIn('agent.plan.body', ANY_PROMPT);
    await shot('planning-any-prompt-plans');
    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
  });

  it('asks questions one at a time, and plans from the answers', async function () {
    this.timeout(3 * 60_000);
    await sendMessage(QUESTIONS_PROMPT);
    await waitForVisible('agent.questions.panel', 90_000);
    await waitForTextIn('agent.questions.question', Q1);
    // Nothing chosen, nothing to go on with.
    if (!(await isDisabled('agent.questions.next'))) throw new Error('Next was offered before an answer');
    await shot('questions-panel-first');

    // A short window still shows the buttons at the foot.
    const { width, height } = await browser.getWindowSize();
    await browser.setWindowSize(width, 560);
    try {
      await expectInView(['agent.questions.back', 'agent.questions.next']);
    } finally {
      await browser.setWindowSize(width, height);
    }

    await tap('agent.questions.option.0.0');
    if (await isDisabled('agent.questions.next')) throw new Error('Next stayed disabled after choosing an option');

    // Closing to look something up and coming back keeps what was chosen.
    await tap('agent.questions.close');
    await waitForGone('agent.questions.panel');
    await waitForTextIn('agent.plan.bar.label', 'Questions waiting for your answers');
    await tap('agent.plan.bar');
    await waitForTextIn('agent.questions.question', Q1);
    if (await isDisabled('agent.questions.next')) throw new Error('closing the panel threw away the answer');
    await tap('agent.questions.next');

    // The second is multi-select: an option and "Other" together.
    await waitForTextIn('agent.questions.question', Q2);
    await tap('agent.questions.option.1.1');
    await tap('agent.questions.other.1');
    await typeInto('agent.questions.otherText.1', OTHER);
    await shot('questions-panel-other');

    // Back keeps what was chosen: the first question still counts as answered.
    await tap('agent.questions.back');
    await waitForTextIn('agent.questions.question', Q1);
    if (await isDisabled('agent.questions.next')) throw new Error('going back lost the first answer');
    await tap('agent.questions.next');
    await waitForTextIn('agent.questions.question', Q2);
    await tap('agent.questions.submit');
    await waitForGone('agent.questions.panel');

    // One message carrying both answers, and the plan it was waiting for.
    const convId = await newestConversationId(creds);
    await waitForRunDone(creds, convId);
    const texts = await getMessageTexts(creds, convId);
    const answers = texts.find((t) => t.startsWith(ANSWERED_PREFIX));
    if (!answers || !answers.includes('→ The API') || !answers.includes(`→ End-to-end tests; ${OTHER}`)) {
      throw new Error(`the answers were not sent as expected: ${JSON.stringify(texts)}`);
    }
    await waitForVisible('agent.plan.panel', 30_000);
    await waitForTextIn('agent.plan.body', 'The API');
    // Answering does not leave planning.
    await waitForVisible('agent.planning.banner');
    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
    await waitForListText('2 questions · Answered');
    await shot('questions-answered-then-plan');

    // Answered questions are for reading back, not answering twice.
    await browser.execute(() => {
      const cards = document.querySelectorAll('[data-testid^="chat.questions.open."]');
      (cards[cards.length - 1] as HTMLElement | undefined)?.click();
    });
    await waitForTextIn('agent.questions.status', 'answered');
    await tap('agent.questions.close');
    await waitForGone('agent.questions.panel');
  });

  it('reminds a model that answered in prose, once, and then plans', async function () {
    this.timeout(3 * 60_000);
    await sendMessage(PROSE_PROMPT);
    await waitForVisible('agent.plan.panel', 90_000);
    await waitForTextIn('agent.plan.body', PROSE_PROMPT);
    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
    await waitForVisible('chat.message.planNudge');
    await waitForTextIn('chat.message.planNudge', 'Asked the agent to finish with a plan or questions');
    await shot('planning-prose-nudged');
  });
});
