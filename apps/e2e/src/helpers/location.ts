/**
 * Where the device under test is, set the way each platform really learns it:
 * DevTools' geolocation override and permission on web and Electron, the
 * simulator's own location and privacy settings on iOS, and a mock location
 * provider and a granted permission on Android. The app reads it through
 * expo-location exactly as it would a real position.
 */
import { execFileSync } from 'node:child_process';
import { browser } from '@wdio/globals';
import { platform, tap } from './selectors.ts';
import { apiToken, type Credentials } from './auth.ts';
import { getToolResults, goToSurface, listConversations, listFavouriteQuestions, startNewThread } from './app.ts';
import { adbPath, bootedIosDevice } from '../../scripts/native.ts';
import { BASE_URL } from '../../scripts/standup.ts';

export const BRISBANE = { lat: -27.4679, lon: 153.0281 };

const APP_ID = 'com.loxaic.app';

async function page() {
  const url = await browser.getUrl();
  const pages = await (await browser.getPuppeteer()).pages();
  const found = pages.find((p) => p.url() === url);
  if (!found) throw new Error(`[e2e] no DevTools page for the window at ${url}`);
  return found;
}

/** Puts the device at `pos`, with location permission granted. */
export async function placeDeviceAt(pos: { lat: number; lon: number }): Promise<void> {
  const p = platform();
  if (p === 'web' || p === 'electron') {
    const target = await page();
    const session = await target.createCDPSession();
    await session.send('Emulation.setGeolocationOverride', { latitude: pos.lat, longitude: pos.lon, accuracy: 100 });
    // Electron grants every permission itself; Chrome needs telling.
    if (p === 'web') {
      await session.send('Browser.grantPermissions', { origin: new URL(target.url()).origin, permissions: ['geolocation'] });
    }
    return;
  }
  if (p === 'ios') {
    const udid = bootedIosDevice(process.env.E2E_IOS_DEVICE ?? 'iPhone 17', process.env.E2E_IOS_VERSION);
    execFileSync('xcrun', ['simctl', 'location', udid, 'set', `${String(pos.lat)},${String(pos.lon)}`]);
    execFileSync('xcrun', ['simctl', 'privacy', udid, 'grant', 'location', APP_ID]);
    return;
  }
  // Appium's settings app becomes the mock provider for gps, network and
  // fused alike, and keeps reporting the position as a phone would. (The
  // emulator console's `geo fix` is not reachable through adb on every setup,
  // and sends one fix.) Allowed to mock first: without it the service starts
  // and changes nothing.
  execFileSync(adbPath(), ['shell', 'appops', 'set', 'io.appium.settings', 'android:mock_location', 'allow']);
  execFileSync(adbPath(), [
    'shell', 'am', 'start-foreground-service', '--user', '0', '-n', 'io.appium.settings/.LocationService',
    '--es', 'longitude', String(pos.lon), '--es', 'latitude', String(pos.lat),
  ]);
  execFileSync(adbPath(), ['shell', 'pm', 'grant', APP_ID, 'android.permission.ACCESS_COARSE_LOCATION']);
}

/** Refuses location permission to the page, as a person who said no to the
 * browser's own prompt. Web only: a native permission refused this way kills
 * the app on Android and needs a relaunch on iOS. */
export async function refuseBrowserLocation(): Promise<void> {
  const target = await page();
  const session = await target.createCDPSession();
  await session.send('Browser.resetPermissions', {});
  await session.send('Browser.setPermission', {
    permission: { name: 'geolocation' },
    setting: 'denied',
    origin: new URL(target.url()).origin,
  });
}

export const WEATHER = "What's the weather like today?";

/** `creds`' location setting, from the API. */
export async function locationSharing(creds: Pick<Credentials, 'email' | 'password'>): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/prefs`, { headers: { authorization: `Bearer ${await apiToken(creds)}` } });
  return ((await res.json()) as { locationSharing: string }).locationSharing;
}

/** Taps the weather favourite on a new chat (the mock calls get_location for
 * "weather"); resolves with its conversation once the send has started. */
export async function askForTheWeather(creds: Pick<Credentials, 'email' | 'password'>): Promise<string> {
  await goToSurface('chat');
  await startNewThread('chat');
  const weather = (await listFavouriteQuestions(creds)).find((q) => q.text === WEATHER);
  if (!weather) throw new Error('the weather favourite is gone');
  const before = new Set((await listConversations(creds)).map((c) => c.id));
  await tap(`favourites.question.${weather.id}`);
  let convId = '';
  await browser.waitUntil(
    async () => {
      convId = (await listConversations(creds)).find((c) => !before.has(c.id))?.id ?? '';
      return convId !== '';
    },
    { timeout: 20_000, timeoutMsg: 'the weather question never started a conversation' },
  );
  return convId;
}

/** What get_location told the model in a conversation, once it is stored. */
export async function locationResultOf(creds: Pick<Credentials, 'email' | 'password'>, convId: string): Promise<string> {
  let output = '';
  await browser.waitUntil(
    async () => {
      output = (await getToolResults(creds, convId)).at(0)?.output ?? '';
      return output !== '';
    },
    { timeout: 40_000, interval: 500, timeoutMsg: 'no location result was stored' },
  );
  return output;
}
