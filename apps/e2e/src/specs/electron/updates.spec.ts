/**
 * Electron-only: the desktop half of the updates row.
 *
 * The shared spec (specs/updates.spec.ts) asserts the row exists and names
 * what is running, which is true of both backends. What only the desktop can
 * show is the rest of it: that a build which is *not* checking says so rather
 * than reporting "up to date" — a distinction no other platform can make,
 * because only the desktop keeps the row visible when updates are off.
 *
 * The suite pins `LOXAIC_DISABLE_UPDATES=1` (see wdio.electron.ts), so this
 * is the off path deliberately, and no test ever reaches GitHub.
 */
import { shot } from '../../helpers/screenshot.ts';
import { openSettings, signUp } from '../../helpers/app.ts';
import { uniqueCreds } from '../../helpers/auth.ts';
import { browser } from '@wdio/globals';
import { byTestId, waitForVisible } from '../../helpers/selectors.ts';

/**
 * Brings the row on screen for a screenshot.
 *
 * The Settings modal's content is 1489 px tall inside a 574 px scroller, and
 * this row sits in the middle of it, so a shot taken where the test left the
 * viewport shows some other part of Settings entirely — WebDriver scrolls to
 * click, not to photograph. The DOM's own `scrollIntoView` is what moves the
 * inner scroller; WebDriver's moves the window, which is the wrong one.
 * Aligned to the row's last element so the whole row lands in frame.
 */
async function showRow(): Promise<void> {
  await browser.execute(() => {
    document.querySelector('[data-testid="settings.updates.copy"]')?.scrollIntoView({ block: 'end' });
  });
}

describe('desktop updates', () => {
  before(async () => {
    await signUp(uniqueCreds());
    await openSettings();
    await waitForVisible('settings.updates.check');
  });

  it('says it is not checking, and why, instead of claiming to be current', async () => {
    // The distinction this makes is the whole reason the row stays visible on
    // a desktop build that cannot update: "checks are off" and "you are up to
    // date" are indistinguishable to a person otherwise.
    const status = await byTestId('settings.updates.status').getText();
    expect(status).toMatch(/switched off/i);
    expect(status).not.toMatch(/up to date/i);
    expect(await byTestId('settings.updates.check').isEnabled()).toBe(false);
    await showRow();
    await shot('desktop-updates-off');
  });

  it('names the running build', async () => {
    // 0.0.0 is what an unstamped build reports, and that is correct: the
    // version comes from the git tag at release time and is not committed.
    expect(await byTestId('settings.updates.version').getText()).toContain('App 0.0.0');
  });

});
