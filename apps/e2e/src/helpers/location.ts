/**
 * Where the device under test is, set the way each platform really learns it:
 * DevTools' geolocation override and permission on web and Electron, the
 * simulator's own location and privacy settings on iOS, and a mock location
 * provider and a granted permission on Android. The app reads it through
 * expo-location exactly as it would a real position.
 */
import { execFileSync } from 'node:child_process';
import { browser } from '@wdio/globals';
import { platform } from './selectors.ts';
import { adbPath, bootedIosDevice } from '../../scripts/native.ts';

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
  // Appium's settings app becomes a mock location provider, which keeps
  // reporting the position as a phone's GPS would. (The emulator console's
  // `geo fix` is not reachable through adb on every setup, and sends one fix.)
  await browser.execute('mobile: setGeolocation', { latitude: pos.lat, longitude: pos.lon });
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
