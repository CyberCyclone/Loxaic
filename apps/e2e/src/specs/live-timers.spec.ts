/**
 * Live counters time what they sit beside — the newest message — not the run.
 *
 * An agent turn is many messages, one per tool iteration, and every counter
 * used to count from the run's start: fifty iterations into a turn on the
 * beta, a reply seconds old read "Thinking… 1955s". Here a turn of seven
 * requests, eight seconds each, is far enough in that the two readings cannot
 * be mistaken: the run is over twenty seconds old while the newest request has
 * been going for under eight.
 *
 * Both ways in: live, and after a fresh start in the middle of the turn — the
 * snapshot path, which converts the message's start with the server's clock.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, platform, tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  LONG_TURN_PROMPT,
  elapsedSeconds,
  goToSurface,
  relaunchApp,
  selectThread,
  sendInNewRun,
  signUp,
  waitForRunDone,
} from '../helpers/app.ts';

const MODEL = 'llama-3.1-8b-instruct';

/**
 * What the newest message's counter reads, in seconds. Each of the turn's
 * requests sits on the typing indicator for the mock's eight seconds; between
 * them, for a moment, there is none — so this waits for one to be on screen.
 */
async function readNewestCounter(): Promise<number> {
  let seconds = Number.NaN;
  await browser.waitUntil(
    async () => {
      seconds = elapsedSeconds(await byTestId('chat.typing.elapsed').getText().catch(() => ''));
      return !Number.isNaN(seconds);
    },
    { timeout: 20_000, interval: 250, timeoutMsg: 'no live counter appeared on the newest message' },
  );
  return seconds;
}

describe('live counters', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    // A counter ticks ten times a second, and UiAutomator2 waits for the UI to
    // go idle before every query — see subagents.spec.ts.
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 0 });
  });

  after(async () => {
    if (platform() === 'android') await browser.updateSettings({ waitForIdleTimeout: 10_000 });
  });

  it('times the newest message of a long turn, not the whole turn — live and after a fresh start', async function () {
    this.timeout(4 * 60_000);

    await goToSurface('agent');
    await tap('agent.mode.auto');
    await waitForTextIn('composer.model', MODEL, 30_000);
    const sentAt = Date.now();
    const convId = await sendInNewRun(creds, LONG_TURN_PROMPT);

    // Three requests in: the run is well past twenty seconds old.
    await browser.waitUntil(() => Promise.resolve(Date.now() - sentAt > 22_000), { timeout: 30_000, interval: 500 });
    const live = await readNewestCounter();
    expect(live).toBeLessThan(10);
    expect((Date.now() - sentAt) / 1000).toBeGreaterThan(20);
    await shot('live-timer-newest-message');

    // A fresh start mid-turn: the thread comes back from history plus the
    // run's snapshot, and the counter is the message's, converted with the
    // server's clock — not the run's, and not "since the app opened".
    await relaunchApp();
    await waitForVisible('composer.input', 60_000);
    await goToSurface('agent');
    await selectThread(convId, 'agent');
    await browser.waitUntil(() => Promise.resolve(Date.now() - sentAt > 30_000), { timeout: 30_000, interval: 500 });
    const afterRelaunch = await readNewestCounter();
    expect(afterRelaunch).toBeLessThan(10);
    await shot('live-timer-after-relaunch');

    await waitForRunDone(creds, convId, 120_000);
  });
});
