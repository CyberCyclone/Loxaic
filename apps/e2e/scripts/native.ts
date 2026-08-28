/**
 * Shared plumbing for the two Appium-driven platforms.
 *
 * Appium's drivers are installed into a repo-local APPIUM_HOME rather than the
 * user's home directory, so a run uses the driver versions this repo pins
 * instead of whatever a developer happens to have installed globally.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APPIUM_HOME = path.join(E2E_DIR, '.appium');
export const MOBILE_DIR = path.resolve(E2E_DIR, '../mobile');

export function requireAppiumDrivers(): void {
  if (!existsSync(path.join(APPIUM_HOME, 'node_modules'))) {
    throw new Error(
      `No Appium drivers installed at ${APPIUM_HOME}. Run: pnpm --filter @shannon/e2e setup:appium`,
    );
  }
  process.env.APPIUM_HOME = APPIUM_HOME;
}

/**
 * Resolves the Android SDK and exports ANDROID_HOME for the Appium subprocess,
 * which refuses to start a session without it.
 *
 * Falls back to Android Studio's default install location so a fresh checkout
 * works without the developer having to export anything — but only if that
 * directory actually exists, so a genuinely missing SDK still fails loudly
 * rather than being papered over with a path that isn't there.
 */
export function ensureAndroidEnv(): string {
  const configured = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (configured) {
    process.env.ANDROID_HOME = configured;
    return configured;
  }

  const fallback = path.join(process.env.HOME ?? '', 'Library/Android/sdk');
  if (!existsSync(fallback)) {
    throw new Error(
      'Android SDK not found. Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your SDK location — ' +
        `it is not set, and there is nothing at the default ${fallback}.`,
    );
  }
  process.env.ANDROID_HOME = fallback;
  return fallback;
}

export function adbPath(): string {
  return path.join(ensureAndroidEnv(), 'platform-tools/adb');
}

/**
 * Maps a port on the device back to the same port on this machine.
 *
 * The emulator can already reach the host as 10.0.2.2, but that alias is
 * emulator-only and pins the app to one hard-coded address. Reversing the port
 * lets the app talk to plain `localhost` instead, which behaves identically on
 * an emulator and on a physical device plugged into USB.
 */
export function adbReverse(port: number): void {
  execFileSync(adbPath(), ['reverse', `tcp:${String(port)}`, `tcp:${String(port)}`], {
    stdio: 'ignore',
  });
}

export function adbReverseRemove(port: number): void {
  try {
    execFileSync(adbPath(), ['reverse', '--remove', `tcp:${String(port)}`], { stdio: 'ignore' });
  } catch {
    // Emulator already gone, or the mapping was never made — nothing to undo.
  }
}

export function androidApkPath(): string {
  const apk = path.join(
    MOBILE_DIR,
    'android/app/build/outputs/apk/release/app-release.apk',
  );
  if (!existsSync(apk)) {
    throw new Error(
      `No Android release APK at ${apk}.\n` +
        `Build one first (see apps/e2e/README.md):\n` +
        `  pnpm --filter @shannon/mobile prebuild:android\n` +
        `  cd apps/mobile/android && EXPO_PUBLIC_API_URL=<base-url> ./gradlew assembleRelease`,
    );
  }
  return apk;
}

/**
 * Boots the target simulator (Appium would anyway) and resets its keychain.
 *
 * Unlike Android — where uninstalling the app wipes its SecureStore data —
 * the iOS keychain survives app reinstalls, so a previous run's session token
 * auto-signs the app in and the suite's sign-up spec never sees a login
 * screen. Without this, the iOS suite passes once per simulator and then
 * fails on every re-run. The keychain on a dedicated test simulator holds
 * nothing worth keeping.
 */
export function resetIosSimulatorKeychain(deviceName: string, osVersion?: string): void {
  const listJson = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(listJson) as {
    devices: Record<string, { name: string; udid: string; state: string }[]>;
  };
  const candidates = Object.entries(parsed.devices)
    .filter(([runtime]) => !osVersion || runtime.endsWith(osVersion.replace(/\./g, '-')))
    .flatMap(([, list]) => list)
    .filter((d) => d.name === deviceName);
  const device = candidates.at(0);
  if (!device) {
    throw new Error(
      `No available simulator named "${deviceName}"${osVersion ? ` on iOS ${osVersion}` : ''}. ` +
        `See: xcrun simctl list devices available`,
    );
  }
  if (device.state !== 'Booted') {
    execFileSync('xcrun', ['simctl', 'boot', device.udid], { stdio: 'ignore' });
    execFileSync('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { stdio: 'ignore' });
  }
  execFileSync('xcrun', ['simctl', 'keychain', device.udid, 'reset'], { stdio: 'ignore' });
}

export function iosAppPath(): string {
  const fromEnv = process.env.E2E_IOS_APP;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`E2E_IOS_APP does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const app = path.join(
    MOBILE_DIR,
    'ios/build/Build/Products/Release-iphonesimulator/openshannon.app',
  );
  if (!existsSync(app)) {
    throw new Error(
      `No iOS simulator build at ${app}.\n` +
        `Build one first (see apps/e2e/README.md), or point E2E_IOS_APP at a .app bundle.`,
    );
  }
  return app;
}
