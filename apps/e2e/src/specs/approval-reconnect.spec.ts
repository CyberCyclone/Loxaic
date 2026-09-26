/**
 * Answering an approval straight after coming back to the app (#231).
 *
 * Every return from the background replaces the chat socket (the AppState
 * handler in useChatSession closes it and reconnects), and someone comes back
 * to the app most often *because* a run is waiting on them. Two things went
 * wrong in that moment:
 *
 * - A tap on Allow while the old socket was closing sent nothing, and the
 *   dialog closed anyway. The run sat waiting for the timeout while the screen
 *   said it had been approved.
 * - Once reconnected, the new socket never heard the rest of the run. A run
 *   parked on an approval emits nothing, so the client's cursor was exactly
 *   caught up, and the server skipped attaching a live tap to a run the client
 *   "already had". The approval reached the server; its result, the next
 *   message and the next approval did not reach the screen, which looked
 *   frozen until a reload.
 *
 * On a phone the first depends on where a tap lands in a reconnect lasting
 * tens of milliseconds. On the web the page can be hidden and shown again and
 * the button clicked in one script, which lands it in the gap every time.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, testIdSelector, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, sendMessage, signUp } from '../helpers/app.ts';

/** Two approvals in a row: MOCK "write two files, asking each time" in
 * apps/e2e/fixtures/scenarios.json. */
const PROMPT = 'Write two files, asking each time.';

/** What react-native-web's AppState reads: the page goes to the background and
 * comes back, which makes the chat hook replace its socket. With `thenClick`,
 * the button is clicked in the same task, before the new socket can open. */
async function leaveAndReturn(thenClick?: string): Promise<void> {
  await browser.execute((clickSelector: string | null) => {
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    if (clickSelector) document.querySelector<HTMLElement>(clickSelector)?.click();
  }, thenClick ? testIdSelector(thenClick) : null);
}

describe('answering an approval after coming back to the app', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('keeps the dialog when the answer could not be sent, and hears the rest of the run', async function () {
    this.timeout(3 * 60_000);
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    await goToSurface('chat');
    await sendMessage(PROMPT);
    await waitForVisible('chat.approval.dialog', 60_000);
    await waitForTextIn('chat.approval.dialog', 'first.txt');

    // Clicked while the old socket is closing: nothing can be sent, so the
    // dialog stays and says why, instead of closing as if it had worked.
    await leaveAndReturn('chat.approval.allowOnce');
    await waitForTextIn('shell.toast', 'your answer was not sent');
    await waitForTextIn('chat.approval.dialog', 'first.txt');
    await shot('approval-reconnect-not-sent');

    // Reconnected: the same button now answers. The run then carries on past
    // the first file to ask about the second. (This reconnect does not prove
    // the server half: a conversation's first run is not tracked by a cursor
    // yet, so its resubscribe asks for everything and gets a tap anyway.)
    await browser.pause(2_000);
    await tap('chat.approval.allowOnce');
    await waitForTextIn('chat.approval.dialog', 'second.txt', 30_000);
    await shot('approval-reconnect-second-dialog');

    // Once more, answered after the reconnect has settled. By now the client
    // holds a cursor exactly at the run's last event, which is the reconnect
    // the server used to give no tap: without the fix in ws/delivery.ts the
    // approval lands and the end of the run never reaches the screen.
    await leaveAndReturn();
    await browser.pause(2_000);
    await tap('chat.approval.allowOnce');
    await waitForGone('chat.approval.dialog');
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const list = document.querySelector('[data-testid="chat.messageList"]');
          return !!list && (list as HTMLElement).innerText.includes('[Mock] Wrote both files.');
        }),
      { timeout: 30_000, interval: 500, timeoutMsg: 'the run never reached the screen after the reconnect' },
    );
    await shot('approval-reconnect-finished');
  });
});
