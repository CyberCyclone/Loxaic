/**
 * Electron-only: the desktop half of the updates row.
 *
 * The shared spec (specs/updates.spec.ts) asserts the row exists and names
 * what is running, which is true of both backends. What only the desktop can
 * show is the rest of it: that a build which is *not* checking says so rather
 * than reporting "up to date", and that choosing a channel is written to disk
 * — the file the main process reads at the next launch, not React state that
 * dies with the window.
 *
 * The suite pins `LOXAIC_DISABLE_UPDATES=1` (see wdio.electron.ts), so this
 * is the off path deliberately, and no test ever reaches GitHub.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { appDataDir } from '../../../scripts/electron-env.ts';
import { shot } from '../../helpers/screenshot.ts';
import { openSettings, signUp } from '../../helpers/app.ts';
import { uniqueCreds } from '../../helpers/auth.ts';
import { browser } from '@wdio/globals';
import { byTestId, tap, waitForVisible } from '../../helpers/selectors.ts';

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
    document.querySelector('[data-testid="settings.updates.betaCopy"]')?.scrollIntoView({ block: 'end' });
  });
}

function storedChannel(): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(appDataDir, 'updates.json'), 'utf8')) as { channel?: string };
    return raw.channel ?? null;
  } catch {
    // Absent is the honest answer before anything has been chosen — the
    // default lives in the loader, not in a file written at first launch.
    return null;
  }
}

describe('desktop updates', () => {
  before(async () => {
    await signUp(uniqueCreds());
    await openSettings();
    await waitForVisible('settings.updates.check');
  });

  after(async () => {
    // Leave the shared install on the default, or a later run of the shared
    // spec inherits Beta from this one.
    if (storedChannel() === 'beta') await tap('settings.updates.channel.production');
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

  it('writes the channel choice to disk, where the next launch will read it', async () => {
    expect(storedChannel()).toBe(null);
    await tap('settings.updates.channel.beta');
    await browser.waitUntil(() => storedChannel() === 'beta', {
      timeout: 5_000,
      timeoutMsg: 'choosing Beta never reached updates.json',
    });
    await showRow();
    await shot('desktop-updates-beta');

    await tap('settings.updates.channel.production');
    await browser.waitUntil(() => storedChannel() === 'production', {
      timeout: 5_000,
      timeoutMsg: 'switching back to Stable never reached updates.json',
    });
  });
});
