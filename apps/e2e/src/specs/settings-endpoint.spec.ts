/**
 * Changing the server address, which is the one setting on this screen that
 * can cut the device off from the server entirely.
 *
 * An admin moving a deployment from a bare IP to a domain is the case it
 * exists for, and a transposed digit or a DNS record that has not propagated
 * yet is indistinguishable from a server that is down — so the change is
 * confirmed, and the confirmation names both addresses rather than saying
 * "the server address".
 */
import { openSidebar, signUp } from '../helpers/app.ts';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { byTestId, isVisible, tap, typeInto, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';

describe('changing the server endpoint', () => {
  before(async () => {
    await signUp(uniqueCreds());
    // Inlined rather than given a helper: the release branch adds an
    // `openSettings` of its own, and two of them would collide on merge.
    await openSidebar();
    await tap('sidebar.settings');
    await waitForVisible('settings.endpoint');
  });

  it('saves everything else without asking', async () => {
    // Only the endpoint is confirmed. A name change must not inherit a modal
    // that has nothing to do with it.
    await typeInto('settings.name', 'Renamed Without Fuss');
    await tap('settings.save');
    expect(await isVisible('settings.endpoint.confirm.dialog')).toBe(false);
  });

  it('asks before changing the address, and names both of them', async () => {
    await typeInto('settings.endpoint', 'https://typo.example.com');
    await tap('settings.save');
    await waitForVisible('settings.endpoint.confirm.dialog');

    // Through waitForTextIn, which owns the per-platform split: getText() on
    // a container concatenates its leaves on web only, and this file is in
    // the every-platform glob — on iOS and Android the container's own text
    // is empty and both assertions would have read ''.
    // Naming the destination is what makes a typo visible before it commits.
    await waitForTextIn('settings.endpoint.confirm.dialog', 'https://typo.example.com', 5_000);
    // And says the way back, which is true while the session lasts.
    await waitForTextIn('settings.endpoint.confirm.dialog', 'change it back', 5_000);
    await shot('settings-endpoint-confirm');
  });

  it('leaves the address alone when the change is declined', async () => {
    await tap('settings.endpoint.confirm.cancel');
    // Still in the field — cancelling the confirmation is not discarding the
    // edit, and retyping a long hostname to try again would be punishing.
    expect(await byTestId('settings.endpoint').getValue()).toBe('https://typo.example.com');
    // But nothing was written: the app is still talking to the real server,
    // which is what the next spec in this run depends on.
    await tap('settings.discard');
  });
});
