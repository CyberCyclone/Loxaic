/**
 * The "no-engine" UX: when sandboxes are unavailable, the agent surface says
 * so instead of letting a tool call fail silently mid-run, and hands the user
 * a way to actually fix it rather than just an error.
 */
import { adminCreds, provisionAdmin } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { tap, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import {
  goToSurface,
  openSandboxSettings,
  patchSandboxSettings,
  resetSandboxSettings,
  setSandboxMode,
  signIn,
} from '../helpers/app.ts';

describe('sandbox degraded UX', () => {
  before(async () => {
    await provisionAdmin();
    // See sandbox-bash.spec.ts: the persisted mode outlives the process, so
    // start from a known one rather than trusting the previous run's cleanup.
    await resetSandboxSettings();
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

  it('banners a workspace with no network, names the consequence and the fix, and clears once network is on', async () => {
    // The default posture: sandboxes work, but they are created with
    // NetworkMode: none. Nothing else in the agent UI said so, and the model
    // discovered it by watching `npm install` fail — see #112.
    await resetSandboxSettings();
    await goToSurface('chat');
    await goToSurface('agent');

    await waitForVisible('agent.network.banner');
    // The consequence and the fix, not just that something rendered: a banner
    // saying only "no network" leaves the user with nowhere to go.
    await waitForTextIn('agent.network.banner', 'no network access');
    await waitForTextIn('agent.network.banner', 'npm install');
    await waitForTextIn('agent.network.banner', 'Agent Sandbox settings');
    await shot('sandbox-no-network-banner');

    // Same fix path as the banner above.
    await tap('agent.network.banner');
    await waitForVisible('sandbox.status');

    // And it is not a permanent fixture: it goes when an admin turns the
    // network on. The agent screen reads /v1/config on mount, so leave and
    // return for it to see the changed setting.
    await patchSandboxSettings({ allowNetwork: true });
    await goToSurface('chat');
    await goToSurface('agent');
    await waitForGone('agent.network.banner');
    await shot('sandbox-network-on-no-banner');
  });
});
