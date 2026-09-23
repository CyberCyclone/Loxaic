import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, eq } from "@loxaic/db";
import { conversations, inferenceProviders, routines, user, userPrefs } from "@loxaic/db/schema";
import { __resetLegacyMigrationForTest, migrateLegacyInferenceUrl } from "../legacy-migration.ts";
import { invalidateProviderCache } from "../providers.ts";

/**
 * `INFERENCE_BASE_URL` becomes an added provider once, and the bare model
 * references that meant "a model on that backend" are pointed at it — so a
 * deployment upgraded with LM Studio behind that variable keeps working.
 *
 * Scoped to this suite's own user and flag key: unscoped, the migration would
 * rewrite every conversation in the shared development database.
 */

const ownerId = `legacy-mig-${uuid()}`;
const flagKey = `legacyInferenceMigrated-test-${uuid()}`;
const baseUrl = `http://legacy-${uuid().slice(0, 8)}.test:1234`;
const scope = { ownerId, flagKey };
let convId = "";
let routineId = "";

beforeAll(async () => {
  await db.insert(user).values({ id: ownerId, name: ownerId, email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  const [c] = await db.insert(conversations).values({ ownerId, modelPref: { model: "qwen3-27b" } }).returning();
  convId = c.id;
  await db.insert(conversations).values({ ownerId, modelPref: { model: "openrouter::gpt-4o" } });
  await db.insert(conversations).values({ ownerId, modelPref: { model: "default" } });
  const [r] = await db.insert(routines).values({ ownerId, name: "r", cron: "0 * * * *", prompt: "p", model: "qwen3-27b" }).returning();
  routineId = r.id;
  await db.insert(userPrefs).values({ userId: ownerId, recentModels: ["qwen3-27b", "openrouter::gpt-4o", "default"] });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await __resetLegacyMigrationForTest(flagKey);
  await db.delete(routines).where(eq(routines.ownerId, ownerId));
  await db.delete(conversations).where(eq(conversations.ownerId, ownerId));
  await db.delete(userPrefs).where(eq(userPrefs.userId, ownerId));
  await db.delete(inferenceProviders).where(eq(inferenceProviders.baseUrl, `${baseUrl}/v1`));
  await db.delete(user).where(eq(user.id, ownerId));
  invalidateProviderCache();
});

describe("INFERENCE_BASE_URL migration", () => {
  it("does nothing in mock mode or with the variable unset", async () => {
    vi.stubEnv("INFERENCE_BASE_URL", "");
    expect((await migrateLegacyInferenceUrl(() => undefined, { scope })).migrated).toBe(false);
    vi.stubEnv("INFERENCE_BASE_URL", baseUrl);
    vi.stubEnv("MOCK_INFERENCE", "true");
    expect((await migrateLegacyInferenceUrl(() => undefined, { scope })).migrated).toBe(false);
    vi.stubEnv("MOCK_INFERENCE", "false");
  });

  it("adds the backend as a provider and points bare references at it", async () => {
    vi.stubEnv("INFERENCE_BASE_URL", baseUrl);
    const logs: string[] = [];
    const result = await migrateLegacyInferenceUrl((m) => logs.push(m), { scope });
    expect(result.migrated).toBe(true);
    const slug = result.slug ?? "";
    const [provider] = await db.select().from(inferenceProviders).where(eq(inferenceProviders.baseUrl, `${baseUrl}/v1`));
    expect(provider.slug).toBe(slug);

    const convs = await db.select().from(conversations).where(eq(conversations.ownerId, ownerId));
    const models = convs.map((c) => (c.modelPref as { model: string }).model).sort();
    expect(models).toEqual(["default", `${slug}::qwen3-27b`, "openrouter::gpt-4o"].sort());
    expect(convs.find((c) => c.id === convId)?.modelPref).toEqual({ model: `${slug}::qwen3-27b` });

    const [r] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(r.model).toBe(`${slug}::qwen3-27b`);
    const [prefs] = await db.select().from(userPrefs).where(eq(userPrefs.userId, ownerId));
    expect(prefs.recentModels).toEqual([`${slug}::qwen3-27b`, "openrouter::gpt-4o", "default"]);
    expect(logs.join(" ")).toMatch(/no longer read/);
  });

  it("runs once: a second boot changes nothing and says the variable is unused", async () => {
    const logs: string[] = [];
    const result = await migrateLegacyInferenceUrl((m) => logs.push(m), { scope });
    expect(result.migrated).toBe(false);
    expect(logs.join(" ")).toMatch(/no longer used/);
    const rows = await db.select().from(inferenceProviders).where(eq(inferenceProviders.baseUrl, `${baseUrl}/v1`));
    expect(rows).toHaveLength(1);
  });
});
