/**
 * The Check-ins & approvals screen: every wait setting is reachable, saves to
 * the server, and reads back — and the screen's lowest rows can actually be
 * scrolled to.
 *
 * Reachability is asserted, not visibility: WebDriver calls an element past
 * the viewport edge "displayed", so a visibility check passes whether or not
 * anything can scroll to it (see AGENTS.md on SettingsModal and
 * McpServerModal, where exactly that hid a field).
 */
import { browser } from '@wdio/globals';
import { apiToken, uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, tap, testIdSelector, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { openSettings, patchPrefs, signUp } from '../helpers/app.ts';
import { BASE_URL } from '../../scripts/standup.ts';

async function prefs(creds: { email: string; password: string }): Promise<Record<string, unknown>> {
  const token = await apiToken(creds);
  const res = await fetch(`${BASE_URL}/v1/prefs`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`[e2e] GET prefs failed (${String(res.status)})`);
  return (await res.json()) as Record<string, unknown>;
}

async function waitForPref(creds: { email: string; password: string }, key: string, value: unknown): Promise<void> {
  await browser.waitUntil(async () => (await prefs(creds))[key] === value, {
    timeout: 10_000,
    interval: 250,
    timeoutMsg: `expected ${key} to be saved as ${JSON.stringify(value)}`,
  });
}

/** Whether an element's nearest scrolling ancestor can bring it into view —
 * same shape as routines.spec.ts. */
async function reachability(id: string): Promise<{ found: boolean; overflowing: boolean; scrollable: boolean }> {
  return browser.execute((selector: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return { found: false, overflowing: false, scrollable: false };
    let node = el.parentElement;
    let overflowing = false;
    while (node) {
      if (node.scrollHeight > node.clientHeight) overflowing = true;
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        return { found: true, overflowing, scrollable: true };
      }
      node = node.parentElement;
    }
    return { found: true, overflowing, scrollable: false };
  }, testIdSelector(id));
}

describe('the check-ins and approvals settings screen', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  after(async () => {
    await patchPrefs(creds, {
      checkinTimeoutMs: null,
      approvalTimeoutMs: null,
      adaptiveTimeout: true,
      checkinAutoContinues: 2,
      loopSensitivity: 'normal',
    });
  });

  it('opens from Settings and shows the server default by name', async () => {
    await openSettings();
    await tap('settings.nav.checkins');
    await waitForVisible('settings.checkinTimeout.default');
    await waitForTextIn('settings.checkinTimeout.default', 'Server default (');
    await shot('checkin-settings');
  });

  it('quotes the step limit back as the cost of keeping going, and keeps up when it changes', async () => {
    // The two rows sit a few lines apart and used to hold separate copies of
    // the pref, so this sentence went on saying "100" after the row above it
    // had been moved.
    await waitForTextIn('settings.autoContinues.copy', '100 more steps');
    await tap('settings.stepLimit.200');
    await waitForPref(creds, 'maxIterations', 200);
    await waitForTextIn('settings.autoContinues.copy', '200 more steps');
    await tap('settings.stepLimit.100');
    await waitForPref(creds, 'maxIterations', 100);
  });

  it('saves each setting to the server', async () => {
    await tap('settings.checkinTimeout.1800000');
    await waitForPref(creds, 'checkinTimeoutMs', 1_800_000);

    await tap('settings.approvalTimeout.300000');
    await waitForPref(creds, 'approvalTimeoutMs', 300_000);

    await tap('settings.autoContinues.0');
    await waitForPref(creds, 'checkinAutoContinues', 0);
    await waitForTextIn('settings.autoContinues.copy', 'wraps up straight away');

    await tap('settings.adaptiveTimeout.toggle');
    await waitForPref(creds, 'adaptiveTimeout', false);

    await tap('settings.loopSensitivity.relaxed');
    await waitForPref(creds, 'loopSensitivity', 'relaxed');
    await waitForTextIn('settings.loopSensitivity.copy', 'five identical steps');

    // Back to the server default.
    await tap('settings.checkinTimeout.default');
    await waitForPref(creds, 'checkinTimeoutMs', null);
    await shot('checkin-settings-changed');
  });

  it('can scroll to its lowest row on a short window', async function () {
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();
    const before = await browser.getWindowSize();
    await browser.setWindowSize(before.width, 500);
    try {
      const verdict = await reachability('settings.loopSensitivity.off');
      if (!verdict.found) throw new Error('loop sensitivity row not rendered');
      if (verdict.overflowing && !verdict.scrollable) {
        throw new Error('the lowest row is past the fold with nothing able to scroll to it');
      }
      if (!verdict.overflowing) throw new Error('window was not short enough to test scrolling');
      // The DOM's own scrollIntoView, not WebdriverIO's: that one is a wheel
      // action over the page, which does not reach an inner scroll container
      // — so it would fail for a screen that scrolls perfectly well.
      const inView = await browser.execute((selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      }, testIdSelector('settings.loopSensitivity.off'));
      if (!inView) throw new Error('the lowest row could not be brought into view');
      await shot('checkin-settings-scrolled');
    } finally {
      await browser.setWindowSize(before.width, before.height);
    }
  });
});
