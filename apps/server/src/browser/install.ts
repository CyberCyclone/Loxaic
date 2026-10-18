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
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Where the managed build lives. `<cwd>/browsers` when unset, the same
 * arrangement as `LLAMA_DIR` (llama/paths.ts): gitignored in a checkout, set
 * beside the rest of the data by the desktop supervisor. Read at call time. */
export function browserDir(): string {
  return path.resolve(process.env.BROWSER_DIR ?? path.join(process.cwd(), "browsers"));
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
 * (/etc/apparmor.d/chrome, chromium, msedge, brave). A browser installed at
 * one of those paths therefore runs fully sandboxed with nothing on the system
 * changed, where Loxaic's own download cannot. Elsewhere the managed build's
 * sandbox works and this list is never needed, so it is Linux only.
 */
export interface SystemBrowser {
  name: string;
  executable: string;
}

export const LINUX_SYSTEM_BROWSERS: readonly SystemBrowser[] = [
  { name: "Google Chrome", executable: "/opt/google/chrome/chrome" },
  // Distribution Chromium (Debian and its kin). Ubuntu's own `chromium` is a
  // snap, which lives elsewhere and is not used.
  { name: "Chromium", executable: "/usr/lib/chromium/chromium" },
  { name: "Chromium", executable: "/usr/lib/chromium-browser/chromium-browser" },
  { name: "Microsoft Edge", executable: "/opt/microsoft/msedge/msedge" },
  { name: "Brave", executable: "/opt/brave.com/brave/brave" },
];

/**
 * Root's, and writable by nobody else, along with the folder it sits in. The
 * exemption is by path, so a binary someone else could replace would hand
 * them the very thing the system restricted.
 */
export function rootOwned(file: string): boolean {
  try {
    for (const p of [file, path.dirname(file)]) {
      const st = statSync(p);
      if (st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    }
    return statSync(file).isFile();
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
  const managed = managedExecutable();
  if (managed) return { state: "installed", source: "managed", executable: managed };
  const system = systemBrowsers().at(0);
  if (system) return { state: "installed", source: "system", executable: system.executable, name: system.name };
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
