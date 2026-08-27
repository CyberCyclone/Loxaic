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
import { iosAppPath, requireAppiumDrivers } from './scripts/native.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'ios';
requireAppiumDrivers();

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  port: 4723,
  services: [['appium', { args: { address: '127.0.0.1', port: 4723 } }]],
  capabilities: [
    {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': process.env.E2E_IOS_DEVICE ?? 'iPhone 15',
      'appium:app': iosAppPath(),
      // First launch also builds/installs WebDriverAgent onto the simulator,
      // which is far slower than any later run.
      'appium:wdaLaunchTimeout': 240_000,
      'appium:newCommandTimeout': 300,
      ...(process.env.E2E_IOS_VERSION ? { 'appium:platformVersion': process.env.E2E_IOS_VERSION } : {}),
    },
  ],

  onPrepare: async function onPrepare() {
    await standup();
  },

  onComplete: async function onComplete() {
    await teardown();
  },
};
