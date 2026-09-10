/**
 * Electron-only: exposing a Host on Tailscale from the GUI, end to end
 * through the desktop's sidecar supervisor — against a stand-in sidecar
 * (fixtures/fake-tsnet.sh, wired in by LOXAIC_TSNET_BIN), since no test
 * harness can approve a node on a real tailnet.
 *
 * What it proves, in order: choosing to expose a host puts the approval
 * prompt in front of the person on the very screen they land on; once the
 * node is "approved" the served address appears, and — the part that is
 * invisible in the UI — the server is *restarted* to advertise that address,
 * which is what makes sign-in cookies valid for people arriving through it;
 * and a sidecar that fails says why, in the tailnet admin's own terms, with
 * a retry.
 *
 * Runs in self-contained mode only, and skips without a container engine —
 * Host mode's submit is gated on one.
 */
import { browser } from '@wdio/globals';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SELF_CONTAINED, selfContainedDataDir } from '../../../scripts/electron-env.ts';
import { shot } from '../../helpers/screenshot.ts';
import { openSettings, signUp } from '../../helpers/app.ts';
import { uniqueCreds } from '../../helpers/auth.ts';
import { byTestId, tap, testIdSelector, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';

interface InstanceState {
  mode: string | null;
  apiBaseUrl: string | null;
  effectiveAdvertiseUrl: string | null;
  host: { tailnet: { enabled: boolean; hostname: string; funnel: boolean } | null } | null;
  tailnet: { state: string; authUrl: string | null; url: string | null; error: string | null };
}

async function instanceState(): Promise<InstanceState | null> {
  return browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { getState: () => Promise<InstanceState> } };
    }).loxaic;
    return (await bridge?.instance?.getState()) ?? null;
  });
}

async function probeEngine(): Promise<{ ok: boolean }> {
  return browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { probeEngine: () => Promise<{ ok: boolean }> } };
    }).loxaic;
    return (await bridge?.instance?.probeEngine()) ?? { ok: false };
  });
}

async function returnToOnboarding(): Promise<void> {
  rmSync(path.join(selfContainedDataDir ?? '', 'config.json'), { force: true });
  await browser.execute(async () => {
    const bridge = (window as unknown as {
      loxaic?: { instance?: { detach: () => Promise<unknown> } };
    }).loxaic;
    await bridge?.instance?.detach();
  });
  await browser.url('app://-/onboarding');
}

/** See host-settings.spec.ts: a pre-filled React-controlled field needs the
 * native setter, not typeInto. */
async function retype(id: string, text: string): Promise<void> {
  await tap(id);
  await browser.execute(
    (selector: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(selector);
      if (!el) throw new Error(`retype: no element matched ${selector}`);
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      descriptor?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    testIdSelector(id),
    text,
  );
}

/**
 * Scrolls the settings modal so `id` is on screen. `scrollIntoView` does not
 * reach the modal's own scroll container here (the ModalBody's ScrollView),
 * so the nearest scrollable ancestor is scrolled by hand. A screenshot of the
 * modal's top would show none of what these tests are about.
 */
async function revealInModal(id: string): Promise<void> {
  await browser.execute((selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    let node = el.parentElement;
    while (node) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        node.scrollTop += el.getBoundingClientRect().top - node.getBoundingClientRect().top - 40;
        return;
      }
      node = node.parentElement;
    }
  }, testIdSelector(id));
  await browser.pause(300);
}

