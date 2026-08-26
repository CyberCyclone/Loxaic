/**
 * Config every platform builds on. Per-platform files supply only what is
 * genuinely platform-specific — capabilities, the services that drive that
 * target, and the E2E_PLATFORM the selector helper keys off.
 */
import type { Options } from '@wdio/types';
import { shot } from './src/helpers/screenshot.ts';
import { standup, teardown } from './scripts/standup.ts';

export const sharedConfig: Partial<WebdriverIO.Config> = {
  runner: 'local',
  specs: ['./src/specs/**/*.spec.ts'],

  // One session at a time: the suites share a single backing server and a
  // simulator/emulator can only host one app instance anyway.
  maxInstances: 1,

  logLevel: (process.env.E2E_LOG_LEVEL as Options.WebDriverLogTypes | undefined) ?? 'warn',
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // Native cold starts and the first web export load are slow; a tight
    // timeout here fails runs that were only ever going to be slow, not wrong.
    timeout: 180_000,
  },

  onPrepare: async function onPrepare() {
    await standup();
  },

  // A failed step is exactly when a picture is worth most, so capture one
  // without the spec having to ask.
  afterTest: async function afterTest(test, _context, { passed }) {
    if (!passed) await shot(`FAILED-${test.title}`);
  },

  onComplete: async function onComplete() {
    await teardown();
  },
};
