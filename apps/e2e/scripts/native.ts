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

/**
 * Ceiling on the device-seeding calls below. Both shell out to daemons that
 * can wedge (a stuck simulator `assetsd` makes `simctl addmedia` hang
 * indefinitely rather than fail), and a hang inside onPrepare is far worse
 * than a loud failure: the suite would sit there until the CI job's own
 * timeout with nothing to point at.
 */
const SEED_TIMEOUT_MS = 60_000;

export const APPIUM_HOME = path.join(E2E_DIR, '.appium');
export const MOBILE_DIR = path.resolve(E2E_DIR, '../mobile');

export function requireAppiumDrivers(): void {
  if (!existsSync(path.join(APPIUM_HOME, 'node_modules'))) {
    throw new Error(
      `No Appium drivers installed at ${APPIUM_HOME}. Run: pnpm --filter @loxaic/e2e setup:appium`,
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

/**
 * Puts an image into the emulator's photo library so the system picker has
 * something to select.
 *
 * `adb push` alone is not enough: the picker reads MediaStore, not the
 * filesystem, and a pushed file is invisible until the media scanner indexes
 * it. The broadcast is what makes it appear. Re-pushing the same path on a
 * later run just overwrites and re-indexes, so this is safe to repeat.
 */
export function seedAndroidPhoto(file: string): void {
  if (!existsSync(file)) throw new Error(`No such image fixture: ${file}`);
  const remote = `/sdcard/Pictures/${path.basename(file)}`;
  const adb = adbPath();
  execFileSync(adb, ['push', file, remote], { stdio: 'ignore', timeout: SEED_TIMEOUT_MS });
  execFileSync(
    adb,
    ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`],
    { stdio: 'ignore', timeout: SEED_TIMEOUT_MS },
  );
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
        `  pnpm --filter @loxaic/mobile prebuild:android\n` +
        `  cd apps/mobile/android && EXPO_PUBLIC_API_URL=<base-url> ./gradlew assembleRelease`,
    );
  }
  return apk;
}

/**
 * Resolves a simulator by name, booting it if it isn't already (Appium would
 * anyway) and returning its udid. Both `simctl` calls below need a booted
 * device, so the find-and-boot lives here rather than in either of them.
 */
function bootedIosDevice(deviceName: string, osVersion?: string): string {
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
  return device.udid;
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
  const udid = bootedIosDevice(deviceName, osVersion);
  execFileSync('xcrun', ['simctl', 'keychain', udid, 'reset'], { stdio: 'ignore' });
}

/**
 * Puts an image into the simulator's photo library, so PHPicker has something
 * to select. `simctl addmedia` is the supported way in — it imports through
 * Photos itself rather than writing files the picker would never see, which
 * is the iOS counterpart of Android's media-scanner problem.
 *
 * Adding the same file again creates a duplicate rather than replacing it.
 * Harmless: the spec only ever picks the first cell, and these simulators are
 * disposable, but it does mean the library grows one entry per run.
 *
 * Known failure mode: on some machines `addmedia` hangs forever instead of
 * returning, which appears to be a wedged simulator Photos daemon rather than
 * anything about the file. `simctl shutdown <udid>` (or erasing that
 * simulator) clears it; the timeout below turns the hang into a message that
 * says so.
 */
export function seedIosPhoto(deviceName: string, file: string, osVersion?: string): void {
  if (!existsSync(file)) throw new Error(`No such image fixture: ${file}`);
  const udid = bootedIosDevice(deviceName, osVersion);
  try {
    execFileSync('xcrun', ['simctl', 'addmedia', udid, file], {
      stdio: 'ignore',
      timeout: SEED_TIMEOUT_MS,
    });
  } catch (err) {
    if ((err as { signal?: string }).signal === 'SIGTERM') {
      throw new Error(
        `xcrun simctl addmedia hung on simulator ${udid} (>${String(SEED_TIMEOUT_MS / 1000)}s). ` +
          `Its Photos daemon is likely wedged — try: xcrun simctl shutdown ${udid}, ` +
          `or erase that simulator, then re-run.`,
      );
    }
    throw err;
  }
}

export function iosAppPath(): string {
  const fromEnv = process.env.E2E_IOS_APP;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`E2E_IOS_APP does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const app = path.join(
    MOBILE_DIR,
    'ios/build/Build/Products/Release-iphonesimulator/loxaic.app',
  );
  if (!existsSync(app)) {
    throw new Error(
      `No iOS simulator build at ${app}.\n` +
        `Build one first (see apps/e2e/README.md), or point E2E_IOS_APP at a .app bundle.`,
    );
  }
  return app;
}
