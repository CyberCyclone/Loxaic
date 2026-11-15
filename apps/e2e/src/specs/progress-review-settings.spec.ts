/**
 * The Approvals & progress screen: the progress review's settings save to the
 * server and read back, the reviewer's instructions can be edited and reset —
 * and what is typed there is what the reviewer is given.
 *
 * Reachability is asserted, not visibility: WebDriver calls an element past
 * the viewport edge "displayed", so a visibility check passes whether or not
 * anything can scroll to it (see apps/e2e/AGENTS.md).
 */
import { browser } from '@wdio/globals';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import {
  closeKeyboard,
  fieldValue,
  platform,
  scrollTo,
  tap,
  testIdSelector,
  typeInto,
  waitForFreshText,
  waitForTextIn,
  waitForVisible,
} from '../helpers/selectors.ts';
import {
  REVIEW_STUCK_PROMPT,
  closeThreadKeyboard,
  getMessageTexts,
  revealInSettings,
  goToSurface,
  listConversations,
  openSettings,
  patchPrefs,
  sendMessage,
  signUp,
  startNewThread,
  waitForRunDone,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { getWindowSize, setWindowSize } from '../helpers/window.ts';

const CUSTOM = 'Custom drill reviewer: call it stuck the moment it repeats a step.';

async function prefs(creds: { email: string; password: string }): Promise<Record<string, unknown>> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/prefs`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`[e2e] GET prefs failed (${String(res.status)})`);
  return (await res.json()) as Record<string, unknown>;
}

async function waitForPref(creds: { email: string; password: string }, key: string, value: unknown): Promise<void> {
  await browser.waitUntil(async () => (await prefs(creds))[key] === value, {
    timeout: 10_000,
    interval: 250,
    timeoutMsg: `expected ${key} to be saved as ${JSON.stringify(value)}`,
  });
}

/** Whether an element's nearest scrolling ancestor can bring it into view. */
async function reachability(id: string): Promise<{ found: boolean; overflowing: boolean; scrollable: boolean }> {
  return browser.execute((selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return { found: false, overflowing: false, scrollable: false };
    let node = el.parentElement;
    let overflowing = false;
    while (node) {
      if (node.scrollHeight > node.clientHeight) overflowing = true;
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        return { found: true, overflowing, scrollable: true };
      }
      node = node.parentElement;
    }
    return { found: true, overflowing, scrollable: false };
  }, testIdSelector(id));
}

async function openScreen(): Promise<void> {
  await openSettings();
  await revealInSettings('settings.nav.checkins');
  await tap('settings.nav.checkins');
  await waitForVisible('checkins.progressReview');
}

describe('the progress review settings', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  after(async () => {
    await patchPrefs(creds, { progressReview: true, progressCheckMs: null, progressCheckSteps: null, progressReviewPrompt: null });
  });

  it('opens on the review, on by default, with the server defaults named', async () => {
    await openScreen();
    await scrollTo('settings.progressCheck.default');
    await waitForTextIn('settings.progressCheck.default', 'Server default (');
    // The whole label: on a phone the text is matched anywhere on screen, and
    // the interval's chip above starts the same way.
    const steps = ((await prefs(creds)).serverDefaults as { progressCheckSteps: number }).progressCheckSteps;
    await scrollTo('settings.progressSteps.default');
    await waitForTextIn('settings.progressSteps.default', `Server default (${String(steps)})`);
    await shot('progress-review-settings');
  });

  it('saves each setting to the server', async () => {
    await scrollTo('settings.progressCheck.900000');
    await tap('settings.progressCheck.900000');
    await waitForPref(creds, 'progressCheckMs', 900_000);
    await scrollTo('settings.progressSteps.50');
    await tap('settings.progressSteps.50');
    await waitForPref(creds, 'progressCheckSteps', 50);
    await scrollTo('settings.progressCheck.default');
    await tap('settings.progressCheck.default');
    await waitForPref(creds, 'progressCheckMs', null);
    await scrollTo('settings.progressReview.toggle');
    await tap('settings.progressReview.toggle');
    await waitForPref(creds, 'progressReview', false);
    await tap('settings.progressReview.toggle');
    await waitForPref(creds, 'progressReview', true);
  });

  it('edits the reviewer instructions: unsaved until saved, kept, and reset', async function () {
    this.timeout(2 * 60_000);
    await scrollTo('settings.reviewPrompt.input');
    // The built-in instructions to start from, not an empty box.
    if (!(await fieldValue('settings.reviewPrompt.input')).includes('You are checking on an AI agent')) {
      throw new Error('the editor does not start from the built-in instructions');
    }
    await typeInto('settings.reviewPrompt.input', CUSTOM);
    await closeKeyboard();
    await scrollTo('settings.reviewPrompt.state');
    await waitForFreshText('settings.reviewPrompt.state', 'Unsaved changes');
    // Typed is not saved.
    expect((await prefs(creds)).progressReviewPrompt).toBeNull();
    await shot('progress-review-settings-unsaved');

    await scrollTo('settings.reviewPrompt.save');
    await tap('settings.reviewPrompt.save');
    await waitForFreshText('settings.reviewPrompt.state', 'Saved');
    await waitForPref(creds, 'progressReviewPrompt', CUSTOM);
    await shot('progress-review-settings-saved');

    const p = platform();
    if (p === 'web' || p === 'electron') {
      // A reload comes back on this screen, which has no composer.
      await browser.refresh();
      await waitForVisible('checkins.progressReview', 30_000);
      await scrollTo('settings.reviewPrompt.input');
      if ((await fieldValue('settings.reviewPrompt.input')) !== CUSTOM) throw new Error('the saved instructions did not come back');
    }

    await scrollTo('settings.reviewPrompt.reset');
    await tap('settings.reviewPrompt.reset');
    await waitForPref(creds, 'progressReviewPrompt', null);
    await browser.waitUntil(async () => (await fieldValue('settings.reviewPrompt.input')).includes('You are checking on an AI agent'), {
      timeout: 10_000,
      timeoutMsg: 'Reset did not bring back the built-in instructions',
    });
  });

  it('hands the reviewer what was typed', async function () {
    this.timeout(3 * 60_000);
    await patchPrefs(creds, { progressReviewPrompt: CUSTOM, progressCheckSteps: 3 });
    await goToSurface('chat');
    await startNewThread('chat');
    await sendMessage(REVIEW_STUCK_PROMPT);
    await closeThreadKeyboard();
    // The mock reviewer quotes the start of its instructions in its reason.
    await waitForFreshText('progress.note.reason', 'Custom drill reviewer', 90_000);
    await shot('progress-review-custom-instructions');
    const [conversation] = await listConversations(creds);
    await waitForRunDone(creds, conversation.id);
    const notes = (await getMessageTexts(creds, conversation.id)).filter((t) => t.startsWith('[Progress check] '));
    if (!notes.every((n) => n.includes('Custom drill reviewer'))) throw new Error('a note came from other instructions');
  });

  it('can scroll to the instructions on a short window', async function () {
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();
    await openScreen();
    const before = await getWindowSize();
    await setWindowSize(before.width, 500);
    try {
      const verdict = await reachability('settings.reviewPrompt.save');
      if (!verdict.found) throw new Error('the Save button is not rendered');
      if (!verdict.overflowing) throw new Error('window was not short enough to test scrolling');
      if (!verdict.scrollable) throw new Error('the Save button is past the fold with nothing able to scroll to it');
      const inView = await browser.execute((selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }, testIdSelector('settings.reviewPrompt.save'));
      if (!inView) throw new Error('the Save button could not be brought into view');
      await shot('progress-review-settings-scrolled');
    } finally {
      await setWindowSize(before.width, before.height);
    }
  });
});
