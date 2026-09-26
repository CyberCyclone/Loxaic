/**
 * The desktop's version of a phone being locked: the Mac sleeping, waking,
 * locking and unlocking.
 *
 * A page cannot see a Mac go to sleep with its window open, and nothing pings a
 * socket from either end, so a laptop used to wake holding sockets that still
 * said "open" to a server that had restarted or dropped them while it slept.
 * The main process forwards Electron's powerMonitor to the page
 * (apps/desktop/src/power.js), and the connection monitor treats sleep and
 * wake exactly as it treats leaving the app and coming back.
 *
 * The events here are the real powerMonitor's, emitted in the main process
 * through the test service's inspector bridge — the app's own listeners
 * receive them exactly as they would from the OS. The server is frozen, not
 * killed (helpers/server.ts).
 *
 * Minimising the window is not here, deliberately. On macOS the only route
 * from a window being out of sight to the page's visibility is Chromium's
 * occlusion tracker — minimise, hide and Cmd-H all go through it — and it runs
 * asynchronously against every other window on the screen, so a case built on
 * it passed or failed with whatever else was open on the machine. The lane
 * turns occlusion off (wdio.electron.ts) for that reason. What the app does
 * with a page going hidden and coming back is ours, and is covered on the web
 * lane (approval-reconnect.spec.ts, server-unreachable.spec.ts).
 */
import { $, browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import { mockEcho, sendAndAwaitReply, signUp } from '../../helpers/app.ts';
import { shot } from '../../helpers/screenshot.ts';
import { waitForGone, waitForVisible } from '../../helpers/selectors.ts';
import { pauseServer, resumeServer } from '../../helpers/server.ts';

const BANNER = 'shell.offlineBanner';
const HEARTBEAT_MS = 25_000;

type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

async function power(event: PowerEvent): Promise<void> {
  await browser.electron.execute((electron, e: PowerEvent) => {
    electron.powerMonitor.emit(e);
  }, event);
}

interface Watched {
  health: number;
  sockets: number;
  bannerSeen: boolean;
  /** Every visibility change, so a failure says whether the page ever came back. */
  visibility: string[];
}

/** Counts, from now, every health probe and every socket the page opens, and
 * whether the banner was ever in the DOM — however briefly. */
async function watch(): Promise<void> {
  await browser.execute((banner: string) => {
    const w = window as unknown as {
      __watched?: Watched;
      __watchInstalled?: boolean;
    };
    w.__watched = { health: 0, sockets: 0, bannerSeen: false, visibility: [document.visibilityState] };
    if (w.__watchInstalled) return;
    w.__watchInstalled = true;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname === '/health' && w.__watched) w.__watched.health += 1;
      return realFetch(input, init);
    };
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (w.__watched) w.__watched.sockets += 1;
      }
    };
    document.addEventListener('visibilitychange', () => { w.__watched?.visibility.push(document.visibilityState); });
    new MutationObserver(() => {
      if (w.__watched && document.querySelector(banner)) w.__watched.bannerSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  }, `[data-testid="${BANNER}"]`);
}

async function watched(): Promise<Watched> {
  return browser.execute(() => (window as unknown as { __watched: Watched }).__watched);
}

async function waitForReconnect(): Promise<void> {
  try {
    await browser.waitUntil(async () => {
      const w = await watched();
      return w.health > 0 && w.sockets > 0;
    }, { timeout: 5_000 });
  } catch {
    throw new Error(`coming back should probe and replace the socket; saw ${JSON.stringify(await watched())}`);
  }
}

describe('the Mac sleeping, waking and locking', () => {
  const creds = uniqueCreds();
  let sent = 0;
  const say = async (label: string) => {
    sent += 1;
    const text = `${label} ${String(sent)}`;
    await sendAndAwaitReply(text, mockEcho(text));
  };

  before(async () => {
    await signUp(creds);
    // A live conversation, so there is a socket for the monitor to track.
    await say('hello');
    // A hidden window is already "away", and a wake then has nothing to
    // return from: every case below would pass or fail for the wrong reason.
    const visibility = await browser.execute(() => document.visibilityState);
    if (visibility !== 'visible') throw new Error(`the app window is ${visibility}; it must be showing for this spec`);
  });

  afterEach(() => {
    resumeServer();
  });

  it('checks nothing while asleep, and reconnects the moment it wakes', async () => {
    await watch();
    await power('suspend');
    // Longer than a heartbeat: an awake app would have probed by now.
    await browser.pause(HEARTBEAT_MS + 5_000);
    const asleep = await watched();
    if (asleep.health || asleep.sockets) throw new Error(`asleep, yet ${JSON.stringify(asleep)}`);
    await power('resume');
    await waitForReconnect();
    await browser.pause(1_000);
    if ((await watched()).bannerSeen) throw new Error('the banner flashed on an ordinary wake');
    await say('after waking');
  });

  it('reconnects on an unlock too', async () => {
    await watch();
    await power('lock-screen');
    await browser.pause(2_000);
    await power('unlock-screen');
    await waitForReconnect();
    await browser.pause(1_000);
    if ((await watched()).bannerSeen) throw new Error('the banner flashed on an ordinary unlock');
    await say('after unlocking');
  });

  it('wakes to a server that went away while it slept, and says so', async () => {
    await power('suspend');
    pauseServer();
    await browser.pause(2_000);
    await power('resume');
    // At once, not at the next heartbeat (up to 25 s later): waking is
    // itself a reason to ask.
    await waitForVisible(BANNER, 5_000);
    await waitForVisible('composer.readOnly', 5_000);
    // "Reconnecting", then "Can't reach server" after a few failed probes —
    // either way, no longer claiming to be connected.
    const status = await $('[data-testid="sidebar.serverStatus"]').getText();
    if (status.includes('Server connected')) throw new Error('the sidebar still says the server is connected');
    await shot('electron-wake-server-gone');
    resumeServer();
    await waitForGone(BANNER, 30_000);
    await say('back after waking');
  });
});
