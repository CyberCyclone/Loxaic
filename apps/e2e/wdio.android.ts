/**
 * Android suite — UiAutomator2 against an emulator or a connected device.
 *
 * Runs a **release** build: release embeds the JS bundle, so the app under test
 * is self-contained and no Metro server has to stay alive beside the suite.
 *
 * Networking: `adb reverse` maps the server's port on the device back to this
 * machine, so the app reaches it at plain `localhost`. The emulator could use
 * its 10.0.2.2 host alias instead, but that is emulator-only — reversing the
 * port works identically on a physical device, so the suite has one story
 * rather than two. The APK must be built with EXPO_PUBLIC_API_URL pointing at
 * that same localhost URL (EXPO_PUBLIC_* values are inlined at bundle time, not
 * read at runtime); see apps/e2e/README.md.
 */
import { PORT, standup, teardown } from './scripts/standup.ts';
import {
  adbReverse,
  adbReverseRemove,
  androidApkPath,
  ensureAndroidEnv,
  requireAppiumDrivers,
} from './scripts/native.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'android';
requireAppiumDrivers();
// Exported before the Appium service spawns, which inherits this environment;
// the UiAutomator2 driver refuses to start a session without it.
ensureAndroidEnv();

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  port: 4723,
  services: [['appium', { args: { address: '127.0.0.1', port: 4723 } }]],
  capabilities: [
    {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': androidApkPath(),
      'appium:appPackage': 'com.shannon.app',
      // Cold start on an emulator is slow, and slow is not the same as broken.
      'appium:appWaitDuration': 60_000,
      'appium:newCommandTimeout': 300,
      ...(process.env.E2E_ANDROID_AVD ? { 'appium:avd': process.env.E2E_ANDROID_AVD } : {}),
    },
  ],

  onPrepare: async function onPrepare() {
    await standup();
    // After stand-up, so the port being forwarded is one that already answers.
    adbReverse(PORT);
  },

  onComplete: async function onComplete() {
    adbReverseRemove(PORT);
    await teardown();
  },
};
