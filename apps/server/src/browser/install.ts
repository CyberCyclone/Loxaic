/**
 * Where web_fetch's browser fallback gets its Chromium (#281).
 *
 * Either an existing Chrome or Chromium the deployment names with
 * `BROWSER_EXECUTABLE` (an Alpine container's `chromium` package, a system
 * Chrome), or Playwright's `chromium-headless-shell` build, downloaded on an
 * admin's request into `BROWSER_DIR` by playwright-core's own installer. No
 * Docker either way: most installs have none.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * Where the managed build lives when `BROWSER_DIR` is unset: the user's cache
 * folder, never the server's working directory. On macOS a checkout often sits
 * under ~/Documents, and Chromium's sandboxed helper processes cannot read
 * from there (nor Desktop or Downloads): the GPU process fails to load its
 * data and the browser quits a moment after starting. The desktop supervisor
 * sets `BROWSER_DIR` beside its other data, which is fine. Pure, for tests.
 */
export function defaultBrowserDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "Loxaic", "browsers");
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Loxaic", "browsers");
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "loxaic", "browsers");
}

/** Where the managed build lives: `BROWSER_DIR`, else `defaultBrowserDir()`.
 * Read at call time. */
export function browserDir(): string {
  return path.resolve(process.env.BROWSER_DIR ?? defaultBrowserDir());
}

/**
 * Why a folder cannot hold the managed build on this machine, or null. macOS
 * keeps sandboxed processes out of Documents, Desktop and Downloads, so a
 * browser installed there starts and then dies on its first page with nothing
 * but "Target page, context or browser has been closed". Pure, for tests.
 */
