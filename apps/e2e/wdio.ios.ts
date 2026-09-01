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

const IOS_DEVICE = process.env.E2E_IOS_DEVICE ?? 'iPhone 15';

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
      // iOS interrupts the first sign-in with a system "Save Password?"
      // sheet, which sits above the app and blocks every element query.
      // Dismiss system alerts automatically ("Not Now"); the suite never
      // needs to accept one.
      'appium:autoDismissAlerts': true,
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
