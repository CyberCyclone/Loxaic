/**
 * A long thread reopens on its newest messages, and scrolls back to its
 * oldest — #213.
 *
 * The history route used to return the *oldest* 200 rows, so a thread that
 * had grown past that reloaded without the replies anyone came back for. Now
 * it opens on the newest page, and the older pages load as the list scrolls
 * back.
 *
 * Each case sends a short first message and then one turn of more than 200
 * rows (the generated long-history scenario, scripts/long-history.ts). A page
 * holds whole turns, so after a reload the first page is exactly that long
 * turn, and the first message is only reachable by paging back — which is
 * what the case checks, on both surfaces, because each has its own session
 * hook.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  chooseScratchWorkspace,
  goToSurface,
  listConversations,
  patchPrefs,
  selectThread,
  sendMessage,
  signUp,
  startNewThread,
  waitForRunDone,
} from '../helpers/app.ts';
import { LONG_HISTORY_DONE, LONG_HISTORY_PROMPT, LONG_HISTORY_STEPS } from '../../scripts/long-history.ts';

/** Whether the message list's own text contains `text`. Scoped to the list,
 * because the thread list names a conversation after its first message. */
async function listContains(text: string): Promise<boolean> {
  return browser.execute((t: string) => {
    const list = document.querySelector('[data-testid="chat.messageList"]');
    return !!list && (list as HTMLElement).innerText.includes(t);
  }, text);
}

/**
 * Scrolls back the way a person does — real wheel input over the list — until
 * the list holds `text`.
 *
 * Deliberately not `scrollIntoView`. react-native-web reports drags only for
 * touch, so the list has to learn from wheel events that the reader has moved
 * away from the newest message; a programmatic scroll sends none, and a first
 * version of this spec passed while the list threw the reader back to the
 * bottom each time an older page arrived.
 */
async function scrollBackTo(text: string): Promise<void> {
  const list = byTestId('chat.messageList');
  await browser.waitUntil(
    async () => {
      if (await listContains(text)) return true;
      await browser.action('wheel').scroll({ origin: list, deltaY: -1500, duration: 150 }).perform();
      return false;
    },
    { timeout: 90_000, interval: 400, timeoutMsg: `scrolling back never reached "${text}"` },
  );
}

/** Whether an element containing `text` is inside the list's visible box. */
async function onScreen(text: string): Promise<boolean> {
  return browser.execute((t: string) => {
    const list = document.querySelector('[data-testid="chat.messageList"]');
    if (!list) return false;
    const box = list.getBoundingClientRect();
    const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.includes(t) || !n.parentElement) continue;
      const r = n.parentElement.getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom) return true;
    }
    return false;
  }, text);
}

describe('a thread longer than one page of history', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    // The scenario is one turn of LONG_HISTORY_STEPS steps; the default
    // window of 100 would pause it at a check-in halfway.
    await patchPrefs(creds, { maxIterations: LONG_HISTORY_STEPS + 20 });
  });

  after(async () => {
    await patchPrefs(creds, { maxIterations: 100 });
  });

  for (const surface of ['agent', 'chat'] as const) {
    it(`reopens a long ${surface} thread on its newest messages, and pages back to the first`, async function () {
      this.timeout(4 * 60_000);
      const first = `The very first ${surface} message, sent before the long turn.`;

      await goToSurface(surface);
      if (surface === 'agent') {
        await chooseScratchWorkspace();
        await tap('agent.mode.auto');
      } else {
        await startNewThread('chat');
      }
      await sendMessage(first);
      const [conversation] = await listConversations(creds);
      await waitForRunDone(creds, conversation.id);

      await sendMessage(LONG_HISTORY_PROMPT);
      await waitForRunDone(creds, conversation.id, 180_000);
      await waitForTextIn('chat.messageList', LONG_HISTORY_DONE, 60_000);

      await browser.refresh();
      await goToSurface(surface);
      await selectThread(conversation.id, surface);
      // The newest reply is what the thread opens on...
      await waitForTextIn('chat.messageList', LONG_HISTORY_DONE, 30_000);
      // ...and the first message is not loaded at all until asked for.
      await waitForVisible('chat.history.loadOlder', 30_000);
      if (await listContains(first)) {
        throw new Error('the first message was loaded with the newest page — the thread is not paged');
      }
      await shot(`history-${surface}-newest-page`);

      await scrollBackTo(first);
      // The whole thread is loaded now, so there is nothing older to offer.
      await waitForGone('chat.history.loadOlder', 30_000);
      // And the reader is still where they scrolled to: nothing snapped the
      // list back to the newest message when the page arrived.
      await browser.action('wheel').scroll({ origin: byTestId('chat.messageList'), deltaY: -3000, duration: 150 }).perform();
      await browser.pause(1_000);
      if (!(await onScreen(first))) {
        throw new Error('the first message loaded, but the list did not stay scrolled back to it');
      }
      await shot(`history-${surface}-scrolled-back`);
    });
  }
});
