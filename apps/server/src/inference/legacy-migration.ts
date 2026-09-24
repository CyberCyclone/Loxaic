import { db, eq, sql } from "@loxaic/db";
import { conversations, inferenceProviders, routines, serverSettings, userPrefs } from "@loxaic/db/schema";
import { MODEL_REF_SEPARATOR } from "@loxaic/types";
import { allocateSlug, invalidateProviderCache, normalizeBaseUrl } from "./providers.ts";

/**
 * `INFERENCE_BASE_URL` used to name the built-in backend. The built-in
 * provider is now the llama.cpp router this server manages, so a deployment
 * that pointed that variable at LM Studio or a llama.cpp host of its own would
 * lose its backend on upgrade — and every conversation naming one of its
 * models would suddenly be refused.
 *
 * So, once, at boot: the URL becomes an ordinary added provider, and every
 * *bare* model reference a conversation, routine or recents list still holds
 * is rewritten to `slug::ref` for it, since those references meant "the model
 * on that backend". After that the variable is ignored, and says so.
 *
 * Not rewritten: `messages.model` and `usage_records.model`, which are history
 * ("what answered then"), and the `"default"` sentinel, which is not a model.
 *
 * Idempotent through a `server_settings` flag. When a provider row already
 * points at the same address (an admin added it by hand), the references are
 * pointed at that row instead of creating a twin. Skipped under
 * MOCK_INFERENCE, where the variable was never consulted.
 */

const DEFAULT_FLAG_KEY = "legacyInferenceMigrated";
const NAME = "Migrated backend";

export interface LegacyMigrationResult {
  migrated: boolean;
  slug?: string;
  rewritten?: { conversations: number; routines: number; users: number };
}

export interface LegacyMigrationOptions {
  /**
   * Test seam: rewrite only this user's rows, and keep the "done" flag under a
   * key of the test's own. The real migration is deployment-wide by nature;
   * run unscoped from a test, it would rewrite every conversation in the
   * shared development database — the same reason `reapAbandonedSandboxes`
   * takes an owner.
   */
  scope?: { ownerId: string; flagKey: string };
}

export async function migrateLegacyInferenceUrl(
  log: (m: string) => void,
  opts: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const FLAG_KEY = opts.scope?.flagKey ?? DEFAULT_FLAG_KEY;
  const ownerConv = opts.scope ? sql`AND owner_id = ${opts.scope.ownerId}` : sql``;
  const ownerPrefs = opts.scope ? sql`AND user_id = ${opts.scope.ownerId}` : sql``;
  const raw = process.env.INFERENCE_BASE_URL;
  if (!raw || process.env.MOCK_INFERENCE === "true") return { migrated: false };

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(raw);
  } catch {
    log(`INFERENCE_BASE_URL="${raw}" is not a valid URL and was ignored.`);
    return { migrated: false };
  }

  const done = await db.query.serverSettings.findFirst({ where: eq(serverSettings.key, FLAG_KEY) });
  if (done) {
    log(
      "INFERENCE_BASE_URL is set but no longer used — it was converted into a provider. " +
        "Remove it from the environment; manage it under Settings > Model Providers.",
    );
    return { migrated: false };
  }

  // An admin may already have added the same backend by hand. Reuse that row
  // rather than adding a twin — its slug is where the references should point.
  const existing = (await db.select().from(inferenceProviders).where(eq(inferenceProviders.baseUrl, baseUrl)).limit(1)).at(0);
  const slug = existing?.slug ?? (await allocateSlug(NAME));
  const name = existing?.name ?? NAME;
  const prefix = `${slug}${MODEL_REF_SEPARATOR}`;
  const result = await db.transaction(async (tx) => {
    if (!existing) await tx.insert(inferenceProviders).values({ name: NAME, slug, baseUrl, enabled: true });

    // A bare ref has no `::` (or a `::` whose left side is not slug-shaped —
    // parseModelRef treats those as bare too, but no real id looks like that,
    // and the conservative rewrite is to leave them alone).
    const convs = await tx.execute(sql`
      UPDATE ${conversations}
      SET model_pref = jsonb_set(model_pref, '{model}', to_jsonb(${prefix}::text || (model_pref->>'model')))
      WHERE model_pref ? 'model'
        AND jsonb_typeof(model_pref->'model') = 'string'
        AND position('::' in model_pref->>'model') = 0
        AND model_pref->>'model' <> 'default'
        AND model_pref->>'model' <> ''
        ${ownerConv}
      RETURNING 1
    `);
    const routs = await tx.execute(sql`
      UPDATE ${routines}
      SET model = ${prefix} || model
      WHERE model IS NOT NULL AND position('::' in model) = 0 AND model <> 'default' AND model <> ''
        ${ownerConv}
      RETURNING 1
    `);
    const users = await tx.execute(sql`
      UPDATE ${userPrefs}
      SET recent_models = (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN jsonb_typeof(v) = 'string' AND position('::' in v #>> '{}') = 0 AND v #>> '{}' <> 'default'
               THEN to_jsonb(${prefix}::text || (v #>> '{}'))
               ELSE v END
          ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(recent_models) WITH ORDINALITY AS t(v, ord)
      )
      WHERE jsonb_array_length(recent_models) > 0
        ${ownerPrefs}
      RETURNING 1
    `);
    await tx
      .insert(serverSettings)
      .values({ key: FLAG_KEY, value: { baseUrl, slug, at: new Date().toISOString() }, updatedAt: new Date() })
      .onConflictDoNothing();
    return { conversations: convs.length, routines: routs.length, users: users.length };
  });
  invalidateProviderCache();
  log(
    `INFERENCE_BASE_URL (${baseUrl}) is now the provider "${name}" — ${String(result.conversations)} conversation(s), ` +
      `${String(result.routines)} routine(s) and ${String(result.users)} user(s)' recent models now point at it. ` +
      "The variable is no longer read; remove it from the environment.",
  );
  return { migrated: true, slug, rewritten: result };
}

/** Test seam: forget that a scoped migration ran. */
export async function __resetLegacyMigrationForTest(flagKey: string): Promise<void> {
  await db.delete(serverSettings).where(eq(serverSettings.key, flagKey));
}
