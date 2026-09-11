/**
 * Pointing a fresh install at a server, from the sign-in screen.
 *
 * On a phone this is the only route there is: the endpoint override lives in
 * Settings, Settings lives inside the authenticated shell, and the onboarding
 * screen that would otherwise ask is desktop-only. Without it a downloaded app
 * that cannot reach a server cannot be told where one is.
 *
 * A browser is the one place it is genuinely unnecessary — the page came from
 * the very server it signs in to — and that absence is asserted rather than
 * assumed, because "shows up where it makes no sense" is how this kind of
 * control goes wrong.
 *
 * The desktop has the same lockout in Client mode but must not be fixed with
 * the same override: config.json has one write path, so it gets a route back
 * to onboarding instead of a second place to store an address.
 */
import { browser } from '@wdio/globals';
import { signOut } from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, platform, tap, typeInto, waitForVisible } from '../helpers/selectors.ts';

/** Waits for the result line to carry `expected`, not merely to exist. */
async function waitForResultText(expected: string | RegExp): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await byTestId('login.server.result').getText().catch(() => '');
      return typeof expected === 'string' ? text.includes(expected) : expected.test(text);
    },
    { timeout: 10_000, timeoutMsg: `login.server.result never showed ${String(expected)}` },
  );
}

describe('choosing a server from the sign-in screen', () => {
  before(async () => {
    // A spec file starts on the sign-in screen the way a fresh install does —
    // except on Electron, where the app's data directory outlives a single
    // spec file and an earlier one's sign-in may still be live. Checking for
    // the shell rather than assuming: at this moment the app may simply still
    // be loading, and signing out of nothing hangs for the full timeout.
    // `sidebar.signOut`, not `shell.menuButton`: the menu button renders only
    // below the wide breakpoint, and both the Electron window and the web
    // suite's browser are wide — so that guard could never fire, and a live
    // session from an earlier spec burned the full timeout instead.
    if (!(await isVisible('login.submit')) && (await isVisible('sidebar.signOut'))) {
      await signOut();
    }
    await waitForVisible('login.submit');
  });

  it('is absent in a browser, which is already talking to its own server', async function webOnly() {
    if (platform() !== 'web') return this.skip();
    expect(await isVisible('login.server.toggle')).toBe(false);
    expect(await isVisible('login.server.current')).toBe(false);
  });

  it('sends the desktop back to onboarding rather than storing a second address', async function electronOnly() {
    if (platform() !== 'electron') return this.skip();
    // A Client whose stored host URL stops resolving never sees onboarding
    // again on its own, and its "Change host" control is behind the auth gate.
    await waitForVisible('login.server.current');
    // Not the override form: config.json has one write path, and a stored
    // override would leave the app claiming one server while talking to
    // another.
    expect(await isVisible('login.server.toggle')).toBe(false);
    await tap('login.server.reconfigure');
    // The mode chooser, which is where a reconfigure starts — onboarding has
    // no "already configured, go away" redirect precisely so this works.
    await waitForVisible('onboarding.mode.client');
    await shot('login-server-reconfigure-desktop');
  });

  it('names the server it is about to sign in to', async function skipOffNative() {
    if (platform() === 'web' || platform() === 'electron') return this.skip();
    // Answering "what is it even trying to reach?" is half the value — that
    // question is unanswerable from anywhere else on this screen.
    const current = await byTestId('login.server.current').getText();
    expect(current).toMatch(/^Server: /);
    await shot('login-server-collapsed');
  });

  it('opens, tests a reachable address, and keeps it', async function skipOffNative() {
    if (platform() === 'web' || platform() === 'electron') return this.skip();
    await tap('login.server.toggle');
    await waitForVisible('login.server.input');

    // BASE_URL, the resolved constant every other spec uses — E2E_BASE_URL
    // is only minted by the self-contained Electron path and is unset on the
    // native lanes these cases run in, which typed an empty address. (On an
    // Android emulator this is reachable as 10.0.2.2, not localhost; the
    // harness's BASE_URL already accounts for the platform.)
    await typeInto('login.server.input', BASE_URL);
    await tap('login.server.test');
    await waitForResultText('Reachable');
    await shot('login-server-reachable');

    await tap('login.server.save');
    // Saved, not merely typed: the picker collapses back only on a clear, so
    // a confirmation here is what tells someone the address took effect.
    // Waited on the *text*: the result element is already displayed from the
    // Test above, so a bare waitForVisible returned at once and could read
    // the stale "Reachable" before React flushed the save.
    await waitForResultText('Saved');
  });

  it('says so when the address answers nothing at all', async function skipOffNative() {
    if (platform() === 'web' || platform() === 'electron') return this.skip();
    // A wrong address is the ordinary case this control exists for, and the
    // failure has to name what to do rather than just fail.
    await typeInto('login.server.input', 'http://127.0.0.1:1');
    await tap('login.server.test');
    await waitForResultText(/could not reach|timed out/i);
    await shot('login-server-unreachable');

    // Put the working one back, or every later spec in this run signs in
    // against a dead address. (With an empty string here this *cleared* the
    // override and collapsed the picker — the opposite of the comment.)
    await typeInto('login.server.input', BASE_URL);
    await tap('login.server.save');
    await waitForResultText('Saved');
  });
});