describe('electron tailnet host', () => {
  let switchedToHost = false;

  before(async function skipUnlessSelfContainedWithEngine() {
    if (!SELF_CONTAINED) return this.skip();
    const engine = await probeEngine();
    if (!engine.ok) return this.skip();
  });

  after(async function restoreSolo() {
    if (!switchedToHost) return;
    await browser.execute(async () => {
      const bridge = (window as unknown as {
        loxaic?: { instance?: { setMode: (config: unknown) => Promise<unknown> } };
      }).loxaic;
      await bridge?.instance?.setMode({ mode: 'solo' });
    });
  });

  it('asks for approval on the screen a fresh host lands on, then shows the address', async () => {
    await returnToOnboarding();
    await waitForVisible('onboarding.mode.host');
    await tap('onboarding.mode.host');
    await waitForVisible('onboarding.host.engineOk', 20_000);

    await retype('onboarding.host.name', 'E2E Tailnet Host');
    await tap('onboarding.host.tailnet');
    await waitForVisible('onboarding.host.tailnet.hostname');
    await retype('onboarding.host.tailnet.hostname', 'e2e-tailnet');
    await shot('tailnet-host-form');

    await tap('onboarding.host.submit');
    await browser.waitUntil(
      async () => (await instanceState())?.mode === 'host',
      { timeout: 60_000, interval: 1000, timeoutMsg: 'stack did not start after choosing Host' },
    );
    switchedToHost = true;

    // The join starts once the stack is up, and the first thing it needs is
    // a person. They have been sent to the login screen, so that is where
    // the prompt has to be.
    await waitForVisible('login.tailnet.approve', 30_000);
    await waitForTextIn('login.tailnet.authUrl', 'login.tailscale.com/a/');
    await shot('tailnet-needs-approval');

    // The fake "approves" itself after a moment.
    await waitForVisible('login.tailnet.url', 30_000);
    await waitForTextIn('login.tailnet.url', 'https://e2e-tailnet.tail1234.ts.net');
    await shot('tailnet-up');

    // Invisible in the UI, and the point of the whole join: the server was
    // started again to advertise the tailnet address, so better-auth signs
    // cookies for the origin people will actually arrive through. Nothing
    // else could have set effectiveAdvertiseUrl to a ts.net name.
    await browser.waitUntil(
      async () => (await instanceState())?.effectiveAdvertiseUrl === 'https://e2e-tailnet.tail1234.ts.net',
      { timeout: 60_000, interval: 1000, timeoutMsg: 'server was not re-advertised as the tailnet address' },
    );

    const state = await instanceState();
    expect(state?.tailnet.state).toBe('up');
    expect(state?.host?.tailnet).toEqual({ enabled: true, hostname: 'e2e-tailnet', funnel: false });

    const onDisk = JSON.parse(readFileSync(path.join(selfContainedDataDir ?? '', 'config.json'), 'utf8')) as {
      host: { tailnet?: { enabled: boolean; hostname: string } };
    };
    expect(onDisk.host.tailnet?.enabled).toBe(true);
    expect(onDisk.host.tailnet?.hostname).toBe('e2e-tailnet');
  });

  it('still signs in over loopback once the server advertises an https tailnet address', async () => {
    // A host now advertising https://… while its own window talks to
    // http://localhost is exactly the mismatch that would break cookies if
    // better-auth got it wrong. Signing up is the proof it does not.
    await signUp(uniqueCreds());
  });

  it('shows the address in Settings, and a failing sidecar says why with a retry', async () => {
    await openSettings();
    await waitForVisible('settings.server.tailnet.status.url');
    await waitForTextIn('settings.server.tailnet.status.url', 'https://e2e-tailnet.tail1234.ts.net');
    await revealInModal('settings.server.tailnet.status');
    await shot('tailnet-settings-up');

    // Rename the node to one the fake refuses — standing in for a tailnet
    // with HTTPS certificates switched off, the most likely real failure.
    await tap('settings.server.edit');
    await waitForVisible('settings.server.tailnet.hostname');
    await retype('settings.server.tailnet.hostname', 'e2e-fail-cert');
    await tap('settings.server.save');

    await waitForVisible('settings.server.tailnet.status.error', 60_000);
    await waitForTextIn('settings.server.tailnet.status.error', 'MagicDNS and HTTPS certificates');
    await waitForVisible('settings.server.tailnet.status.retry');
    await revealInModal('settings.server.tailnet.status');
    await shot('tailnet-error');

    const state = await instanceState();
    expect(state?.tailnet.state).toBe('error');
    // The old advertise URL must not linger: the sidecar that earned it is gone.
    expect(state?.effectiveAdvertiseUrl).not.toBe('https://e2e-tailnet.tail1234.ts.net');
    expect(await byTestId('settings.server.tailnet.status.url').isExisting()).toBe(false);
  });
});
