/**
 * Electron suite — runs against the packaged desktop app, not the dev shell.
 *
 * That choice is the point of this suite. Electron is the one target that
 * cannot assume same-origin: the window loads from the `app://` scheme with no
 * server behind it, so the renderer learns where the API lives only through the
 * main process's `window.shannon.apiBaseUrl` bridge. `pnpm dev` skips that path
 * entirely (it loads Metro over http://localhost:8081), so only a packaged
 * build exercises what real users run.
 *
 * Build it first:
 *   pnpm --filter @shannon/desktop package:dir
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Must come before the standup import: it allocates the free port a
// self-contained run serves on, which standup reads at module load.
import { SELF_CONTAINED, selfContainedDataDir } from './scripts/electron-env.ts';
import { BASE_URL } from './scripts/standup.ts';
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
  delete process.env.SHANNON_REMOTE_URL;
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

/** Where `electron-builder --dir` leaves the binary, per platform. */
function appBinaryPath(): string {
  const candidates =
    process.platform === 'darwin'
      ? [
          // arch-suffixed on Apple Silicon, bare "mac" on Intel
          'mac-arm64/Open-Shannon.app/Contents/MacOS/Open-Shannon',
          'mac/Open-Shannon.app/Contents/MacOS/Open-Shannon',
        ]
      : process.platform === 'win32'
        ? ['win-unpacked/Open-Shannon.exe']
        : ['linux-unpacked/open-shannon'];

  for (const rel of candidates) {
    const full = path.join(DESKTOP_DIST, rel);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `No unpacked Electron build found under ${DESKTOP_DIST}. ` +
      `Build one first: pnpm --filter @shannon/desktop package:dir`,
  );
}

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  // The shared glob covers the cross-platform specs; this adds the ones that
  // only make sense for a desktop build.
  specs: ['./src/specs/*.spec.ts', './src/specs/browser/*.spec.ts', './src/specs/electron/*.spec.ts'],
  services: ['electron'],
  capabilities: [
    {
      browserName: 'electron',
      browserVersion: electronVersion(),
      'wdio:electronServiceOptions': {
        appBinaryPath: appBinaryPath(),
        // Self-contained: the app runs its own stack on this run's free port,
        // with a throwaway data dir so runs never share state.
        ...(SELF_CONTAINED && selfContainedDataDir
          ? {
              appArgs: [
                `--shannon-port=${process.env.E2E_PORT ?? ''}`,
                `--shannon-data-dir=${selfContainedDataDir}`,
              ],
            }
          : {}),
      },
    },
  ],
};
