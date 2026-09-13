/**
 * The update controls appear only where the app can actually update itself.
 *
 * On web there is nothing to update: the server serves the app, so it changes
 * when the server does. The row hides rather than showing a "Check now" that
 * would throw — expo-updates rejects every call outside a native release
 * build, which is also true in Expo Go and in development.
 *
 * This runs on the shared glob, so on a native platform it asserts the
 * opposite: the row is there, and it names what the app is running.
 *
 * It also asserts what is *not* there any more. The channel used to be a
 * switch in this row; it is now fixed when the app is built, so a control
 * offering to change it would be a promise the app cannot keep.
 */
import { openSettings, signUp } from '../helpers/app.ts';
import { uniqueCreds } from '../helpers/auth.ts';
import { byTestId, isVisible, platform, waitForVisible } from '../helpers/selectors.ts';
import { shot } from '../helpers/screenshot.ts';

describe('app updates', () => {
  before(async () => {
    await signUp(uniqueCreds());
    await openSettings();
    // Proof the modal is actually open — without this, "the row is absent"
    // would also pass on a settings screen that never rendered at all.
    await waitForVisible('settings.nav.sandbox');
  });

  it('offers no update controls where the app cannot update itself', async function skipOffWeb() {
    if (platform() !== 'web') return this.skip();
    expect(await isVisible('settings.updates.version')).toBe(false);
    expect(await isVisible('settings.updates.check')).toBe(false);
    await shot('settings-no-updates-row-web');
  });

  it('says what it is running, on a build that updates', async function skipOnWeb() {
    // Native and the desktop both, through one row: the mechanisms underneath
    // share nothing (a JS bundle over the air versus a whole new binary), and
    // that is exactly why the row is worth asserting on identically.
    if (platform() === 'web') return this.skip();
    await waitForVisible('settings.updates.check');
    // The version line is what a bug report quotes, so it has to say
    // something rather than render empty.
    const version = await byTestId('settings.updates.version').getText();
    expect(version).toContain('App');
    // No channel control: which updates an install follows is decided when it
    // is built, so a switch here would be a promise the app cannot keep.
    expect(await isVisible('settings.updates.channel.production')).toBe(false);
    expect(await isVisible('settings.updates.channel.beta')).toBe(false);
    await shot('settings-updates-row');
  });
});
