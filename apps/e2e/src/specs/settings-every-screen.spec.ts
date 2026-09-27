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
import { byTestId, isVisible, platform, tap, typeInto, waitForAbsent, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
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
  if (surface === 'agent') {
    // Not goToSurface: it waits for `composer.input`, which Chat renders too,
    // so from Chat it returned before the Agent screen had mounted at all.
    await openSidebar();
    await tap('sidebar.nav.agent');
    await waitForVisible('agent.mode.manual');
    return;
  }
  await goToSurface(surface);
}

/**
 * Brings a row below the settings modal's fold into view on native, where an
 * element off screen cannot be typed into (web needs nothing). A touch drag in
 * the middle of the window, where the centred modal is, repeated until the row
 * shows — not UiScrollable or XCUITest's scroll-to, which pick the first
 * scrollable they find, and that can be the screen's own list behind the modal.
 */
async function revealInSettings(id: string): Promise<void> {
  const p = platform();
  if (p === 'web' || p === 'electron') return;
  const { width, height } = await browser.getWindowSize();
  const x = Math.round(width / 2);
  for (let i = 0; i < 6 && !(await isVisible(id)); i++) {
    await browser
      .action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x, y: Math.round(height * 0.62) })
      .down()
      .move({ x, y: Math.round(height * 0.38), duration: 400 })
      .up()
      .perform();
  }
}

async function closeSettings(): Promise<void> {
  await tap('settings.close');
  // Gone matters — the next check must not be passed by this modal still up.
  // `waitForAbsent`, not `waitForGone`: see its comment.
  await waitForAbsent('settings.name');
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
      await closeSettings();
    });
  }

  it('opens clean every time, not with what the last opening left', async () => {
    // One instance lives for the whole session now, so a failed Test must not
    // still be showing under the saved, working address next time.
    await openSettings();
    await waitForVisible('settings.name');
    await revealInSettings('settings.endpoint');
    await typeInto('settings.endpoint', 'http://127.0.0.1:1');
    // The keyboard the field raised sits over the Test button beside it. iOS
    // has no API to dismiss it that WebDriverAgent can use; Return in a
    // single-line field does.
    if (platform() === 'ios') await byTestId('settings.endpoint').addValue('\n');
    if (platform() === 'android') await browser.hideKeyboard().catch(() => undefined);
    await revealInSettings('settings.endpoint.test');
    await tap('settings.endpoint.test');
    await waitForVisible('settings.endpoint.result', 20_000);
    await closeSettings();
    await goTo('stats');
    await openSettings();
    await waitForVisible('settings.name');
    await revealInSettings('settings.endpoint');
    await waitForVisible('settings.endpoint');
    expect(await isVisible('settings.endpoint.result')).toBe(false);
    await closeSettings();
  });

  // Last: it leaves the routine form open behind it.
  it('opens over a routine being written, from its model picker, and gives the form back', async () => {
    await goTo('routines');
    await tap('routines.new');
    await typeInto('routineModal.name', 'Kept while Settings is open');
    // With the keyboard up, the first tap in a scroll view only dismisses it.
    if (platform() === 'ios') await byTestId('routineModal.name').addValue('\n');
    if (platform() === 'android') await browser.hideKeyboard().catch(() => undefined);
    await tap('routineModal.model');
    await tap('models.settings');
    await waitForVisible('settings.name');
    await shot('settings-over-routine-form');
    await closeSettings();
    await waitForVisible('routineModal.name');
    // An input's text is its value on the web and its text natively.
    const field = byTestId('routineModal.name');
    const p = platform();
    const value = p === 'web' || p === 'electron' ? await field.getValue() : await field.getText();
    expect(value).toBe('Kept while Settings is open');
  });
});
