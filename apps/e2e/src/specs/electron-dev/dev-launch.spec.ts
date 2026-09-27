/**
 * `pnpm dev`'s desktop window: it waits for Metro and for the dev server
 * instead of going blank, and finds its way back when Metro restarts.
 *
 * Run by wdio.electron-dev.ts, which launches the checkout's own
 * `electron apps/desktop` — the development path — with the dev server and
 * Metro replaced by stand-ins: the dev server answers only a few seconds after
 * the app first asks, and Metro is not up at all until this spec starts it.
 * Before the fix the window loaded Metro once and stayed blank, and the one
 * early probe of the dev server failed, so the app opened on its own
 * configuration (here: onboarding) rather than the dev server.
 */
import { browser } from '@wdio/globals';
import { shot } from '../../helpers/screenshot.ts';
import { byTestId, waitForVisible } from '../../helpers/selectors.ts';
import { metroStandIn } from '../../../scripts/dev-stand-ins.ts';
import { BASE_URL } from '../../../scripts/standup.ts';

const metro = metroStandIn(BASE_URL, Number(process.env.E2E_DEV_METRO_PORT));

async function apiBaseUrl(): Promise<string | null> {
  return browser.execute(
    () => (window as unknown as { loxaic?: { apiBaseUrl?: string | null } }).loxaic?.apiBaseUrl ?? null,
  );
}

/**
 * Moves the session to the app's real window once it exists. The dev-server
 * waiting window closes after the real one opens, and chromedriver may list a
 * closed window's handle for a moment, so each handle is tried in turn.
 */
async function focusRealWindow(): Promise<void> {
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        try {
          await browser.switchToWindow(handle);
          if (!(await browser.getTitle()).includes('Waiting for the dev server')) return true;
        } catch {
          // A handle for the window that has just closed.
        }
      }
      return false;
    },
    { timeout: 60_000, interval: 500, timeoutMsg: 'the real window never replaced the dev-server waiting window' },
  );
}

describe('the desktop app under pnpm dev', () => {
  after(async () => {
    await metro.stop();
  });

  it('shows a window saying it is waiting for the dev server, rather than nothing', async () => {
    await waitForVisible('devLaunch.serverWaiting', 30_000);
    expect(await byTestId('devLaunch.serverUrl').getText()).toBe(process.env.LOXAIC_DEV_SERVER_URL);
    await shot('dev-launch-waiting-for-server');
  });

  it('opens on a page saying it is waiting for Metro, not a blank window', async () => {
    await focusRealWindow();
    await waitForVisible('devLaunch.waiting', 60_000);
    expect(await byTestId('devLaunch.url').getText()).toBe(process.env.LOXAIC_DEV_RENDERER_URL);
    await shot('dev-launch-waiting-for-metro');
  });

  it('opens the app by itself once Metro answers', async () => {
    await metro.start();
    await waitForVisible('login.submit', 60_000);
    await shot('dev-launch-app-after-metro');
  });

  it('waited for the dev server pnpm dev started, rather than falling back', async () => {
    // The stand-in refused the app's first probes; one probe would have lost
    // the race and left the app on its own configuration, with no server.
    expect(await apiBaseUrl()).toBe(process.env.LOXAIC_DEV_SERVER_URL);
  });

  it('goes back to waiting when Metro stops, and comes back when it restarts', async () => {
    await metro.stop();
    await browser.execute(() => { window.location.reload(); });
    await waitForVisible('devLaunch.waiting', 30_000);
    await metro.start();
    await waitForVisible('login.submit', 60_000);
  });
});
