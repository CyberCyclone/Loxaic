/**
 * Electron-only: first-run instance setup.
 *
 * The mode chooser lives behind the desktop bridge — it asks the main process
 * to write config.json and start a stack, which no other platform can do — so
 * this is genuinely not a shared spec. What it proves is the seam the whole
 * of #75 rests on: an install with no stored mode opens onboarding and starts
 * *nothing*, and choosing a mode brings a real server up underneath the
 * renderer without an app restart.
 *
 * Runs in self-contained mode only (E2E_SELF_CONTAINED=1). Against an
 * external server the app is pinned by EXPO_PUBLIC_API_URL, which by design
 * outranks the stored config, so there is no onboarding to reach.
 */
import { browser } from '@wdio/globals';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { SELF_CONTAINED, selfContainedDataDir } from '../../../scripts/electron-env.ts';
import { shot } from '../../helpers/screenshot.ts';
import { tap, typeInto, waitForVisible } from '../../helpers/selectors.ts';

/** State the main process reports; the same shape preload.cjs exposes. */
interface InstanceState {
  mode: string | null;
  apiBaseUrl: string | null;
  needsOnboarding: boolean;
  defaultHostName: string;
}

/**
 * Returns the app to a genuine first run: drop the stored config and ask the
 * main process to forget its stack.
 *
 * Per-test rather than once in a hook, because these tests each *configure*
 * the instance — proving the chooser appears on a first run means getting
 * back to one first.
 */
async function returnToOnboarding(): Promise<void> {
  rmSync(path.join(selfContainedDataDir ?? '', 'config.json'), { force: true });
  await browser.execute(async () => {
    const bridge = (window as unknown as {
      shannon?: { instance?: { detach: () => Promise<unknown> } };
    }).shannon;
    await bridge?.instance?.detach();
  });
  await browser.url('app://-/onboarding');
}

async function instanceState(): Promise<InstanceState | null> {
  return browser.execute(async () => {
    const bridge = (window as unknown as {
      shannon?: { instance?: { getState: () => Promise<InstanceState> } };
    }).shannon;
    return (await bridge?.instance?.getState()) ?? null;
  });
}

describe('electron onboarding', () => {
  before(function skipUnlessSelfContained() {
    if (!SELF_CONTAINED) this.skip();
  });

  it('exposes the instance bridge to the renderer', async () => {
    const state = await instanceState();
    expect(state).not.toBeNull();
    // The harness seeded a Solo config (see scripts/electron-env.ts), so a
    // configured install is what this session started against.
    expect(state?.needsOnboarding).toBe(false);
    expect(state?.mode).toBe('solo');
    expect(state?.apiBaseUrl).toBeTruthy();
  });

  it('offers a default host name taken from the machine, not a placeholder', async () => {
    // The name is how a user tells one machine's models from another's, so an
    // empty or invented default would be worse than useless.
    const state = await instanceState();
    expect(state?.defaultHostName).toBeTruthy();
    expect(state?.defaultHostName).not.toBe('undefined');
  });

  it('shows the mode chooser on a genuine first run, and starts a stack from it', async () => {
    // Absence of the config is the first-run signal, so the next resolve has
    // nothing to start and must land on onboarding.
    await returnToOnboarding();
    await waitForVisible('onboarding.mode.solo');
    await waitForVisible('onboarding.mode.host');
    await waitForVisible('onboarding.mode.client');
    await shot('onboarding-mode-chooser');

    // Choosing Solo has to bring a real server up, not just write a file.
    await tap('onboarding.mode.solo');
    await browser.waitUntil(
      async () => {
        const state = await instanceState();
        return state?.mode === 'solo' && !!state.apiBaseUrl;
      },
      { timeout: 60_000, interval: 1000, timeoutMsg: 'stack did not start after choosing Solo' },
    );

    const state = await instanceState();
    const health = await browser.execute(async (url: string) => {
      const res = await fetch(`${url}/health`);
      return res.ok;
    }, state?.apiBaseUrl ?? '');
    expect(health).toBe(true);
    await shot('onboarding-solo-started');
  });

  it('names the host it is about to join before committing to it', async () => {
    // The join step probes /v1/cluster so the screen can say what the user is
    // connecting to rather than echoing back the URL they typed.
    //
    // Probed against the live Solo stack the previous test started — a real
    // server, so this exercises the /v1/cluster read rather than the error
    // path. Navigating here deliberately does *not* detach: the screen stays
    // reachable on a configured install precisely so modes can be changed
    // after setup.
    const running = await instanceState();
    const hostUrl = running?.apiBaseUrl ?? '';
    expect(hostUrl).toBeTruthy();

    await browser.url('app://-/onboarding');
    await waitForVisible('onboarding.mode.client');
    await tap('onboarding.mode.client');

    await typeInto('onboarding.client.url', hostUrl);
    await tap('onboarding.client.check');
    await waitForVisible('onboarding.client.found');
    await shot('onboarding-client-probe');
  });
});
