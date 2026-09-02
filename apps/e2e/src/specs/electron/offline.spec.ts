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
 * The cut itself is genuine: `browser.throttleNetwork('offline')` is Chrome DevTools
 * turning the renderer's network off.
 */
import { uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { isVisible, waitForVisible, waitForTextIn } from '../../helpers/selectors.ts';
import { mockEcho, sendAndAwaitReply, signUp } from '../../helpers/app.ts';

/** Cuts the renderer's network, the way a host going away looks to the app. */
async function goOffline(): Promise<void> {
  await browser.throttleNetwork('offline');
}

async function goOnline(): Promise<void> {
  await browser.throttleNetwork('online');
}

describe('offline', () => {
  const creds = uniqueCreds();
  const prompt = 'something worth keeping';

  before(async () => {
    await signUp(creds);
    // A conversation with real content, so there is something to cache.
    await sendAndAwaitReply(prompt, mockEcho(prompt));
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

  it('shows the cached thread, read-only', async () => {
    // The cache's job: an unreachable host must not empty the screen. The
    // reply is still there to read, from local storage rather than the server
    // — and the composer is an explanation rather than an input, because a
    // send now would be dropped.
    await waitForTextIn('chat.messageList', mockEcho(prompt));
    await waitForVisible('composer.readOnly');
    expect(await isVisible('composer.input')).toBe(false);
    await shot('offline-cached-thread');
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
