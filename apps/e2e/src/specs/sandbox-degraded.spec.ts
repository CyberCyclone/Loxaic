/**
 * The "no-engine" UX: when sandboxes are unavailable, the agent surface says
 * so instead of letting a tool call fail silently mid-run, and hands the user
 * a way to actually fix it rather than just an error.
 */
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { goToSurface, openSandboxSettings, resetSandboxSettings, setSandboxMode, signIn } from '../helpers/app.ts';

describe('sandbox degraded UX', () => {
  before(async () => {
    await provisionAdmin();
    await signIn(adminCreds());
  });

  after(async () => {
    await resetSandboxSettings();
  });

  it('banners the agent screen with a fix path when sandboxes are off', async () => {
    await openSandboxSettings();
    await setSandboxMode('off');

    await goToSurface('agent');
    await waitForVisible('agent.sandbox.banner');
    // Assert the banner carries the server's *reason*, not just that it
    // rendered. Deliberately not matching on "off": that only ever passed
    // because the mode name happened to appear inside the old hardcoded
    // "(SANDBOX_MODE=off)" string, so it silently coupled this test to a
    // message that — for a sandbox disabled through the GUI, as here —
    // was pointing admins at an environment variable nobody had set.
    await waitForTextIn('agent.sandbox.banner', 'disabled');
    await shot('sandbox-degraded-banner');

    // The banner is itself the fix path — tapping it routes back to settings.
    await tap('agent.sandbox.banner');
    await waitForVisible('sandbox.status');
    await waitForTextIn('sandbox.status', '(off)');
  });
});
