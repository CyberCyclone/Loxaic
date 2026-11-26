/**
 * The location tool where only a page can arrange the failure: the browser
 * refusing the location, an answer lost with its socket, and the Location
 * settings screen opened while the server refuses. The cases that every
 * platform has are in location-tool.spec.ts.
 */
import { browser } from '@wdio/globals';
import { uniqueCreds } from '../../helpers/auth.ts';
import { shot } from '../../helpers/screenshot.ts';
import { platform, tap, testIdSelector, waitForAbsent, waitForFreshText, waitForVisible } from '../../helpers/selectors.ts';
import { openSettings, revealInSettings, signUp } from '../../helpers/app.ts';
import { cutServer, restoreServer } from '../../helpers/outage.ts';
import { askForTheWeather, BRISBANE, locationResultOf, placeDeviceAt, refuseBrowserLocation } from '../../helpers/location.ts';

/** The next `device.answer` frame is dropped, and its socket closed as it
 * goes out: the answer never reaches the server, as when a phone's socket
 * dies with the frame. The hook reconnects on its own, as after any drop. */
async function loseNextAnswer(): Promise<void> {
  await browser.execute(() => {
    const proto = WebSocket.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'send')?.value as WebSocket['send'];
    proto.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string' && data.includes('"type":"device.answer"')) {
        proto.send = original;
        this.close();
        return;
      }
      original.call(this, data);
    };
  });
}

describe('the location tool, in a page', () => {
  const creds = uniqueCreds();

  before(async () => {
    await signUp(creds);
    await placeDeviceAt(BRISBANE);
  });

  afterEach(async () => {
    await restoreServer();
  });

  it('asks again when the answer was lost with its socket', async () => {
    const convId = await askForTheWeather(creds);
    await waitForVisible('chat.location.bar');
    await loseNextAnswer();
    await tap('chat.location.deny');
    // Answered as far as the page knows, and the socket gone with the answer.
    // The replacement opens within the hook's one-second backoff, and with it
    // the question is back, ready to answer; it stays gone without the fix.
    await browser.pause(3_000);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (selector: string) => {
            const el = document.querySelector(selector);
            return el !== null && el.getAttribute('aria-disabled') !== 'true';
          },
          testIdSelector('chat.location.allowOnce'),
        ),
      { timeout: 30_000, interval: 300, timeoutMsg: 'the question never came back after its answer was lost' },
    );
    await shot('location-asked-again');
    await tap('chat.location.allowOnce');
    expect(await locationResultOf(creds, convId)).toMatch(/^Approximate location: Brisbane/);
    await waitForAbsent('chat.location.bar', 30_000);
  });

  it('tells the model why when the browser refuses the location', async function () {
    // Electron grants every permission itself, so there is nothing to refuse.
    if (platform() !== 'web') this.skip();
    await refuseBrowserLocation();
    const convId = await askForTheWeather(creds);
    await tap('chat.location.allowOnce');
    expect(await locationResultOf(creds, convId)).toContain('location permission is turned off for Loxaic on that device');
    await placeDeviceAt(BRISBANE);
  });

  it('loads the Location settings once the server is back', async () => {
    await cutServer();
    await openSettings();
    await revealInSettings('settings.nav.location');
    await tap('settings.nav.location');
    await waitForFreshText('location.unavailable', 'could not be loaded', 30_000);
    await restoreServer();
    await waitForVisible('location.sharing.ask', 60_000);
    await tap('location.sharing.always');
    await waitForFreshText('location.sharing.help', 'shared without you seeing it happen');
    await shot('location-settings-always');
    await tap('location.sharing.ask');
  });
});
