import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import { BROWSER_DEFAULTS, getBrowserSettings, SettingsError, updateBrowserSettings } from "../settings.ts";
import { __activeBrowserCount, __resetBrowsersForTest, __setChromiumLoaderForTest, withConversationBrowser } from "../browser/manager.ts";
import { closeSinkhole } from "../browser/sinkhole.ts";
import type { BrowserLike, ChromiumLike } from "../browser/types.ts";

/**
 * web_fetch's browser fallback settings row (#281). One row every suite
 * shares, so what this file finds is put back. Nothing calls
 * loadServerSettings: the cache starts empty, as a failed boot read leaves it.
 */
const KEY = "browser";
let original: unknown;

beforeAll(async () => {
  original = (await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) }))?.value;
});

afterEach(() => {
  for (const k of ["BROWSER_ENABLED", "BROWSER_MAX", "BROWSER_EXECUTABLE"]) Reflect.deleteProperty(process.env, k);
});

afterAll(async () => {
  await __resetBrowsersForTest();
  await closeSinkhole();
  if (original === undefined) await db.delete(serverSettings).where(eq(serverSettings.key, KEY));
  else await db.update(serverSettings).set({ value: original }).where(eq(serverSettings.key, KEY));
});

const stored = async () => (await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) }))?.value;

describe("browser settings", () => {
  it("are off by default", async () => {
    await db.delete(serverSettings).where(eq(serverSettings.key, KEY));
    expect(getBrowserSettings()).toMatchObject({ ...BROWSER_DEFAULTS, enabled: false });
  });

  it("merge a change into the stored row in one statement, not into this process's copy", async () => {
    await db
      .insert(serverSettings)
      .values({ key: KEY, value: { idleMs: 120_000 } })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: { idleMs: 120_000 } } });
    const view = await updateBrowserSettings({ maxBrowsers: 5 });
    expect(await stored()).toEqual({ idleMs: 120_000, maxBrowsers: 5 });
    expect(view).toMatchObject({ idleMs: 120_000, maxBrowsers: 5 });
  });

  it("refuse values out of range or of the wrong type", async () => {
    for (const patch of [{ maxBrowsers: 0 }, { maxBrowsers: 17 }, { maxBrowsers: 1.5 }, { idleMs: 1000 }, { actionTimeoutMs: 600_000 }, { enabled: "yes" }, {}]) {
      await expect(updateBrowserSettings(patch)).rejects.toThrow(SettingsError);
    }
  });

  it("refuse a field an environment variable pins, and say so", async () => {
    process.env.BROWSER_ENABLED = "true";
    expect(getBrowserSettings()).toMatchObject({ enabled: true, envOverrides: { enabled: true } });
    const err = await updateBrowserSettings({ enabled: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe("envOverride");
  });

  it("close every browser when switched off", async () => {
    let closed = false;
    const fake: ChromiumLike = {
      launch: () => {
        let onDisconnect: (() => void) | undefined;
        const browser: BrowserLike = {
          newContext: () => Promise.resolve({
            newPage: () => Promise.reject(new Error("unused")),
            route: () => Promise.resolve(),
            routeWebSocket: () => Promise.resolve(),
            newCDPSession: () => Promise.reject(new Error("unused")),
            addInitScript: () => Promise.resolve(),
            on: () => undefined,
            close: () => Promise.resolve(),
          }),
          version: () => "156.0.0.0",
          close: () => { closed = true; onDisconnect?.(); return Promise.resolve(); },
          on: (_e, l) => { onDisconnect = l; },
        };
        return Promise.resolve(browser);
      },
    };
    __setChromiumLoaderForTest(() => Promise.resolve(fake));
    process.env.BROWSER_EXECUTABLE = "/fake/chrome";
    await updateBrowserSettings({ enabled: true });
    await withConversationBrowser("conv", () => Promise.resolve());
    expect(__activeBrowserCount()).toBe(1);
    await updateBrowserSettings({ enabled: false });
    expect(closed).toBe(true);
    expect(__activeBrowserCount()).toBe(0);
  });
});
