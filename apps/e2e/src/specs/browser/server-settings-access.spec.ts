/**
 * The Server Settings screen where a phone cannot take you: by its address
 * (web and Electron only), and with its load failing. Hiding the nav row from
 * a non-admin is only presentation; `/server` itself must say the settings are
 * an administrator's and show none of them. And a load that fails says so with
 * a retry, rather than spinning, and loads by itself once the server is back.
 */
import { browser } from '@wdio/globals';
import { BASE_URL } from '../../../scripts/standup.ts';
import { adminCreds, provisionAdmin, provisionUser, uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { expectNeverPresent, platform, tap, waitForFreshText, waitForGone, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import { openServerSettings, signIn, signOut } from '../../helpers/app.ts';
import { cutServer, failRequestsTo, restoreServer } from '../../helpers/outage.ts';

const BANNER = 'shell.offlineBanner';

/** Loads a route of the app by its address, as typing it in would. */
async function openPath(path: string): Promise<void> {
  await browser.url(platform() === 'electron' ? `app://-${path}` : `${BASE_URL}${path}`);
}

describe('server settings, from outside the settings menu', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await provisionUser(creds);
  });

  afterEach(async () => {
    await restoreServer();
  });

  it('tells a non-admin who opens /server that an administrator sets these, and shows none of them', async () => {
    await signIn(creds);
    try {
      await openPath('/server');
      await waitForFreshText('server.readOnly.notice', 'set by an administrator');
      await expectNeverPresent(['inference.concurrency.auto', 'inference.permissionCheck', 'server.loadFailed']);
      await shot('server-settings-non-admin');
    } finally {
      // Whatever happened, the next case signs in as the admin.
      await signOut();
    }
  });

  it('says a load failed and loads on Try again, rather than spinning', async () => {
    await signIn(adminCreds());
    await failRequestsTo('/v1/admin/settings/inference');
    await openServerSettings();
    await waitForFreshText('server.loadFailed', "Can't reach your server");
    await shot('server-settings-load-failed');
    await restoreServer();
    await tap('server.retry');
    await waitForVisible('inference.concurrency.auto');
  });

  it('loads by itself once a server that was gone comes back', async () => {
    await cutServer();
    await openServerSettings();
    await waitForTextIn(BANNER, "Can't reach your server", 30_000);
    await waitForFreshText('server.loadFailed', "Can't reach your server");
    await restoreServer();
    await tap('shell.offlineRetry');
    await waitForGone(BANNER, 15_000);
    // Nothing on the screen was pressed: the screen asked again itself.
    await waitForVisible('inference.concurrency.auto', 15_000);
  });
});
