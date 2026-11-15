/**
 * Installs the Appium drivers the native lanes use, at the versions pinned
 * here, into the repo-local `.appium/`.
 *
 * Safe to run every time, and it has to be: `appium driver install` refuses a
 * driver that is already there, and an install that failed (the newest
 * uiautomator2 needing a newer Appium than this repo has) still leaves
 * `.appium/` behind. So this reads what is installed and only then decides —
 * nothing when the pin is already there, which needs no network; a reinstall
 * when another version is.
 *
 *   tsx scripts/setup-appium.ts            # both drivers
 *   tsx scripts/setup-appium.ts android    # one (what the sandbox lane runs)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DriverPin {
  /** Appium's own name for the driver. */
  name: string;
  /** Its npm package. */
  pkg: string;
  /** An exact version whose `appium` peer range covers this repo's Appium. */
  version: string;
}

/** The only place a driver version is written. Both are the last release line
 * that runs on Appium 3: uiautomator2 9 and xcuitest 13 need Appium 4. */
export const DRIVER_PINS: Record<'android' | 'ios', DriverPin> = {
  android: { name: 'uiautomator2', pkg: 'appium-uiautomator2-driver', version: '8.7.0' },
  ios: { name: 'xcuitest', pkg: 'appium-xcuitest-driver', version: '12.20.0' },
};

export type Platform = keyof typeof DRIVER_PINS;

/** What `appium driver list --installed --json` says about one driver. */
export interface InstalledDriver {
  pkgName?: string;
  version?: string;
}

/** What to do about one pinned driver, given what is installed. */
export function planDriver(pin: DriverPin, installed: InstalledDriver | undefined): 'keep' | 'install' | 'reinstall' {
  if (!installed) return 'install';
  return installed.pkgName === pin.pkg && installed.version === pin.version ? 'keep' : 'reinstall';
}

/** The platforms asked for: all of them when none is named. Throws on a name
 * that is not one, so a typo does not quietly install nothing. */
export function platformsFor(args: readonly string[]): Platform[] {
  const known = Object.keys(DRIVER_PINS) as Platform[];
  if (args.length === 0) return known;
  const unknown = args.filter((a) => !(known as string[]).includes(a));
  if (unknown.length > 0) throw new Error(`unknown platform ${unknown.join(', ')}: expected ${known.join(' or ')}`);
  return known.filter((p) => args.includes(p));
}

/** The installed drivers out of Appium's JSON; empty for anything else, which
 * is what a `.appium/` a failed install left behind prints. */
export function parseInstalled(stdout: string): Partial<Record<string, InstalledDriver>> {
  const start = stdout.indexOf('{');
  if (start < 0) return {};
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function appium(args: string[], capture = false): { status: number; stdout: string } {
  const result = spawnSync(path.join(E2E_DIR, 'node_modules/.bin/appium'), args, {
    cwd: E2E_DIR,
    env: { ...process.env, APPIUM_HOME: path.join(E2E_DIR, '.appium') },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: capture ? result.stdout : '' };
}

function main(args: readonly string[]): number {
  const platforms = platformsFor(args);
  const installed = parseInstalled(appium(['driver', 'list', '--installed', '--json'], true).stdout);
  for (const platform of platforms) {
    const pin = DRIVER_PINS[platform];
    const plan = planDriver(pin, installed[pin.name]);
    if (plan === 'keep') {
      console.log(`[setup:appium] ${pin.name} ${pin.version} is installed`);
      continue;
    }
    if (plan === 'reinstall') {
      console.log(`[setup:appium] ${pin.name} ${installed[pin.name]?.version ?? '?'} is installed; replacing it with ${pin.version}`);
      const removed = appium(['driver', 'uninstall', pin.name]);
      if (removed.status !== 0) return removed.status;
    }
    console.log(`[setup:appium] installing ${pin.name} ${pin.version}`);
    const added = appium(['driver', 'install', '--source=npm', `${pin.pkg}@${pin.version}`]);
    if (added.status !== 0) return added.status;
  }
  return 0;
}

// Run only as a script: the test imports the functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`[setup:appium] ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
