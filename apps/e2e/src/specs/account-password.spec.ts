/**
 * Changing your own password from Settings → Account (#163), and the login
 * page's explanation of how a forgotten one is reset.
 *
 * What would look wrong if it regressed: the old password still working after
 * a change, a wrong current password being accepted, and — the subtle one —
 * this very session dying after its own change, because the server revokes
 * every session and the client must adopt the replacement token. The last is
 * checked by using the app after the change, before signing out.
 */
import { provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { fillChangePassword, openSettings, signIn, signOut, submitLogin, waitForComposerReady } from '../helpers/app.ts';

describe('Changing your password', () => {
  const creds = uniqueCreds();
  const NEW_PASSWORD = 'A-brand-new-password-1';

  before(async () => {
    await provisionUser(creds);
  });

  it('explains on the login page how a forgotten password is reset', async () => {
    await waitForVisible('login.forgotPassword');
    await tap('login.forgotPassword');
    await waitForTextIn('login.forgotPassword.hint', 'administrator');
    await shot('login-forgot-password-hint');
  });

  it('shows the signed-in account', async () => {
    await signIn(creds);
    await openSettings();
    await tap('settings.nav.account');
    await waitForTextIn('account.email', creds.email);
    await shot('account-screen');
  });

  it('refuses a wrong current password', async () => {
    await fillChangePassword('not-my-password', NEW_PASSWORD);
    await waitForTextIn('account.password.error', 'current password is wrong');
    await shot('account-password-wrong-current');
  });

  it('refuses mismatched new passwords before asking the server', async () => {
    await fillChangePassword(creds.password, NEW_PASSWORD, `${NEW_PASSWORD}x`);
    await waitForTextIn('account.password.error', 'do not match');
  });

  it('changes it, and this device stays signed in', async () => {
    await fillChangePassword(creds.password, NEW_PASSWORD);
    await waitForVisible('account.password.success');
    await shot('account-password-changed');
    // Every session was revoked server-side, this one included; the app must
    // be running on the replacement token or this navigation lands on login.
    await openSettings();
    await tap('settings.nav.account');
    await waitForTextIn('account.email', creds.email);
  });

  it('no longer accepts the old password, and accepts the new one', async () => {
    await signOut();
    await submitLogin(creds.email, creds.password);
    await waitForVisible('login.error');
    await shot('login-old-password-rejected');
    await submitLogin(creds.email, NEW_PASSWORD);
    await waitForComposerReady();
  });
});