export function unusableBrowserDir(dir: string, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string | null {
  if (platform !== "darwin") return null;
  for (const folder of ["Documents", "Desktop", "Downloads"]) {
    const protectedRoot = path.join(home, folder);
    if (dir === protectedRoot || dir.startsWith(protectedRoot + path.sep)) {
      return `The browser folder (${dir}) is inside ~/${folder}, where macOS does not let Chromium's sandboxed processes read. Set BROWSER_DIR elsewhere, or unset it to use ${defaultBrowserDir(platform, process.env, home)}.`;
    }
  }
  return null;
}

/** An executable the deployment supplied, which is used as is and never
 * installed over. */
export function configuredExecutable(): string | null {
  const value = process.env.BROWSER_EXECUTABLE?.trim();
  if (value === undefined || value === "") return null;
  return value;
}

export type InstallState =
  | { state: "missing" }
  | { state: "installing"; percent: number | null }
  | { state: "installed"; source: "managed" | "configured" | "system"; executable: string; name?: string }
  | { state: "failed"; error: string };

const PLATFORM_DIR: Partial<Record<string, string>> = {
  "darwin-arm64": "chrome-headless-shell-mac-arm64",
  "darwin-x64": "chrome-headless-shell-mac-x64",
  "linux-x64": "chrome-headless-shell-linux64",
  "linux-arm64": "chrome-headless-shell-linux-arm64",
  "win32-x64": "chrome-headless-shell-win64",
};

/** The managed build's binary, when one is fully installed. Playwright writes
 * `INSTALLATION_COMPLETE` last, so a half-finished download never counts. */
export function managedExecutable(dir = browserDir()): string | null {
  if (!existsSync(dir)) return null;
  const platformDir = PLATFORM_DIR[`${process.platform}-${process.arch}`];
  if (!platformDir) return null;
  const builds = readdirSync(dir)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    if (!existsSync(path.join(dir, build, "INSTALLATION_COMPLETE"))) continue;
    const binary = path.join(dir, build, platformDir, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
    if (existsSync(binary)) return binary;
  }
  return null;
}

/**
 * Browsers a Linux system already lets run Chromium's sandbox (#281).
 *
 * Ubuntu 23.10+ restricts unprivileged user namespaces, which the sandbox
 * needs, and exempts named browsers by path in its own AppArmor profiles
 * (/etc/apparmor.d/chrome, chromium, msedge, brave), and snapd does the same
 * for the Chromium snap. A browser installed at one of those paths therefore
 * runs fully sandboxed with nothing on the system changed, where Loxaic's own
 * download cannot. Elsewhere the managed build's
 * sandbox works and this list is never needed, so it is Linux only.
 */
export interface SystemBrowser {
  name: string;
  executable: string;
}

export const LINUX_SYSTEM_BROWSERS: readonly SystemBrowser[] = [
  { name: "Google Chrome", executable: "/opt/google/chrome/chrome" },
  // Distribution Chromium (Debian and its kin).
  { name: "Chromium", executable: "/usr/lib/chromium/chromium" },
  { name: "Chromium", executable: "/usr/lib/chromium-browser/chromium-browser" },
  // Ubuntu's `chromium` / `chromium-browser` package installs this snap.
  // Launched through snap's own launcher it runs confined, and snapd grants
  // it the namespaces its sandbox needs: chrome://sandbox reports "adequately
  // sandboxed" on Ubuntu 26.04 with the restriction on.
  { name: "Chromium (snap)", executable: "/snap/bin/chromium" },
  { name: "Microsoft Edge", executable: "/opt/microsoft/msedge/msedge" },
  { name: "Brave", executable: "/opt/brave.com/brave/brave" },
];

/**
 * Root's, and writable by nobody else, all the way up. The system's exemption
 * is by path, so anything someone else could rename or replace on the way to
 * the binary (the file, a folder above it, a symlink in the path, or what the
 * symlink points at) would hand them the very thing the system restricted.
 * Checks both the path as given and where it resolves, every folder up to `/`.
 */
export function rootOwned(file: string): boolean {
  try {
    const resolved = realpathSync(file);
    if (!statSync(resolved).isFile()) return false;
    const safe = (st: { uid: number; mode: number }): boolean => st.uid === 0 && (st.mode & 0o022) === 0;
    for (const start of [file, resolved]) {
      let current = start;
      for (;;) {
        // lstat: a symlink on the way is itself something that could be swapped.
        const own = lstatSync(current);
        if (!safe(own) && !own.isSymbolicLink()) return false;
        if (own.isSymbolicLink() && own.uid !== 0) return false;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    return safe(statSync(resolved));
  } catch {
    return false;
  }
}

let systemCandidates: () => readonly SystemBrowser[] = () => (process.platform === "linux" ? LINUX_SYSTEM_BROWSERS : []);
let trusted: (file: string) => boolean = rootOwned;

/** The installed system browsers Loxaic may fall back to, in preference order. */
export function systemBrowsers(): SystemBrowser[] {
  return systemCandidates().filter((b) => trusted(b.executable));
}

/** The same check, for the moment just before a launch. */
export function isTrustedSystemBrowser(executable: string): boolean {
  return trusted(executable);
}

export function __setSystemBrowsersForTest(candidates: readonly SystemBrowser[], isTrusted: (file: string) => boolean = () => true): void {
  systemCandidates = () => candidates;
  trusted = isTrusted;
}

let installing: { promise: Promise<void>; percent: number | null } | null = null;
let lastError: string | null = null;

export function installState(): InstallState {
  const configured = configuredExecutable();
  if (configured) return { state: "installed", source: "configured", executable: configured };
  if (installing) return { state: "installing", percent: installing.percent };
  const unusable = unusableBrowserDir(browserDir());
  const managed = unusable ? null : managedExecutable();
  if (managed) return { state: "installed", source: "managed", executable: managed };
  const system = systemBrowsers().at(0);
  if (system) return { state: "installed", source: "system", executable: system.executable, name: system.name };
  if (unusable) return { state: "failed", error: unusable };
  if (lastError) return { state: "failed", error: lastError };
  return { state: "missing" };
}

/** The executable a launch should use, or null when there is none yet. */
export function browserExecutable(): string | null {
  const s = installState();
  return s.state === "installed" ? s.executable : null;
}

function playwrightCli(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
}

/**
 * Downloads `chromium-headless-shell` into `BROWSER_DIR`. Single-flight: a
 * second call while one runs gets the same promise. Resolves when it finishes;
 * `installState()` reports progress meanwhile, parsed from the installer's own
 * percentage lines.
 */
export function installBrowser(): Promise<void> {
  if (configuredExecutable()) return Promise.resolve();
  if (installing) return installing.promise;
  const unusable = unusableBrowserDir(browserDir());
  if (unusable) {
    lastError = unusable;
    return Promise.reject(new Error(unusable));
  }
  lastError = null;
  const entry: { promise: Promise<void>; percent: number | null } = { promise: Promise.resolve(), percent: null };
  entry.promise = new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli(), "install", "chromium-headless-shell"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDir(), PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const onOutput = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-2000);
      const matches = [...text.matchAll(/(\d{1,3})% of/g)];
      const last = matches.at(-1);
      if (last) entry.percent = Math.min(100, Number(last[1]));
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", (err) => { reject(err); });
    child.on("close", (code) => {
      if (code === 0 && managedExecutable()) resolve();
      else reject(new Error(`the Chromium download failed (exit ${String(code)}): ${tail.trim().split("\n").at(-1) ?? ""}`));
    });
  }).then(
    () => {
      if (installing === entry) installing = null;
    },
    (err: unknown) => {
      if (installing === entry) installing = null;
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    },
  );
  installing = entry;
  return entry.promise;
}

export function __resetInstallStateForTest(): void {
  installing = null;
  lastError = null;
  systemCandidates = () => (process.platform === "linux" ? LINUX_SYSTEM_BROWSERS : []);
  trusted = rootOwned;
}
