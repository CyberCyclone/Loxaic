/**
 * An admin resetting a forgotten password (#163): Admin → Users → Reset
 * password shows a temporary one once; the user signs in with it, is held on
 * the forced-change screen, sets their own, and is let in.
 *
 * The temporary password is read off the screen, the way an admin would —
 * the spec has no other way to know it, which is the point.
 */
import { apiToken, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, tap, typeInto, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  fillChangePassword,
  goToSurface,
  signIn,
  signOut,
  submitLogin,
  waitForComposerReady,
} from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

const TEMP_FORMAT = /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/;

interface AdminUser { id: string; email: string }

async function findUser(token: string, email: string): Promise<AdminUser> {
  const res = await fetch(`${BASE_URL}/v1/admin/users?q=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /v1/admin/users failed: ${String(res.status)}`);
  const found = ((await res.json()) as { users: AdminUser[] }).users.find((u) => u.email === email);
  if (!found) throw new Error(`no user ${email} in the admin list`);
  return found;
}

describe('Admin password reset', () => {
  const user = uniqueCreds();
  const CHOSEN = 'Chosen-after-reset-1';
  let admin: Awaited<ReturnType<typeof provisionAdmin>>;
  let userId = '';
  let adminId = '';
  let temporary = '';

  before(async () => {
    admin = await provisionAdmin();
    await provisionUser(user);
    const token = await apiToken(admin);
    userId = (await findUser(token, user.email)).id;
    adminId = (await findUser(token, admin.email)).id;
  });

  it('lists users, without a reset button on your own row', async () => {
    await signIn(admin);
    await goToSurface('admin');
    await tap('admin.tab.users');
    // Newest first, but search anyway: a shared dev database holds thousands.
    await typeInto('admin.users.search', user.email);
    await waitForVisible(`admin.user.${userId}`);
    await shot('admin-users');
    await typeInto('admin.users.search', admin.email);
    await waitForVisible(`admin.user.${adminId}`);
    expect(await isVisible(`admin.user.${adminId}.resetPassword`)).toBe(false);
  });

  it('resets a password and shows the temporary one once', async () => {
    await typeInto('admin.users.search', user.email);
    await tap(`admin.user.${userId}.resetPassword`);
    await tap('admin.resetPasswordConfirm.confirm');
    await waitForVisible('admin.resetPassword.value');
    temporary = (await byTestId('admin.resetPassword.value').getText()).trim();
    expect(temporary).toMatch(TEMP_FORMAT);
    await waitForVisible(`admin.user.${userId}.mustChange`);
    await shot('admin-reset-result');
  });

  it('the old password stops working', async () => {
    await signOut();
    await submitLogin(user.email, user.password);
    await waitForVisible('login.error');
  });

  it('the temporary password leads only to choosing a new one', async () => {
    await submitLogin(user.email, temporary);
    await waitForVisible('changePassword.screen');
    await waitForTextIn('changePassword.reason', 'administrator reset your password');
    await shot('forced-change-screen');
  });

  it('choosing one lets them in, and it is theirs from then on', async () => {
    await fillChangePassword(temporary, CHOSEN);
    await waitForComposerReady();
    await shot('forced-change-complete');
    await signOut();
    await submitLogin(user.email, CHOSEN);
    await waitForComposerReady();
  });
});
