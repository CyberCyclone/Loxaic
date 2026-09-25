import { and, db, eq, sql } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";

/**
 * The `local_models` table, read through a short cache.
 *
 * Every chat send resolves its model through here (the enabled check is the
 * server-side gate), so the read is cached for a few seconds the way provider
 * rows are; every write in this process invalidates it.
 */

export type LocalModelRow = typeof localModels.$inferSelect;

export interface ModelFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface LocalModelMeta {
  nLayers?: number | null;
  nCtxTrain?: number | null;
  nParams?: number | null;
  architecture?: string | null;
  expertCount?: number | null;
}

/** This instance's identity for the `host_id` column. Files are on one
 * machine's disk, so a cluster sharing a database must only ever see its own
 * downloads. `""` for an instance with no registered identity. */
export function localHostId(): string {
  return process.env.LOXAIC_INSTANCE_ID ?? "";
}

function hostScope() {
  return eq(localModels.hostId, localHostId());
}

const TTL_MS = 3000;
let cache: { at: number; rows: LocalModelRow[] } | null = null;

export function invalidateLocalModelCache(): void {
  cache = null;
}

/** Every row this host holds, in any state, oldest first. The id breaks ties
 * (rows inserted together share `now()`), since "default" takes the first. */
export async function listLocalModelRows(): Promise<LocalModelRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await db.select().from(localModels).where(hostScope()).orderBy(sql`${localModels.createdAt} asc`, sql`${localModels.id} asc`);
  cache = { at: Date.now(), rows };
  return rows;
}

/** What the router serves and users may pick. The one definition of "usable". */
export function isServable(row: LocalModelRow): boolean {
  return row.status === "ready" && row.enabled;
}

export async function listServableModels(): Promise<LocalModelRow[]> {
  return (await listLocalModelRows()).filter(isServable);
}

export async function getLocalModelRow(id: string): Promise<LocalModelRow | null> {
  const rows = await db.select().from(localModels).where(and(eq(localModels.id, id), hostScope())).limit(1);
  return rows.at(0) ?? null;
}

export async function updateLocalModelRow(
  id: string,
  patch: Partial<typeof localModels.$inferInsert>,
): Promise<LocalModelRow | null> {
  const rows = await db
    .update(localModels)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(localModels.id, id), hostScope()))
    .returning();
  invalidateLocalModelCache();
  return rows.at(0) ?? null;
}

export async function insertLocalModelRow(row: typeof localModels.$inferInsert): Promise<LocalModelRow> {
  const [created] = await db.insert(localModels).values({ ...row, hostId: localHostId() }).returning();
  invalidateLocalModelCache();
  return created;
}

export async function deleteLocalModelRow(id: string): Promise<boolean> {
  const deleted = await db.delete(localModels).where(and(eq(localModels.id, id), hostScope())).returning();
  invalidateLocalModelCache();
  return deleted.length > 0;
}

export function rowFiles(row: Pick<LocalModelRow, "files">): ModelFile[] {
  return Array.isArray(row.files) ? (row.files as ModelFile[]) : [];
}

export function rowMmproj(row: Pick<LocalModelRow, "mmproj">): ModelFile | null {
  const m = row.mmproj as ModelFile | null;
  return m && typeof m.path === "string" ? m : null;
}

export function rowMeta(row: Pick<LocalModelRow, "meta">): LocalModelMeta {
  return row.meta as LocalModelMeta;
}
