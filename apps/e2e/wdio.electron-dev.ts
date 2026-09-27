/**
 * The desktop app as `pnpm dev` starts it: unpackaged (`electron apps/desktop`),
 * loading its screens from Metro, and started at the same moment as the dev
 * server and Metro themselves.
 *
 * Every other Electron spec drives the packaged build, which never reaches
 * this path, and that is how a dev launch could leave a blank window for as
 * long as it did with nothing failing: the window loaded Metro once, with no
 * retry, and picked its server with one probe that the dev server, still
 * booting, always lost. This lane runs the real app's main process against
 * stand-ins for both (scripts/dev-stand-ins.ts) on ports of the run's own.
 *
 * No build needed — it runs the checkout's own source.
 *   pnpm --filter @loxaic/e2e test:electron-dev
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataDir } from './scripts/electron-env.ts';
import { BASE_URL, teardown, standup } from './scripts/standup.ts';
import { freePort, startDevServerStandIn, type DevServerStandIn } from './scripts/dev-stand-ins.ts';
import { sharedConfig } from './wdio.shared.ts';

process.env.E2E_PLATFORM = 'electron';

// Nothing may point this launch anywhere before the dev branch of main.js's
// resolveApi gets its turn: each of these outranks it.
delete process.env.EXPO_PUBLIC_API_URL;
delete process.env.EXPO_PUBLIC_LAN_API_URL;
delete process.env.LOXAIC_REMOTE_URL;
delete process.env.TSNET_TARGET;
process.env.LOXAIC_DISABLE_UPDATES = '1';
// What the root `pnpm dev` sets: the dev server is starting beside the app.
process.env.LOXAIC_DEV_STACK = '1';

/** How late the dev server stand-in answers, from the app's first probe. */
export const DEV_SERVER_LATE_MS = 10_000;

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(E2E_DIR, '../..');

/**
 * Where the app is launched from: the checkout itself, or — on macOS, when the
 * checkout sits in a folder the privacy system guards — a copy-on-write clone
 * of it in a temp dir.
 *
 * The packaged lane never meets this, because a packaged app reads only its
 * own bundle. A development launch reads the checkout's `apps/desktop` and its
 * node_modules, and chromedriver starts Electron as a process responsible for
 * itself, which is refused ~/Documents: Electron's default app cannot load the
 * app, and the session fails with "DevToolsActivePort file doesn't exist" and
 * nothing else. The same process launched from a terminal works, which is
 * what makes it look like anything but a permissions problem. (The tailnet
 * fixture is copied out of the checkout for the same reason — see
 * scripts/electron-env.ts.) An APFS clone costs no space and takes seconds.
 *
 * Minted with `??=` so the launcher, which makes the clone, and the worker,
 * which reads this config again, agree on the path.
 */
function isGuarded(dir: string): boolean {
  if (process.platform !== 'darwin') return false;
  const home = os.homedir();
  return ['Documents', 'Desktop', 'Downloads'].some((f) => dir.startsWith(path.join(home, f) + path.sep));
}
const STAGED = isGuarded(REPO_ROOT);
process.env.E2E_DEV_APP_ROOT ??= STAGED ? path.join(mkdtempSync(path.join(os.tmpdir(), 'loxaic-e2e-devapp-')), 'repo') : REPO_ROOT;
const APP_ROOT = process.env.E2E_DEV_APP_ROOT;
const DESKTOP_DIR = path.join(APP_ROOT, 'apps/desktop');

/** The Electron the desktop app depends on, read from the checkout; the binary
 * is addressed inside APP_ROOT, which may not exist until onPrepare clones it. */
function electronPackage(): { version: string; binary: string } {
  const dir = path.join(REPO_ROOT, 'apps/desktop/node_modules/electron');
  const pkgPath = path.join(dir, 'package.json');
  const pathTxt = path.join(dir, 'path.txt');
  if (!existsSync(pkgPath) || !existsSync(pathTxt)) {
    throw new Error(`No Electron binary under ${dir}. Run pnpm install (and electron's own install) first.`);
  }
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  const binary = path.join(DESKTOP_DIR, 'node_modules/electron/dist', readFileSync(pathTxt, 'utf8').trim());
  return { version, binary };
}

const electron = electronPackage();
let devServer: DevServerStandIn | null = null;

export const config: WebdriverIO.Config = {
  ...sharedConfig,
  specs: ['./src/specs/electron-dev/*.spec.ts'],
  services: ['electron'],
  // The ports are chosen here, in the launcher, before any worker exists, so
  // the worker, the spec and the app it spawns all inherit the same ones.
  onPrepare: async function onPrepare() {
    if (STAGED) {
      // -c clones on APFS: every file shares its blocks with the original.
      console.log(`[e2e] staging the checkout at ${APP_ROOT} (outside the folder macOS guards)`);
      execFileSync('cp', ['-c', '-R', REPO_ROOT, APP_ROOT]);
    }
    await standup();
    const serverPort = await freePort();
    const metroPort = await freePort();
    devServer = await startDevServerStandIn(BASE_URL, serverPort, DEV_SERVER_LATE_MS);
    process.env.LOXAIC_DEV_SERVER_URL = devServer.url;
    process.env.LOXAIC_DEV_RENDERER_URL = `http://127.0.0.1:${String(metroPort)}`;
    process.env.E2E_DEV_METRO_PORT = String(metroPort);
  },
  onComplete: async function onComplete() {
    await devServer?.stop();
    await teardown();
    if (STAGED) rmSync(path.dirname(APP_ROOT), { recursive: true, force: true });
  },
  capabilities: [
    {
      browserName: 'electron',
      browserVersion: electron.version,
      'wdio:electronServiceOptions': {
        appBinaryPath: electron.binary,
        appArgs: [
          // A switch, not a bare path. chromedriver adds --test-type=webdriver,
          // Chromium moves bare arguments after every switch, and Electron's
          // default app ignores a path that follows that flag — it opens its
          // own "Usage" page instead and the session never starts. `--app=`
          // is read before it.
          `--app=${DESKTOP_DIR}`,
          `--loxaic-data-dir=${appDataDir}`,
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ],
      },
    },
  ],
};
