/**
 * Electron suite — runs against the packaged desktop app, not the dev shell.
 *
 * That choice is the point of this suite. Electron is the one target that
 * cannot assume same-origin: the window loads from the `app://` scheme with no
 * server behind it, so the renderer learns where the API lives only through the
 * main process's `window.loxaic.apiBaseUrl` bridge. `pnpm dev` skips that path
 * entirely (it loads Metro over http://localhost:8081), so only a packaged
 * build exercises what real users run.
 *
 * Build it first:
 *   pnpm --filter @loxaic/desktop package:dir
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Must come before the standup import: it allocates the free port a
// self-contained run serves on, which standup reads at module load.
import { SELF_CONTAINED, appDataDir, stopSelfContainedLeftovers } from './scripts/electron-env.ts';
import { BASE_URL, teardown } from './scripts/standup.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'electron';

// The service spawns the app, which inherits this process's environment, so the
// app's config has to be in place before the session starts.
if (SELF_CONTAINED) {
  // The app must run its embedded stack, so nothing may push it into a
  // client-only mode — and the supervisor passes MOCK_INFERENCE through to
  // the server child it spawns.
  delete process.env.EXPO_PUBLIC_API_URL;
  delete process.env.EXPO_PUBLIC_LAN_API_URL;
  delete process.env.LOXAIC_REMOTE_URL;
  process.env.MOCK_INFERENCE = 'true';
} else {
  // main.js resolves its API base URL before creating the window, probing each
  // candidate with a 1.5s timeout. Handing it one that answers immediately
  // keeps startup snappy and, more importantly, pins the app to *this* run's
  // server rather than whatever holds the default port.
  process.env.EXPO_PUBLIC_API_URL = BASE_URL;
}
// Never let a developer's real tailnet config hijack a test run: with this set,
// main.js spawns the sidecar and points the app at a tailnet host instead.
delete process.env.TSNET_TARGET;

// A `--dir` build is a packaged build as far as `app.isPackaged` is concerned,
// so without this every Electron run would ask GitHub for a release feed —
// and, on a machine where a release exists, start downloading an installer
// mid-suite. Switched off explicitly rather than left to chance, and the
// updates spec asserts the app says so instead of pretending to be current.
process.env.LOXAIC_DISABLE_UPDATES = '1';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(E2E_DIR, '../desktop');
const DESKTOP_DIST = path.join(DESKTOP_DIR, 'dist');

/**
 * The Electron version the desktop app is actually built with, read straight
 * from its installed copy.
 *
 * The service needs this to pick a matching Chromedriver, and normally finds it
 * by resolving `electron` from its own package. pnpm's strict linking means
 * this workspace can't see apps/desktop's dependency, and adding a second
 * `electron` here just to satisfy the lookup would be a version that can drift
 * out of sync with the app under test. Reading the real one keeps them pinned
 * together with no duplicate dependency.
 */
function electronVersion(): string {
  const pkgPath = path.join(DESKTOP_DIR, 'node_modules/electron/package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`Cannot read Electron version at ${pkgPath}. Run pnpm install first.`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * Where `electron-builder --dir` leaves the binary, per platform.
 *
 * Follows LOXAIC_VARIANT, because the beta variant is packaged under its own
 * product name ("Loxaic Beta") — so the same suite can drive either build,
 * which is the only way to check that the beta app really is a separate
 * application rather than a differently-labelled one.
 */
function appBinaryPath(): string {
  const beta = process.env.LOXAIC_VARIANT === 'beta';
  const mac = beta ? 'Loxaic Beta.app/Contents/MacOS/Loxaic Beta' : 'Loxaic.app/Contents/MacOS/Loxaic';
  const candidates =
    process.platform === 'darwin'
      ? [
          // arch-suffixed on Apple Silicon, bare "mac" on Intel
          `mac-arm64/${mac}`,
          `mac/${mac}`,
        ]
      : process.platform === 'win32'
        ? [beta ? 'win-unpacked/Loxaic Beta.exe' : 'win-unpacked/Loxaic.exe']
        : beta
          ? // `executableName` in the beta variant pins the first; the second
            // is what electron-builder would infer from "Loxaic Beta" if that
            // pin were ever dropped, and costs nothing to also accept.
            ['linux-unpacked/loxaic-beta', 'linux-unpacked/loxaic beta']
          : ['linux-unpacked/loxaic'];

  for (const rel of candidates) {
    const full = path.join(DESKTOP_DIST, rel);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `No unpacked Electron build found under ${DESKTOP_DIST}. ` +
      `Build one first: pnpm --filter @loxaic/desktop package:dir`,
  );
}

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  // The shared glob covers the cross-platform specs; this adds the ones that
  // only make sense for a desktop build.
  specs: ['./src/specs/*.spec.ts', './src/specs/browser/*.spec.ts', './src/specs/electron/*.spec.ts'],
  services: ['electron'],
  // The shared teardown, plus the one thing only this suite leaks: the
  // embedded stack a self-contained run's app was killed out from under.
  onComplete: async function onComplete() {
    await teardown();
    stopSelfContainedLeftovers();
  },
  capabilities: [
    {
      browserName: 'electron',
      browserVersion: electronVersion(),
      'wdio:electronServiceOptions': {
        appBinaryPath: appBinaryPath(),
        // A throwaway data dir in every mode, so runs never share state with
        // each other or with the developer's own install (the executor
        // records picked folders there). Self-contained runs additionally
        // pin the embedded stack to this run's free port.
        appArgs: [
          `--loxaic-data-dir=${appDataDir}`,
          ...(SELF_CONTAINED ? [`--loxaic-port=${process.env.E2E_PORT ?? ''}`] : []),
        ],
      },
    },
  ],
};
