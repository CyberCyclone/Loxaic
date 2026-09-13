import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdater, whyDisabled } from "../updater.js";

let dataDir;
beforeEach(() => { dataDir = mkdtempSync(path.join(os.tmpdir(), "loxaic-updates-")); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

/** Stands in for electron-updater's autoUpdater: the same event surface, the
 * same two flags this code is allowed to set, and a record of what was asked
 * of it. */
function fakeUpdater() {
  const updater = new EventEmitter();
  updater.calls = [];
  // `channel` is a *setter* on the real AppUpdater, and assigning it sets
  // allowDowngrade = true as a side effect (AppUpdater.js). Imitated here
  // because that side effect is the whole reason the production code puts
  // allowDowngrade back afterwards — a fake with a plain property would let
  // the ordering break silently, which is the bug this guards.
  let channel = null;
  Object.defineProperty(updater, "channel", {
    get: () => channel,
    set: (value) => { channel = value; updater.allowDowngrade = true; },
  });
  updater.checkForUpdates = () => { updater.calls.push("check"); return Promise.resolve(null); };
  updater.setFeedURL = (options) => { updater.calls.push(["setFeedURL", options]); };
  updater.quitAndInstall = (...args) => { updater.calls.push(["quitAndInstall", ...args]); };
  return updater;
}

function make(overrides = {}) {
  const logs = [];
  const states = [];
  const autoUpdater = overrides.autoUpdater ?? fakeUpdater();
  let loaded = 0;
  const updater = createUpdater({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    platform: "darwin",
    env: {},
    argv: [],
    log: (line) => logs.push(line),
    onState: (s) => states.push(s),
    loadModule: () => { loaded += 1; return Promise.resolve({ autoUpdater }); },
    ...overrides,
  });
  return { updater, autoUpdater, logs, states, loadCount: () => loaded };
}

describe("why the updater is off", () => {
  it("names the reason, and is null when it is on", () => {
    expect(whyDisabled({ app: { isPackaged: true }, platform: "darwin", env: {} })).toBe(null);
    expect(whyDisabled({ app: { isPackaged: false }, platform: "darwin", env: {} })).toMatch(/development/i);
    expect(whyDisabled({ app: { isPackaged: true }, env: { LOXAIC_DISABLE_UPDATES: "1" } })).toMatch(/switched off/i);
    expect(whyDisabled({ app: { isPackaged: true }, argv: ["--loxaic-no-updates"] })).toMatch(/switched off/i);
  });

  it("is off on Linux unless the app is running as an AppImage", () => {
    // A .deb or .rpm is owned by the package manager: replacing it from
    // inside the app would need a root prompt at quit time.
    const app = { isPackaged: true };
    expect(whyDisabled({ app, platform: "linux", env: {} })).toMatch(/package/i);
    expect(whyDisabled({ app, platform: "linux", env: { APPIMAGE: "/tmp/Loxaic.AppImage" } })).toBe(null);
  });
});

describe("the desktop updater", () => {
  it("loads nothing at all when it is disabled", async () => {
    // electron-updater drags in fs-extra, js-yaml and lodash. A development
    // launch has no use for any of them.
    const { updater, loadCount } = make({ app: { isPackaged: false, getVersion: () => "0.0.0" } });
    await updater.check();
    await updater.install();
    expect(loadCount()).toBe(0);
    expect(updater.state()).toMatchObject({ enabled: false, status: "off" });
  });

  it("turns the updater's events into state", async () => {
    const { updater, autoUpdater, states } = make();
    await updater.check();
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version: "1.3.0" });
    autoUpdater.emit("download-progress", { percent: 50 });
    autoUpdater.emit("update-downloaded", { version: "1.3.0" });
    expect(updater.state()).toMatchObject({ status: "ready", availableVersion: "1.3.0" });
    expect(states.at(-1).status).toBe("ready");
  });

  it("carries a failure as a sentence rather than a throw", async () => {
    const autoUpdater = fakeUpdater();
    autoUpdater.checkForUpdates = () => Promise.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
    const { updater, logs } = make({ autoUpdater });
    await expect(updater.check()).resolves.toMatchObject({ status: "error" });
    expect(updater.state().error).toMatch(/ERR_INTERNET_DISCONNECTED/);
    expect(logs.some((l) => l.includes("ERR_INTERNET_DISCONNECTED"))).toBe(true);
  });

  it("says a failure once, not twice, when it both emits and rejects", async () => {
    // Which is what electron-updater actually does for most failures. The
    // packaged app's first real check printed the same ENOENT twice.
    const autoUpdater = fakeUpdater();
    autoUpdater.checkForUpdates = () => {
      autoUpdater.emit("error", new Error("app-update.yml is missing"));
      return Promise.reject(new Error("app-update.yml is missing"));
    };
    const { updater, logs } = make({ autoUpdater });
    await updater.check();
    expect(logs.filter((l) => l.includes("app-update.yml is missing"))).toHaveLength(1);
    expect(updater.state()).toMatchObject({ status: "error" });
  });

  it("asks for the plain latest release when it is the stable app", async () => {
    // allowPrerelease false means the provider uses /releases/latest, which
    // GitHub defines as excluding prereleases — so a stable install can never
    // be offered a beta, without anything else being configured.
    const { updater, autoUpdater } = make();
    await updater.check();
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.channel).toBe(null);
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  it("cannot be a beta app that ignores betas, because the variant decides both", async () => {
    // `allowPrerelease` used to be its own option, which made
    // {variant: "beta", allowPrerelease: false} expressible — and that fails
    // in the quiet direction: /releases/latest excludes prereleases, so the
    // beta app would have been blind to every beta tag while its settings row
    // still said "beta", and a check finding nothing looks exactly like being
    // up to date.
    const beta = make({ variant: "beta" });
    await beta.updater.check();
    expect(beta.autoUpdater.allowPrerelease).toBe(true);

    const stable = make({ variant: "production" });
    await stable.updater.check();
    expect(stable.autoUpdater.allowPrerelease).toBe(false);
    expect(stable.autoUpdater.channel).toBe(null);
  });

  it("pins the beta app to the beta feed, and puts allowDowngrade back after", async () => {
    // allowPrerelease alone is not enough: the provider then takes the newest
    // feed entry whether or not it is a prerelease, and asks that release for
    // latest*.yml — so a beta install would replace itself with the stable
    // app the first time a release tag landed. Pinning the channel makes it
    // ask for beta*.yml, which the beta variant publishes on every tag.
    const { updater, autoUpdater } = make({ variant: "beta" });
    await updater.check();
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.channel).toBe("beta");
    // Assigning the channel set this to true; it has to end up false, or a
    // beta walks backwards. Order-dependent, which is why the fake imitates
    // the real setter.
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(updater.state().variant).toBe("beta");
  });

  it("installs only what it has, and stops the children before it does", async () => {
    const order = [];
    const autoUpdater = fakeUpdater();
    autoUpdater.quitAndInstall = (...args) => { order.push(["quitAndInstall", ...args]); };
    const { updater } = make({
      autoUpdater,
      beforeInstall: async () => {
        await Promise.resolve();
        order.push("children stopped");
      },
    });

    // Nothing downloaded: a Restart press must not quit the app into nothing.
    await updater.install();
    expect(order).toEqual([]);

    await updater.check();
    autoUpdater.emit("update-downloaded", { version: "1.3.0" });
    await updater.install();
    // The installer is about to replace the binary those children were
    // spawned from, and Postgres has to be down before that happens.
    expect(order).toEqual(["children stopped", ["quitAndInstall", false, true]]);
  });

  it("finds autoUpdater on the CommonJS default export, as Node really hands it over", async () => {
    // electron-updater defines `autoUpdater` with a defineProperty getter, and
    // Node's cjs-module-lexer cannot see one — so the namespace a dynamic
    // import() produces carries only `default`. Every other case here builds a
    // hand-written module with real named exports, which is exactly why they
    // all passed while the packaged app failed on its first launch with
    // "Cannot set properties of undefined (setting 'logger')".
    const autoUpdater = fakeUpdater();
    const { updater } = make({ autoUpdater, loadModule: () => Promise.resolve({ default: { autoUpdater } }) });
    await updater.check();
    expect(autoUpdater.calls).toContain("check");
    expect(updater.state().status).not.toBe("error");
  });

  it("says so plainly when the module has no updater at all", async () => {
    const { updater } = make({ loadModule: () => Promise.resolve({ default: {} }) });
    await updater.check();
    expect(updater.state()).toMatchObject({ status: "error" });
    expect(updater.state().error).toMatch(/no autoUpdater/i);
  });

  it("reports a shutdown that fails before the install, and does not install", async () => {
    // beforeInstall stops Postgres, the server, the executor and the sidecar.
    // If it rejects, the backend is already down — that has to be a sentence
    // on screen, not a rejection into a void while the row says "ready".
    const autoUpdater = fakeUpdater();
    const { updater } = make({ autoUpdater, beforeInstall: () => Promise.reject(new Error("postgres refused to stop")) });
    await updater.check();
    autoUpdater.emit("update-downloaded", { version: "1.3.0" });
    await updater.install();
    expect(updater.state()).toMatchObject({ status: "error" });
    expect(updater.state().error).toMatch(/postgres refused to stop/);
    expect(autoUpdater.calls.some((c) => Array.isArray(c) && c[0] === "quitAndInstall")).toBe(false);
  });

  it("uses a private feed only when told to, and never logs the token", async () => {
    const { updater, autoUpdater, logs } = make({ env: { LOXAIC_GH_TOKEN: "ghp_secret_value" } });
    await updater.check();
    const call = autoUpdater.calls.find((c) => Array.isArray(c) && c[0] === "setFeedURL");
    expect(call[1]).toMatchObject({ provider: "github", private: true, token: "ghp_secret_value" });
    // Said loudly enough that nobody ships with it set, without the value.
    expect(logs.some((l) => /testing only/i.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain("ghp_secret_value");
    for (const file of readdirSync(dataDir)) {
      expect(readFileSync(path.join(dataDir, file), "utf8")).not.toContain("ghp_secret_value");
    }
  });

  it("checks after a delay and then on an interval, and stops when told", async () => {
    const { updater, autoUpdater } = make({ launchDelayMs: 1, checkIntervalMs: 1 });
    updater.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const seen = autoUpdater.calls.filter((c) => c === "check").length;
    expect(seen).toBeGreaterThan(1);
    updater.stop();
    const after = autoUpdater.calls.filter((c) => c === "check").length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(autoUpdater.calls.filter((c) => c === "check").length).toBe(after);
  });
});
