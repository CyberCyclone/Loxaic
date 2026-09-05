import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, eq } from "@loxaic/db";
import { serverSettings } from "@loxaic/db/schema";
import { __resetClusterForTest, ensureCluster, getCluster } from "../cluster.ts";

/**
 * The cluster name is the product brand, not user data — nothing but
 * `ensureCluster` ever writes this row — so a stored name that disagrees is a
 * stale brand. That is what these cover: the Loxaic rename left every
 * already-booted database announcing "Shannon" to clients, because the name is
 * minted once and the old `?? "Loxaic"` fallback only fires when it is absent.
 */
const CLUSTER_KEY = "cluster";

async function seed(value: unknown): Promise<void> {
  await db
    .insert(serverSettings)
    .values({ key: CLUSTER_KEY, value })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value } });
}

async function storedValue(): Promise<{ id?: string; name?: string; untouched?: string }> {
  const row = await db.query.serverSettings.findFirst({
    where: eq(serverSettings.key, CLUSTER_KEY),
  });
  return row?.value ?? {};
}

beforeEach(async () => {
  __resetClusterForTest();
  await db.delete(serverSettings).where(eq(serverSettings.key, CLUSTER_KEY));
});

afterEach(async () => {
  __resetClusterForTest();
  await db.delete(serverSettings).where(eq(serverSettings.key, CLUSTER_KEY));
});

describe("ensureCluster", () => {
  it("mints Loxaic against an empty database", async () => {
    const cluster = await ensureCluster();
    expect(cluster.name).toBe("Loxaic");
    expect(cluster.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refreshes a pre-rename name, and persists the refresh", async () => {
    await seed({ id: "11111111-1111-4111-8111-111111111111", name: "Shannon" });

    const cluster = await ensureCluster();

    expect(cluster.name).toBe("Loxaic");
    expect((await storedValue()).name).toBe("Loxaic");
  });

  it("never rewrites the id while refreshing the name", async () => {
    // The id is the cluster's identity — a database is a cluster *because* of
    // it — so a name refresh that regenerated it would silently fork the
    // cluster every existing host belongs to.
    const id = "22222222-2222-4222-8222-222222222222";
    await seed({ id, name: "Shannon" });

    expect((await ensureCluster()).id).toBe(id);
    expect((await storedValue()).id).toBe(id);
  });

  it("does not write when the stored name is already current", async () => {
    // The refresh replaces the whole jsonb value, so an unrelated field
    // surviving is proof no write happened — `updated_at` has no $onUpdate
    // and would be unchanged either way.
    const id = "33333333-3333-4333-8333-333333333333";
    await seed({ id, name: "Loxaic", untouched: "kept" });

    await ensureCluster();

    expect(await storedValue()).toMatchObject({ id, name: "Loxaic", untouched: "kept" });
  });
});

describe("getCluster", () => {
  it("returns null rather than minting against an empty database", async () => {
    expect(await getCluster()).toBeNull();
    expect(await storedValue()).toEqual({});
  });

  it("reports the current name for a pre-rename row without writing", async () => {
    // It is reached by an unauthenticated route, so it must stay read-only —
    // ensureCluster runs at boot and is what actually repairs the row.
    await seed({ id: "44444444-4444-4444-8444-444444444444", name: "Shannon" });

    expect((await getCluster())?.name).toBe("Loxaic");
    expect((await storedValue()).name).toBe("Shannon");
  });
});
