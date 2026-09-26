/**
 * The server going away around the moments a phone leaves the app: locking
 * it, switching away, opening it from cold, and simply sitting on a screen.
 *
 * Each has its own way in (lib/connectionMonitor.ts): a return from the
 * background — which is what an unlock is — probes the server and replaces the
 * screen's socket; a cold start asks for the session with a deadline; an open
 * screen has only the heartbeat. Each is checked both ways: with the server up
 * nothing may be said and a send must work, and with it gone the banner and the
 * read-only composer must appear by themselves and clear by themselves.
 *
 * The server is frozen, not killed (helpers/server.ts): a stopped process
 * accepts connections and answers nothing, the case the app cannot learn about
 * from an error.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import { mockEcho, sendAndAwaitReply, signUp } from '../../helpers/app.ts';
import { shot } from '../../helpers/screenshot.ts';
import { isVisible, platform, waitForGone, waitForTextIn, waitForVisible } from '../../helpers/selectors.ts';
import { pauseServer, resumeServer } from '../../helpers/server.ts';

const BANNER = 'shell.offlineBanner';
const APP_ID = 'com.loxaic.app';

const appArg = () => (platform() === 'ios' ? { bundleId: APP_ID } : { appId: APP_ID });
const unlock = () => browser.execute('mobile: unlock');
/** Appium's app states: 4 is running in the foreground. */
const FOREGROUND = 4;

/** Each of these checks the device really did it — a "says nothing" case
 * would otherwise pass with nothing having happened at all — and waits for it:
 * the command returns before the system has finished moving the app. */
async function lock(): Promise<void> {
  await browser.execute('mobile: lock');
  await browser.waitUntil(async () => {
    const locked: unknown = await browser.execute('mobile: isLocked');
    return locked === true;
  }, {
    timeout: 5_000,
    timeoutMsg: 'the device did not lock',
  });
}

/** Switch away and stay away (a negative duration never comes back by itself). */
async function leaveApp(): Promise<void> {
  await browser.execute('mobile: backgroundApp', { seconds: -1 });
  await browser.waitUntil(async () => (await browser.execute('mobile: queryAppState', appArg())) !== FOREGROUND, {
    timeout: 5_000,
    timeoutMsg: 'the app is still in the foreground',
  });
}
const returnToApp = () => browser.execute('mobile: activateApp', appArg());
const quitApp = () => browser.execute('mobile: terminateApp', appArg());

/** A return that reconnects in time says nothing. Polled — native has no
 * MutationObserver, so a flash shorter than a poll could slip by; the web lane's
 * approval-reconnect.spec.ts holds that line with one. */
async function expectNoBannerFor(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await isVisible(BANNER)) throw new Error('the connection banner appeared with the server up');
    await browser.pause(150);
  }
}

async function expectDisconnected(timeout: number): Promise<void> {
  await waitForVisible(BANNER, timeout);
  await waitForVisible('composer.readOnly', 5_000);
}

async function expectRecovered(): Promise<void> {
  await waitForGone(BANNER, 30_000);
  await waitForVisible('composer.input', 10_000);
}

describe('the server and the phone leaving the app', () => {
  const creds = uniqueCreds();
  let sent = 0;
  /** The newest message, which is what a cold start should reopen on screen
   * (older ones may be scrolled out of the virtualised list). */
  let lastMessage = '';
  const say = async (label: string) => {
    sent += 1;
    lastMessage = `${label} ${String(sent)}`;
    await sendAndAwaitReply(lastMessage, mockEcho(lastMessage));
  };

  before(async function () {
    const p = platform();
    if (p !== 'ios' && p !== 'android') this.skip();
    await signUp(creds);
    // A live conversation, so there is a socket for the monitor to track.
    await say('hello');
  });

  afterEach(async () => {
    resumeServer();
    // Whatever a failure left behind, the next case starts unlocked and in
    // the app.
    await unlock().catch(() => undefined);
    await returnToApp().catch(() => undefined);
  });

  it('says nothing after an unlock with the server up, and sends', async () => {
    await lock();
    await browser.pause(5_000);
    await unlock();
    await expectNoBannerFor(3_000);
    await say('after unlocking');
  });

  it('says the server is gone after an unlock, and recovers by itself', async () => {
    await lock();
    pauseServer();
    await browser.pause(3_000);
    await unlock();
    await expectDisconnected(15_000);
    await shot('native-unlock-server-gone');
    resumeServer();
    await expectRecovered();
    await say('back after unlocking');
  });

  it('says nothing after switching back with the server up, and sends', async () => {
    await leaveApp();
    await browser.pause(5_000);
    await returnToApp();
    await expectNoBannerFor(3_000);
    await say('after switching back');
  });

  it('says the server is gone after switching back, and recovers by itself', async () => {
    await leaveApp();
    pauseServer();
    await browser.pause(3_000);
    await returnToApp();
    await expectDisconnected(15_000);
    await shot('native-return-server-gone');
    resumeServer();
    await expectRecovered();
    await say('back after switching');
  });

  it('notices the server going away while the app is open', async () => {
    // Nothing to return from: only the heartbeat (every 25 s) can notice.
    pauseServer();
    await expectDisconnected(60_000);
    await shot('native-open-server-gone');
    resumeServer();
    await expectRecovered();
    await say('back while open');
  });

  it('opens from cold on a hung server with what was saved, and catches up', async () => {
    await quitApp();
    pauseServer();
    await returnToApp();
    // Start-up waits at most 5 s for the session; it used to wait out the
    // platform's own network timeout on the splash screen.
    await expectDisconnected(30_000);
    await waitForTextIn('chat.messageList', mockEcho(lastMessage), 10_000);
    await shot('native-cold-start-server-gone');
    resumeServer();
    await expectRecovered();
    await say('back after a cold start');
  });
});
