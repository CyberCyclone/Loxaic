/**
 * The real-model task suite — an actual inference endpoint drives the agent
 * through a genuine multi-step coding task (read instructions, npm install,
 * fix broken code, build) instead of the mock's canned tool calls.
 *
 * Deliberately its own config, not a flag on wdio.web.ts: E2E_REAL_MODEL must
 * be set before scripts/standup.ts is imported (module-load order — same
 * requirement wdio.electron.ts documents for SELF_CONTAINED), and the specs
 * live in their own subdirectory (src/specs/real-model/) so the default
 * `./src/specs/*.spec.ts` glob other configs use never picks them up. See the
 * README's "Real-model task suite" section — this is never run in CI.
 */
process.env.E2E_REAL_MODEL = '1';

import { BASE_URL } from './scripts/standup.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'web';

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  specs: ['./src/specs/real-model/*.spec.ts'],
  baseUrl: BASE_URL,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: [
          ...(process.env.E2E_HEADED === '1' ? [] : ['--headless=new']),
          '--window-size=1440,900',
        ],
      },
    },
  ],
  // A real model completing a multi-step coding task is minutes, not
  // seconds — sharedConfig's 180s timeout is sized for the mock suite.
  mochaOpts: {
    ...sharedConfig.mochaOpts,
    timeout: 30 * 60_000,
  },
  before: async function before() {
    await browser.url('/');
  },
};
