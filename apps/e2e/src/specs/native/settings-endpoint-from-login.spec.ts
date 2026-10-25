/**
 * Settings names the server the app is actually using, whichever screen chose
 * it.
 *
 * On a phone the address can be set in two places: the sign-in screen's
 * server picker and Settings → Server endpoint. The picker writes the override
 * the app resolves from, and Settings used to show a copy of its own that only
 * Settings wrote. An address chosen at sign-in therefore showed as an empty
 * field over an app pinned to it, and nothing in Settings said which server
 * was in use.
 *
 * Native only: a browser has no picker (the page came from its own server),
 * and the desktop's goes back to onboarding instead.
 */
import { browser } from '@wdio/globals';
import { openSettings, revealInSettings, signIn, signOut, signUp } from '../../helpers/app.ts';
import { uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { byTestId, isVisible, tap, typeInto, waitForAbsent, waitForFreshText, waitForVisible } from '../../helpers/selectors.ts';
import { BASE_URL, PORT } from '../../../scripts/standup.ts';

/**
 * The e2e server under another name. It is the same machine as `BASE_URL`
 * (the simulator shares the host's loopback; Android's `adb reverse` maps the
 * port on the device's), so signing in still works, but a different string,
 * so whatever an earlier spec left behind cannot pass for it.
 */
const PICKED = `http://127.0.0.1:${String(PORT)}`;

/** What an empty field reads as. UiAutomator2 reports an empty EditText's
 * hint as its text, so on Android the placeholder stands for "empty". */
const EMPTY_FIELD = ['', 'https://your-server.tailnet.ts.net'];

/** Saves `address` from the sign-in screen's picker; empty clears it. */
async function pickServer(address: string): Promise<void> {
  if (!(await isVisible('login.server.input'))) await tap('login.server.toggle');
  await waitForVisible('login.server.input');
  await typeInto('login.server.input', address);
  await tap('login.server.save');
  if (address) {
    // On the text: an earlier result line may already be on screen.
    await waitForFreshText('login.server.result', 'Saved', 10_000);
  } else {
    // A clear collapses the picker back to its one line.
    await waitForAbsent('login.server.input');
  }
}

async function openEndpointField(): Promise<void> {
  await openSettings();
  await waitForVisible('settings.name');
  await revealInSettings('settings.endpoint');
  await waitForVisible('settings.endpoint');
}

async function closeSettings(): Promise<void> {
  await tap('settings.close');
  await waitForAbsent('settings.name');
}

describe('the server endpoint in Settings, after choosing one at sign-in', () => {
  const creds = uniqueCreds();

  before(async () => {
    // Every native spec file shares one app install, so this may open on the
    // shell an earlier file signed in to. Polled: asked while the app is
    // still loading, neither is displayed yet.
    const probe = (id: string) => isVisible(id).catch(() => false);
    await browser.waitUntil(async () => (await probe('login.submit')) || (await probe('sidebar.signOut')) || (await probe('composer.input')), {
      timeout: 20_000,
      interval: 300,
      timeoutMsg: 'neither the sign-in screen nor the signed-in shell appeared',
    });
    if (!(await probe('login.submit'))) await signOut();
    await waitForVisible('login.submit');
  });

  after(async () => {
    // Put back the address every other spec signs in at, so a later file
    // neither talks to the alias nor looks for its token under it.
    if (!(await isVisible('login.submit').catch(() => false))) await signOut();
    await pickServer(BASE_URL);
  });

  it('shows the address the sign-in screen saved', async () => {
    await pickServer(PICKED);
    await signUp(creds);
    await openEndpointField();

    expect(await byTestId('settings.endpoint').getValue()).toBe(PICKED);
    // Pinned, not detected: nothing claims auto-detection chose it.
    expect(await isVisible('settings.endpoint.detected')).toBe(false);
    await shot('settings-endpoint-from-login');
    await closeSettings();
  });

  it('says what was auto-detected once the sign-in screen clears it, without filling the field', async () => {
    await signOut();
    await pickServer('');
    await signIn(creds);
    await openEndpointField();

    // The detected address is said underneath, not put in the field, where a
    // Save would have pinned it.
    expect(EMPTY_FIELD).toContain(await byTestId('settings.endpoint').getValue());
    await revealInSettings('settings.endpoint.detected');
    await waitForFreshText('settings.endpoint.detected', BASE_URL, 10_000);
    await shot('settings-endpoint-auto-detected');
    await closeSettings();
  });
});
