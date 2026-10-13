import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import { getInferenceSettings, SettingsError, updateInferenceSettings } from "../settings.ts";

/**
 * The deployment-wide inference settings row. One row every suite shares, so
 * whatever this file finds there is put back at the end.
 *
 * Nothing here calls `loadServerSettings`: this module's cache starts empty,
 * which is exactly what a failed boot read leaves behind.
 */
const KEY = "inference";
let original: unknown;

beforeAll(async () => {
  original = (await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) }))?.value;
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "PERMISSION_CHECK_TIMEOUT_MS");
});

afterAll(async () => {
  if (original === undefined) await db.delete(serverSettings).where(eq(serverSettings.key, KEY));
  else await db.update(serverSettings).set({ value: original }).where(eq(serverSettings.key, KEY));
});

async function storedRow(): Promise<unknown> {
  return (await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, KEY) }))?.value;
}

describe("updateInferenceSettings", () => {
  it("merges into the stored row, not this process's copy, so a failed boot read loses nothing", async () => {
    // Stored by another process (or before a restart whose read failed).
    await db
      .insert(serverSettings)
      .values({ key: KEY, value: { maxConcurrentRuns: 3, permissionCheckModel: "some-model" } })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: { maxConcurrentRuns: 3, permissionCheckModel: "some-model" } } });

    const view = await updateInferenceSettings({ permissionCheckTimeoutMs: 60_000 });

    expect(await storedRow()).toEqual({ maxConcurrentRuns: 3, permissionCheckModel: "some-model", permissionCheckTimeoutMs: 60_000 });
    // And the cache now holds what is stored, not just the patch.
    expect(view).toMatchObject({ maxConcurrentRuns: 3, permissionCheckModel: "some-model", permissionCheckTimeoutMs: 60_000 });
  });

  it("clears a field only when asked to", async () => {
    await updateInferenceSettings({ permissionCheckModel: null });
    expect(await storedRow()).toMatchObject({ maxConcurrentRuns: 3, permissionCheckModel: null, permissionCheckTimeoutMs: 60_000 });
    expect(getInferenceSettings().permissionCheckModel).toBeNull();
  });

  it("refuses a timeout pinned by PERMISSION_CHECK_TIMEOUT_MS, and says it is pinned", async () => {
    process.env.PERMISSION_CHECK_TIMEOUT_MS = "20000";
    expect(getInferenceSettings()).toMatchObject({
      permissionCheckTimeoutMs: 20_000,
      envOverrides: { permissionCheckTimeoutMs: true },
    });
    const refused = await updateInferenceSettings({ permissionCheckTimeoutMs: 300_000 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SettingsError);
    expect(refused).toMatchObject({ code: "envOverride" });
    expect(await storedRow()).toMatchObject({ permissionCheckTimeoutMs: 60_000 });
    // The other fields are still the admin's.
    await expect(updateInferenceSettings({ maxConcurrentRuns: 2 })).resolves.toMatchObject({ maxConcurrentRuns: 2 });
  });

  it("reports the timeout as the admin's own when nothing pins it", () => {
    expect(getInferenceSettings().envOverrides).toEqual({ maxConcurrentRuns: false, permissionCheckTimeoutMs: false });
  });
});
