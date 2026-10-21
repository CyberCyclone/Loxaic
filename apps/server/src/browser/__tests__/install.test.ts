import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchChoices } from "../manager.ts";
import { __setSystemBrowsersForTest, defaultBrowserDir, installBrowser, installState, unusableBrowserDir } from "../install.ts";

/** Where web_fetch's managed Chromium goes when BROWSER_DIR is unset (#281). */
describe("defaultBrowserDir", () => {
  it("is the user's cache folder, never the working directory", () => {
    expect(defaultBrowserDir("darwin", {}, "/Users/a")).toBe("/Users/a/Library/Caches/Loxaic/browsers");
    expect(defaultBrowserDir("linux", {}, "/home/a")).toBe("/home/a/.cache/loxaic/browsers");
    expect(defaultBrowserDir("linux", { XDG_CACHE_HOME: "/var/cache/a" }, "/home/a")).toBe("/var/cache/a/loxaic/browsers");
    expect(defaultBrowserDir("win32", { LOCALAPPDATA: "C:\\\\Users\\\\a\\\\AppData\\\\Local" }, "C:\\\\Users\\\\a")).toContain("Loxaic");
  });

  it("is never a folder macOS keeps sandboxed processes out of", () => {
    expect(unusableBrowserDir(defaultBrowserDir("darwin", {}, "/Users/a"), "darwin", "/Users/a")).toBeNull();
  });
});

describe("unusableBrowserDir", () => {
  it("refuses Documents, Desktop and Downloads on macOS, saying why", () => {
    for (const folder of ["Documents", "Desktop", "Downloads"]) {
      const reason = unusableBrowserDir(`/Users/a/${folder}/Git/Loxaic/apps/server/browsers`, "darwin", "/Users/a");
      expect(reason).toContain(`~/${folder}`);
      expect(reason).toContain("BROWSER_DIR");
    }
  });

  it("accepts anywhere else, and anything off macOS", () => {
    expect(unusableBrowserDir("/Users/a/Library/Application Support/Loxaic/browsers", "darwin", "/Users/a")).toBeNull();
    expect(unusableBrowserDir("/Users/a/Documentsx/browsers", "darwin", "/Users/a")).toBeNull();
    expect(unusableBrowserDir("/home/a/Documents/browsers", "linux", "/home/a")).toBeNull();
  });
});

describe.skipIf(process.platform !== "darwin")("a managed build inside ~/Documents", () => {
  const saved = { HOME: process.env.HOME, BROWSER_DIR: process.env.BROWSER_DIR };
  const home = mkdtempSync(path.join(tmpdir(), "loxaic-browser-home-"));
  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.BROWSER_DIR === undefined) delete process.env.BROWSER_DIR;
    else process.env.BROWSER_DIR = saved.BROWSER_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  it("is neither reported installed nor launched, and is not installed into", async () => {
    // os.homedir() reads HOME, so this home's Documents is the protected one.
    process.env.HOME = home;
    process.env.BROWSER_DIR = path.join(home, "Documents", "browsers");
    const build = path.join(process.env.BROWSER_DIR, "chromium_headless_shell-1248");
    const binary = path.join(build, `chrome-headless-shell-mac-${process.arch}`, "chrome-headless-shell");
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "");
    writeFileSync(path.join(build, "INSTALLATION_COMPLETE"), "");
    __setSystemBrowsersForTest([]);

    const state = installState();
    expect(state.state).toBe("failed");
    expect(state.state === "failed" ? state.error : "").toContain("~/Documents");
    expect(launchChoices()).toEqual([]);
    await expect(installBrowser()).rejects.toThrow("~/Documents");
  });
});
