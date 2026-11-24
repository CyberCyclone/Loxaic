/**
 * Where the device under test is, set the way each platform really learns it:
 * DevTools' geolocation override and permission on web and Electron, the
 * simulator's own location and privacy settings on iOS, and the emulator's
 * GPS and a granted permission on Android. The app reads it through
 * expo-location exactly as it would a real position.
 */
import { execFile, execFileSync } from 'node:child_process';
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
  // The emulator console takes longitude first.
  execFileSync(adbPath(), ['emu', 'geo', 'fix', String(pos.lon), String(pos.lat)]);
  execFileSync(adbPath(), ['shell', 'pm', 'grant', APP_ID, 'android.permission.ACCESS_COARSE_LOCATION']);
}

/**
 * Keeps the emulator's GPS reporting `pos`, as real hardware does: the
 * emulator sends a fix only when told to, and one sent while nobody was
 * listening is lost, so a request made later never gets one. Every second
 * until the returned stop is called. A no-op elsewhere.
 */
export function keepDeviceAt(pos: { lat: number; lon: number }): () => void {
  if (platform() !== 'android') return () => undefined;
  const timer = setInterval(() => {
    execFile(adbPath(), ['emu', 'geo', 'fix', String(pos.lon), String(pos.lat)], () => undefined);
  }, 1_000);
  return () => { clearInterval(timer); };
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
