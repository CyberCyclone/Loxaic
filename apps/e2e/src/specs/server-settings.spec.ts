/**
 * Server Settings: what applies to every conversation, whatever surface it is
 * on (the run queue, auto mode's permission check), on its own admin screen
 * rather than under Agent Sandbox, which is about where tool calls run.
 */
import { adminCreds, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, scrollTo, tap, waitForAbsent, waitForVisible } from '../helpers/selectors.ts';
import { openSandboxSettings, openServerSettings, openSettings, signIn, signOut } from '../helpers/app.ts';

describe('server settings', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await provisionUser(creds);
  });

  it('shows an admin the run queue and the permission check on their own screen', async () => {
    await signIn(adminCreds());
    await openServerSettings();
    await waitForVisible('inference.concurrency.auto');
    await scrollTo('inference.permissionCheck');
    await shot('server-settings');
  });

  it('no longer lists them under Agent Sandbox', async () => {
    await openSandboxSettings();
    await waitForAbsent('inference.concurrency.auto');
    expect(await isVisible('inference.permissionCheck')).toBe(false);
  });

  it('is not offered to someone who is not an admin', async () => {
    await signOut();
    await signIn(creds);
    await openSettings();
    await scrollTo('settings.nav.sandbox');
    expect(await isVisible('settings.nav.server')).toBe(false);
    await tap('settings.nav.sandbox');
    await waitForVisible('sandbox.readOnly.notice');
  });
});
