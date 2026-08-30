/**
 * The settings screen itself: an admin gets working pickers with live engine
 * availability, host mode is gated behind a confirm, and a non-admin gets a
 * read-only view with no way to change anything — the authorization
 * boundary from apps/server/src/routes/admin-settings.ts made visible.
 */
import { adminCreds, apiToken, provisionAdmin, uniqueCreds } from '../helpers/auth.ts';
import { BASE_URL } from '../../scripts/standup.ts';
import { shot } from '../helpers/screenshot.ts';
import { isVisible, waitForVisible } from '../helpers/selectors.ts';
import { openSandboxSettings, resetSandboxSettings, setSandboxMode, signIn, signOut, signUp } from '../helpers/app.ts';

describe('sandbox settings screen', () => {
  after(async () => {
    await resetSandboxSettings();
  });

  it('admin sees engine availability and can switch modes through the confirm', async () => {
    await provisionAdmin();
    await signIn(adminCreds());
    await openSandboxSettings();

    // Auto/Docker/Podman/Custom are always rendered (unavailable ones just
    // disabled) — presence here doesn't depend on either engine being
    // installed on the machine running this suite.
    await waitForVisible('sandbox.engine.auto');
    await waitForVisible('sandbox.engine.docker');
    await waitForVisible('sandbox.engine.podman');
    await shot('sandbox-settings-admin');

    await setSandboxMode('host');
    await shot('sandbox-settings-host-warning-confirmed');
    // Host mode has no container engine — the picker for it shouldn't be
    // reachable while it's selected.
    await isVisible('sandbox.engine.auto').then((v) => {
      if (v) throw new Error('engine picker should not render in host mode');
    });

    await setSandboxMode('container');
  });

  it('a non-admin sees a read-only view with no pickers', async () => {
    await signOut();
    const creds = uniqueCreds();
    await signUp(creds);
    await openSandboxSettings();

    await waitForVisible('sandbox.readOnly.notice');
    const hasPicker = await isVisible('sandbox.mode.container');
    if (hasPicker) throw new Error('non-admin should not see the mode picker');
    await shot('sandbox-settings-nonadmin');

    // The server has to refuse it too, not just the UI hide it. Hiding a
    // button is presentation; `requireAdmin` on the route is the actual
    // boundary, and a regression that dropped it while leaving the button
    // hidden would pass every assertion above. Host mode is arbitrary
    // execution on the host, so this is the one worth proving directly.
    const token = await apiToken(creds);
    const patch = await fetch(`${BASE_URL}/v1/admin/settings/sandbox`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'host' }),
    });
    if (patch.status !== 403) {
      throw new Error(`non-admin PATCH should be 403, got ${String(patch.status)}`);
    }
  });
});
