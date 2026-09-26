/**
 * The server going away, as the whole app sees it.
 *
 * Whether the server could be reached used to be decided by whichever screen
 * was open, and shown only by three of them: chat, agent and a routine's chat.
 * Everywhere else the buttons stayed pressable and failed, some silently, and
 * the sidebar said "Server connected" whatever was true. Now one monitor decides
 * (apps/mobile/lib/connectionMonitor.ts), one banner in the shell says it, and
 * every control that needs the server is disabled on every screen.
 *
 * The server is cut from inside the page — the web lane's server also serves
 * the page, so stopping it would take the app with it: requests to the API
 * fail as a network error would, and sockets are pointed at a port nothing
 * listens on. Hiding and showing the page makes the app replace its live
 * socket, which then gets the dead one.
 */
import { browser } from '@wdio/globals';
import { BASE_URL } from '../../scripts/standup.ts';
import { uniqueCreds } from '../helpers/auth.ts';
import { shot } from '../helpers/screenshot.ts';
import { platform, tap, testIdSelector, waitForGone, waitForTextIn, waitForVisible } from '../helpers/selectors.ts';
import { chooseScratchWorkspace, goToSurface, mockEcho, sendAndAwaitReply, sendMessage, signUp } from '../helpers/app.ts';

const BANNER = 'shell.offlineBanner';
const PLAN_PROMPT = 'Propose a plan to tidy the README.';

/** Every request to the API fails as a dead network would, and every socket
 * goes to a port with nothing on it. */
async function cutServer(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __realFetch?: typeof fetch;
      __RealWebSocket?: typeof WebSocket;
    };
    w.__realFetch ??= window.fetch.bind(window);
    w.__RealWebSocket ??= window.WebSocket;
    const realFetch = w.__realFetch;
    const RealWebSocket = w.__RealWebSocket;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      if (/^\/(v1|api|health)(\/|$)/.test(path)) return Promise.reject(new TypeError('Failed to fetch'));
      return realFetch(input, init);
    };
    class DeadSocket extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(String(url).includes('/ws/') ? 'ws://127.0.0.1:9/' : url, protocols);
      }
    }
    window.WebSocket = DeadSocket;
    // Replace the socket that is open now, as a return to the app does.
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function restoreServer(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __realFetch?: typeof fetch; __RealWebSocket?: typeof WebSocket };
    if (w.__realFetch) window.fetch = w.__realFetch;
    if (w.__RealWebSocket) window.WebSocket = w.__RealWebSocket;
  });
}

async function isDisabled(id: string): Promise<boolean> {
  return browser.execute(
    (selector: string) => document.querySelector(selector)?.getAttribute('aria-disabled') === 'true',
    testIdSelector(id),
  );
}

/** Every element whose testID starts with `prefix`, and whether each is
 * disabled. */
async function allDisabled(prefix: string): Promise<{ count: number; enabled: string[] }> {
  return browser.execute((p: string) => {
    const els = Array.from(document.querySelectorAll(`[data-testid^="${p}"]`));
    return {
      count: els.length,
      enabled: els.filter((e) => e.getAttribute('aria-disabled') !== 'true').map((e) => e.getAttribute('data-testid') ?? ''),
    };
  }, prefix);
}

describe('the server becoming unreachable', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
  });

  afterEach(async () => {
    await restoreServer();
  });

  it('is said once for the whole app, and nothing that needs the server can be pressed', async function () {
    this.timeout(4 * 60_000);
    const p = platform();
    if (p !== 'web' && p !== 'electron') this.skip();

    // The sidebar names the host the app really talks to — the API's, which
    // on Electron is not the page's (that is app://) — and its real state.
    await waitForTextIn('sidebar.serverHost', new URL(BASE_URL).hostname);
    await waitForTextIn('sidebar.serverStatus', 'Server connected');

    // A plan waiting on a decision.
    await goToSurface('agent');
    await chooseScratchWorkspace();
    await tap('agent.mode.planning');
    await sendMessage(PLAN_PROMPT);
    await waitForVisible('agent.plan.panel', 90_000);
    await waitForVisible('agent.plan.accept');

    await cutServer();
    await waitForTextIn(BANNER, "Can't reach your server", 30_000);
    await waitForTextIn('sidebar.serverStatus', "Can't reach server");
    // The decision waits, and the panel — which covers the banner — says why.
    await waitForTextIn('agent.plan.status', "Can't reach your server");
    await shot('unreachable-agent-plan');
    await tap('agent.plan.close');
    await waitForGone('agent.plan.panel');
    for (const mode of ['planning', 'manual', 'auto']) {
      if (!(await isDisabled(`agent.mode.${mode}`))) throw new Error(`agent.mode.${mode} was pressable while unreachable`);
    }
    if (!(await isDisabled('agent.workspace.button'))) throw new Error('the workspace chooser was pressable while unreachable');

    // Chat: the same banner, and a composer that explains instead of sending.
    await tap('sidebar.nav.chat');
    await waitForVisible('composer.readOnly', 20_000);
    await waitForTextIn(BANNER, "Can't reach your server");
    await shot('unreachable-chat');

    // Back: Retry clears it at once.
    await restoreServer();
    await tap('shell.offlineRetry');
    await waitForGone(BANNER, 15_000);
    await waitForTextIn('sidebar.serverStatus', 'Server connected');

    // A settings screen, which has no socket of its own, used to say nothing
    // at all when the server went away. Loaded while reachable, then cut — on
    // a screen with nothing to replace, the monitor's own probe has to notice.
    await tap('sidebar.settings');
    await tap('settings.nav.checkins');
    await waitForVisible('checkins.scroll', 20_000);
    const before = await allDisabled('settings.stepLimit.');
    if (before.count === 0) throw new Error('no step-limit choices rendered');
    if (before.enabled.length !== before.count) throw new Error('settings were disabled while the server was reachable');

    await cutServer();
    await waitForTextIn(BANNER, "Can't reach your server", 30_000);
    const cut = await allDisabled('settings.stepLimit.');
    if (cut.enabled.length > 0) throw new Error(`pressable while unreachable: ${cut.enabled.join(', ')}`);
    await shot('unreachable-settings');

    await restoreServer();
    await tap('shell.offlineRetry');
    await waitForGone(BANNER, 15_000);
    const after = await allDisabled('settings.stepLimit.');
    if (after.enabled.length !== after.count) throw new Error('settings stayed disabled after the server came back');

    // And the chat that was cut off sends again.
    await goToSurface('chat');
    await sendAndAwaitReply('Hello again', mockEcho('Hello again'));
    await shot('unreachable-recovered');
  });
});
