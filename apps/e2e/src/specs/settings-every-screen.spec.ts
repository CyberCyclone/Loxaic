/**
 * The sidebar's Settings opens the settings modal on every screen, not only on
 * the ones that happened to render a copy of it.
 *
 * Each screen used to render its own `SettingsModal`, and Routines, Stats and
 * Admin never did — so on those the sidebar's Settings changed a flag nothing
 * read, and nothing happened. The modal now lives once in AppShell. Chat and
 * Agent are here as well as the three that were broken, since they are the
 * screens whose own copy was removed.
 *
 * Signed in as the admin because Admin is one of the screens, and it is not in
 * a non-admin's sidebar at all.
 */
import { browser } from '@wdio/globals';
import { provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, openSettings, openSidebar, signIn } from '../helpers/app.ts';

/** Navigates to a surface and waits for something only that surface renders,
 * so the modal is opened from the screen under test and not the previous one. */
async function goTo(surface: 'chat' | 'agent' | 'routines' | 'stats' | 'admin'): Promise<void> {
  if (surface === 'stats') {
    await openSidebar();
    await tap('sidebar.nav.stats');
    await waitForTextIn('shell.header.title', 'Usage & Performance', 20_000);
    return;
  }
  await goToSurface(surface);
}

describe('Settings from every screen', () => {
  before(async () => {
    await signIn(await provisionAdmin());
  });

  for (const surface of ['routines', 'stats', 'admin', 'chat', 'agent'] as const) {
    it(`opens from ${surface}`, async () => {
      await goTo(surface);
      await openSettings();
      await waitForVisible('settings.name');
      await shot(`settings-from-${surface}`);
      await tap('settings.close');
      // Looked up afresh each poll, not `waitForGone`: that keeps the element
      // it found first, and UiAutomator2 goes on calling a removed view
      // displayed. Gone matters — the next screen's check must not be passed
      // by this modal still being up.
      await browser.waitUntil(async () => !(await isVisible('settings.name')), {
        timeout: 10_000,
        timeoutMsg: 'the settings modal did not close',
      });
    });
  }
});
