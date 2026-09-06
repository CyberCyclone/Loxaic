/**
 * iOS suite — XCUITest against a simulator.
 *
 * Runs a **Release** simulator build: Release embeds the JS bundle, so the app
 * is self-contained and no Metro server has to stay alive beside the suite.
 *
 * Networking needs no forwarding here — the simulator shares the host's
 * loopback, so the app's own `localhost` fallback already reaches the test
 * server, and App Transport Security exempts localhost from its HTTPS
 * requirement. That is why iOS needs neither an `adb reverse` equivalent nor
 * the cleartext-traffic opt-in Android does.
 */
import { standup, teardown } from './scripts/standup.ts';
import {
  iosAppPath,
  requireAppiumDrivers,
  resetIosSimulatorKeychain,
  seedIosPhoto,
} from './scripts/native.ts';
import { IMAGE_FIXTURE } from './src/helpers/attachments.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'ios';
requireAppiumDrivers();

const IOS_DEVICE = process.env.E2E_IOS_DEVICE ?? 'iPhone 17';

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  port: 4723,
  services: [['appium', { args: { address: '127.0.0.1', port: 4723 } }]],
  capabilities: [
    {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': IOS_DEVICE,
      'appium:app': iosAppPath(),
      // Dismiss system alerts automatically; the suite never needs to accept
      // one. On iOS 17 this also covered the "Save Password?" prompt after
      // the first sign-in. On iOS 26 that prompt is a Passwords-app sheet,
      // not an alert, and is handled by dismissIosSavePasswordPrompt in
      // helpers/app.ts instead.
      'appium:autoDismissAlerts': true,
      // Reinstall the app every session even when its version code/bundle
      // version is unchanged. Appium otherwise keeps whatever is already on
      // the device, so a rebuilt app with the same version — every local
      // rebuild — silently never reaches the suite (found when a fixed
      // upload still "failed": the emulator was running the previous build).
      'appium:enforceAppInstall': true,
      // WDA's default typing rate (60 keys/s) drops characters on the iOS 26
      // simulator — a run signed up "ee+…@example.test" for "e2e+…", and the
      // spec's API sign-in with the intended email then 401'd. Half speed
      // costs well under a second per field; typeInto also verifies.
      'appium:maxTypingFrequency': 30,
      // First launch also builds/installs WebDriverAgent onto the simulator,
      // which is far slower than any later run.
      'appium:wdaLaunchTimeout': 240_000,
      'appium:newCommandTimeout': 300,
      ...(process.env.E2E_IOS_VERSION ? { 'appium:platformVersion': process.env.E2E_IOS_VERSION } : {}),
    },
  ],

  onPrepare: async function onPrepare() {
    await standup();
    // The attachments spec picks the first photo out of PHPicker, so the
    // library has to have one. Cheap and idempotent enough to always do.
    seedIosPhoto(IOS_DEVICE, IMAGE_FIXTURE, process.env.E2E_IOS_VERSION);
  },

  // Per **session**, not per run. onPrepare fires once for the whole suite, so
  // resetting there only cleans up before the first spec file: the moment that
  // spec signs up, every spec after it starts already signed in and dies
  // waiting for a login screen that will never come. Every spec here begins by
  // signing up, so the reset has to happen for each of them.
  //
  // The iOS keychain outlives app reinstalls, which is why uninstalling isn't
  // enough on its own — see resetIosSimulatorKeychain for the full story.
  beforeSession: function beforeSession() {
    resetIosSimulatorKeychain(IOS_DEVICE, process.env.E2E_IOS_VERSION);
  },

  onComplete: async function onComplete() {
    await teardown();
  },
};
