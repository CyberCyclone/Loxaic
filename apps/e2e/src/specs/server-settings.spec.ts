/**
 * Server Settings: what applies to every conversation, whatever surface it is
 * on (the run queue, auto mode's permission check), on its own admin screen
 * rather than under Agent Sandbox, which is about where tool calls run.
 */
import { adminCreds, provisionAdmin, provisionUser, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { expectNeverPresent, isVisible, scrollTo, tap, waitForFreshText, waitForVisible } from '../helpers/selectors.ts';
import {
  openSandboxSettings,
  openServerSettings,
  openSettings,
  patchInferenceSettings,
  signIn,
  signOut,
} from '../helpers/app.ts';

/** The mock backend's model, which the permission check can be pointed at. */
const CHECK_MODEL = 'llama-3.1-8b-instruct';
const SERVER_ONLY = ['inference.concurrency.auto', 'inference.permissionCheck'];

describe('server settings', () => {
  const creds = uniqueCreds();

  before(async function () {
    this.timeout(60_000);
    await provisionAdmin();
    await provisionUser(creds);
    await patchInferenceSettings({ permissionCheckModel: CHECK_MODEL, permissionCheckTimeoutMs: 60_000 });
  });

  after(async () => {
    await patchInferenceSettings({ permissionCheckModel: null, permissionCheckTimeoutMs: 90_000 });
  });

  it('shows an admin the run queue and the permission check as they are set, and changes them', async () => {
    await signIn(adminCreds());
    await openServerSettings();
    await waitForVisible('inference.concurrency.auto');
    await scrollTo('inference.permissionCheck.timeoutSummary');
    await waitForFreshText('inference.permissionCheck.model', CHECK_MODEL);
    await waitForFreshText('inference.permissionCheck.timeoutSummary', 'longer than 1 min');
    await shot('server-settings');
    await tap('inference.permissionCheck.timeout.30000');
    await waitForFreshText('inference.permissionCheck.timeoutSummary', 'longer than 30 s');
    await tap('inference.permissionCheck.runModel');
    await waitForFreshText('inference.permissionCheck.model', 'Another model…');
  });

  it('no longer lists them under Agent Sandbox', async () => {
    await openSandboxSettings();
    // Checked at the top, the middle and the bottom, each for a while: a
    // part of the screen that arrives with its own request is still caught.
    await expectNeverPresent(SERVER_ONLY);
    await scrollTo('sandbox.customImages.summary');
    await expectNeverPresent(SERVER_ONLY);
    // Rendered only once the sandbox settings have loaded; the screen's end.
    await scrollTo('sandbox.reap.explainer');
    await expectNeverPresent(SERVER_ONLY);
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
