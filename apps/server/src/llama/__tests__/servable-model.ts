import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import { invalidateLocalModelCache } from "../catalog.ts";

/**
 * Make a bare model reference usable for a test that runs without
 * MOCK_INFERENCE: a downloaded, enabled `local_models` row under a host id of
 * the suite's own (`LOXAIC_INSTANCE_ID`, which is what the table is scoped
 * by), so no other suite sharing the database sees it.
 *
 * Before local models, any bare reference resolved; now only an enabled one
 * does. Suites that only need *a* usable model name use this rather than the
 * rule being loosened for them. Returns the cleanup.
 */
export async function useServableModels(ids: string[]): Promise<() => Promise<void>> {
  const host = `test-servable-${uuid()}`;
  const previous = process.env.LOXAIC_INSTANCE_ID;
  process.env.LOXAIC_INSTANCE_ID = host;
  await db.insert(localModels).values(
    ids.map((id) => ({
      id,
      hostId: host,
      repo: "test/servable",
      revision: "0".repeat(40),
      quant: "Q4",
      files: [],
      sizeBytes: 0,
      status: "ready" as const,
      enabled: true,
      displayName: id,
      publisher: "test",
    })),
  );
  invalidateLocalModelCache();
  return async () => {
    await db.delete(localModels).where(eq(localModels.hostId, host));
    if (previous === undefined) Reflect.deleteProperty(process.env, "LOXAIC_INSTANCE_ID");
    else process.env.LOXAIC_INSTANCE_ID = previous;
    invalidateLocalModelCache();
  };
}
