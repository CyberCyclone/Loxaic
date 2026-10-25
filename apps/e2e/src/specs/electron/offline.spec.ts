/**
 * Offline behaviour: the cached copy, the banner, and a composer that refuses
 * rather than silently dropping the message.
 *
 * **Electron, not web** — and the reason is the feature itself. The web build
 * is served *by the host we are pretending is dead*, so cutting the network
 * takes the page down with it: reloading offline gets a browser error, not an
 * app showing its cache. Electron loads from the local `app://` scheme, so it
 * is a real client that outlives its server, which is precisely the situation
 * an offline cache exists for. (Native is the same shape; it is left out only
 * because Appium's connectivity controls are Android-only and do not cut the
 * `10.0.2.2` host alias the harness reaches the server through, so a native
 * version would claim more than it proved.)
 *
 * The cut itself is genuine: Chrome DevTools' `Network.emulateNetworkConditions`
 * turning the renderer's network off.
 */
import { uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { isVisible, waitForVisible, waitForTextIn } from '../../helpers/selectors.ts';
import { mockEcho, sendAndAwaitReply, signUp, startNewThread } from '../../helpers/app.ts';

/** A DevTools session on the window WebDriver drives, found by its URL rather than list order. */
async function openDevTools() {
  const url = await browser.getUrl();
  const page = (await (await browser.getPuppeteer()).pages()).find((p) => p.url() === url);
  if (!page) throw new Error(`[e2e] no DevTools page for the window at ${url}`);
  return page.createCDPSession();
}

/**
 * One DevTools session both cuts and restores the network. Not
 * `browser.throttleNetwork`: it opens a new session per call, and on Electron 44
 * (Chromium 152) the offline condition one session set outlives another session
 * sending "online", so the network never came back.
 */
let devtools: ReturnType<typeof openDevTools> | undefined;

async function setOffline(offline: boolean): Promise<void> {
  // A failed open is not kept: the next call, `after`'s goOnline included, tries again.
  devtools ??= openDevTools().catch((err: unknown) => {
    devtools = undefined;
    throw err;
  });
  await (await devtools).send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

/** Cuts the renderer's network, the way a host going away looks to the app. */
async function goOffline(): Promise<void> {
  await setOffline(true);
}

async function goOnline(): Promise<void> {
  await setOffline(false);
}

describe('offline', () => {
  const creds = uniqueCreds();
  const prompt = 'something worth keeping';
  const secondPrompt = 'a second thread, more recent';

  before(async () => {
    await signUp(creds);
    // Two conversations, not one. With a single conversation the spec could
    // not tell whether the cache was working or whether the history fetch had
    // merely repaired the one thread it happened to open — which is exactly
    // how a bug that emptied every *other* cached thread got past it.
    await sendAndAwaitReply(prompt, mockEcho(prompt));
    await startNewThread('chat');
    await sendAndAwaitReply(secondPrompt, mockEcho(secondPrompt));
  });

  after(async () => {
    // Never leave the browser offline: every later spec in this session would
    // fail for reasons that have nothing to do with them.
    await goOnline();
  });

  it('starts up against a dead host and still shows your conversations', async () => {
    // The scenario #77 is actually about: kill the host, restart the client.
    // Reloading with the network cut runs the whole bootstrap offline — the
    // session check fails, the conversation fetch fails, and what renders is
    // the local cache.
    //
    // Deliberately a reload rather than waiting for the socket to notice:
    // Chrome's offline mode does not reliably close an already-open
    // WebSocket, so `onclose` may never fire, and a test that waited for it
    // would be asserting on Chrome's behaviour rather than the app's.
    await goOffline();
    await browser.refresh();

    await waitForVisible('shell.offlineBanner');
    await shot('offline-banner');
  });

  it('opens the most recent cached thread, read-only', async () => {
    // The cache's job: an unreachable host must not empty the screen. The
    // *newest* thread is the one that opens — ordering by the conversation's
    // own recency, not by when the cache happened to write it — and the
    // composer is an explanation rather than an input, because a send now
    // would be dropped.
    await waitForTextIn('chat.messageList', mockEcho(secondPrompt));
    await waitForVisible('composer.readOnly');
    expect(await isVisible('composer.input')).toBe(false);
    await shot('offline-cached-thread');
  });

  it('still holds the other thread’s messages, not just the open one', async () => {
    // The write-path bug this guards: the list fetch used to overwrite every
    // cached thread with an empty message list, so only the thread the user
    // last opened survived. Switching to the older thread offline must show
    // its reply from the cache.
    await $(`//*[contains(text(), ${JSON.stringify(prompt)})]`).click();
    await waitForTextIn('chat.messageList', mockEcho(prompt));
    await shot('offline-other-cached-thread');
  });

  it('recovers when the server comes back', async () => {
    await goOnline();
    await browser.refresh();
    await browser.waitUntil(async () => !(await isVisible('shell.offlineBanner')), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'offline banner did not clear after the network returned',
    });
    // And the composer is a composer again.
    await waitForVisible('composer.input');
    await shot('offline-recovered');
  });
});
