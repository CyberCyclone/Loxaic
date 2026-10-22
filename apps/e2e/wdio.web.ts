/**
 * Web suite — runs against the static Expo export that apps/server serves
 * same-origin, NOT the Metro dev server on :8081.
 *
 * That distinction matters for more than fidelity to production: served from
 * :4000 the app resolves its API endpoint to its own origin, and :4000 is one
 * of better-auth's trusted origins, so auth behaves exactly as it does for a
 * real user. Pointed at Metro it would take a different endpoint-resolution
 * branch entirely (see apps/mobile/lib/endpoint.ts).
 */
import { BASE_URL } from './scripts/standup.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'web';

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  // The shared glob covers the cross-platform specs; specs/browser holds the
  // ones needing a driveable `<input type="file">`, which only this target and
  // Electron have (see specs/browser/document-attachments.spec.ts).
  specs: ['./src/specs/*.spec.ts', './src/specs/browser/*.spec.ts'],
  baseUrl: BASE_URL,
  capabilities: [
    {
      browserName: 'chrome',
      // A Chrome and chromedriver already installed (the dev image's, #320),
      // instead of the copies WebdriverIO downloads.
      ...(process.env.CHROMEDRIVER_BIN ? { 'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_BIN } } : {}),
      'goog:chromeOptions': {
        ...(process.env.CHROME_BIN ? { binary: process.env.CHROME_BIN } : {}),
        args: [
          ...(process.env.E2E_HEADED === '1' ? [] : ['--headless=new']),
          // Inside a Loxaic sandbox: Chrome's own sandbox needs user
          // namespaces it does not grant, and /dev/shm is 64 MB.
          ...(process.env.E2E_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
          // Wide enough that the shell renders its desktop layout with the
          // sidebar pinned open; the suite copes with either, but a fixed size
          // keeps screenshots comparable between runs.
          '--window-size=1440,900',
        ],
      },
    },
  ],
  before: async function before() {
    await browser.url('/');
  },
};
