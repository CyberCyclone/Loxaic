/**
 * Answering an approval straight after coming back to the app (#231).
 *
 * Every return from the background replaces the chat socket (the AppState
 * handler in useChatSession closes it and reconnects), and someone comes back
 * to the app most often *because* a run is waiting on them. What went wrong in
 * that moment:
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
 * - Nothing said a reconnect was happening, and nothing was blocked during it.
 *   Now input waits for the new socket at once, and the "Reconnecting" banner
 *   appears only if that takes longer than a healthy reconnect — so an
 *   ordinary return shows nothing, and a slow one explains the greyed buttons.
 *
 * On a phone, where a tap lands in a reconnect of tens of milliseconds is luck.
 * On the web the page can be hidden and shown again and the button clicked in
 * one script, which lands it in the gap every time; and the new socket's
 * `open` can be held back to make a reconnect slow on purpose.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, testIdSelector, tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, sendMessage, signUp } from '../helpers/app.ts';

/** Two approvals in a row: MOCK "write two files, asking each time" in
 * apps/e2e/fixtures/scenarios.json. */
const PROMPT = 'Write two files, asking each time.';
const BANNER = 'shell.offlineBanner';
const ALLOW = 'chat.approval.allowOnce';

interface ReturnOptions {
  /** Clicked in the same task as the return, before the new socket can open. */
  click?: string;
  /** Holds back the new socket's `open` this long: a slow reconnect. */
  holdOpenMs?: number;
  /** Watches for the offline banner this long after the return. */
  watchMs?: number;
}

/** The page goes to the background and comes back — what react-native-web's
 * AppState reads — which makes the chat hook replace its socket. Resolves
 * with whether the offline banner appeared at any point while watched. */
async function leaveAndReturn(opts: ReturnOptions = {}): Promise<{ bannerSeen: boolean }> {
  return browser.execute(
    async (clickSelector: string | null, holdOpenMs: number, watchMs: number, bannerSelector: string) => {
      if (holdOpenMs > 0) {
        const Native = window.WebSocket;
        class Held extends Native {
          set onopen(handler: ((this: WebSocket, ev: Event) => unknown) | null) {
            const self = this;
            super.onopen = handler
              ? (ev: Event) => { setTimeout(() => handler.call(self, ev), holdOpenMs); }
              : null;
          }
          get onopen() {
            return super.onopen;
          }
        }
        window.WebSocket = Held;
        setTimeout(() => { window.WebSocket = Native; }, holdOpenMs);
      }
      let state: DocumentVisibilityState = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      if (clickSelector) document.querySelector<HTMLElement>(clickSelector)?.click();

      // Any commit that puts the banner in the DOM, however briefly — a
      // poll can fall between two renders and miss a flash.
      let bannerSeen = !!document.querySelector(bannerSelector);
      const observer = new MutationObserver(() => {
        if (document.querySelector(bannerSelector)) bannerSeen = true;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      await new Promise((r) => setTimeout(r, watchMs));
      observer.disconnect();
      return { bannerSeen };
    },
    opts.click ? testIdSelector(opts.click) : null,
    opts.holdOpenMs ?? 0,
    opts.watchMs ?? 0,
    testIdSelector(BANNER),
  );
}

async function isDisabled(id: string): Promise<boolean> {
  return browser.execute(
    (selector: string) => document.querySelector(selector)?.getAttribute('aria-disabled') === 'true',
    testIdSelector(id),
  );
}

/** Re-queried every time: answering one approval unmounts its dialog and the
 * next mounts a new one, and waitForTextIn keeps the element it found first. */
async function waitForDialogText(text: string, timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector: string, t: string) => document.querySelector(selector)?.textContent?.includes(t) ?? false,
        testIdSelector('chat.approval.dialog'),
        text,
      ),
    { timeout, interval: 250, timeoutMsg: `expected an approval dialog showing "${text}"` },
  );
}

describe('answering an approval after coming back to the app', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  it('waits for the new connection, says so only when it is slow, and hears the rest of the run', async function () {
    this.timeout(3 * 60_000);
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    await goToSurface('chat');
    await sendMessage(PROMPT);
    await waitForVisible('chat.approval.dialog', 60_000);
    await waitForTextIn('chat.approval.dialog', 'first.txt');

    // An ordinary return, with Allow clicked before the new socket opens: the
    // answer cannot be sent, so the dialog stays and says why. The reconnect
    // is held to 150 ms, a phone's rather than localhost's few, and still
    // inside the grace period — so no banner may appear, not even for a frame.
    const quick = await leaveAndReturn({ click: ALLOW, holdOpenMs: 150, watchMs: 1_500 });
    if (quick.bannerSeen) throw new Error('an ordinary return flashed the offline banner');
    await waitForTextIn('shell.toast', 'Reconnecting to your server');
    await waitForTextIn('chat.approval.dialog', 'first.txt');
    await shot('approval-reconnect-not-sent');

    // Reconnected: the same button answers, and the run carries on to ask
    // about the second file. (Not the server half's test: a conversation's
    // first run has no cursor yet, so this resubscribe asks for everything.)
    await tap(ALLOW);
    await waitForDialogText('second.txt');
    await shot('approval-reconnect-second-dialog');

    // A slow return: the buttons wait at once, and once the grace period has
    // passed the banner and the dialog both say it is reconnecting.
    await leaveAndReturn({ holdOpenMs: 3_000 });
    if (!(await isDisabled(ALLOW))) throw new Error('Allow was pressable before the new socket opened');
    await waitForTextIn(BANNER, 'Reconnecting to your server', 2_000);
    await waitForTextIn('chat.approval.reconnecting', 'Reconnecting to your server', 2_000);
    await shot('approval-reconnect-slow');

    // Open again: the banner and the note go, and Allow answers. The client
    // now holds a cursor exactly at the run's last event — the reconnect the
    // server used to give no tap — so without the fix in ws/delivery.ts the
    // approval lands and the end of the run never reaches the screen.
    await waitForGone(BANNER, 10_000);
    await waitForGone('chat.approval.reconnecting', 5_000);
    if (await isDisabled(ALLOW)) throw new Error('Allow stayed disabled after the socket opened');
    await tap(ALLOW);
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
