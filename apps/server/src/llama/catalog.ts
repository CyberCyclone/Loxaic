import { and, db, eq, sql } from "@loxaic/db";
import { localModels } from "@loxaic/db/schema";
import type { ModelThinking } from "@loxaic/types";
import type { ModelShape } from "./shape.ts";

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
  /** The attention layout from the GGUF header. Absent on rows downloaded
   * before it was read (the boot backfill fills it); null when the file did
   * not describe one. */
  shape?: ModelShape | null;
  /** The thinking control its chat template describes (inference/thinking.ts).
   * Absent on rows downloaded before it was read (the boot backfill fills it);
   * null when the template takes none, or the file has no template. */
  thinking?: ModelThinking | null;
  /** A multi-token-prediction head inside the model's own file (Qwen3.8-27B
   * carries one). Absent on rows downloaded before it was read (the boot
   * backfill fills it); null when the file carries none. */
  mtp?: { layers: number } | null;
}

export type MtpHeadStatus = "queued" | "downloading" | "ready" | "failed";

/** A separate MTP head file, downloaded beside a model (see `mtp_head`). */
export interface MtpHead extends ModelFile {
  /** The commit the head was resolved at — not necessarily the model's: a
   * model downloaded before its repo published heads gets one from a later
   * commit, and the file lives under that commit's directory. */
  revision: string;
  status: MtpHeadStatus;
  bytesDone: number;
  error: string | null;
  /** Its `nextn_predict_layers`, once the downloaded file has been read. */
  layers: number | null;
}

/**
 * Where a model's MTP head comes from, which decides whether turning MTP on
 * writes anything:
 * - `embedded`: the model's own file carries one (wins over a sidecar);
 * - `head`: a downloaded, verified sidecar head;
 * - `head-pending`: a sidecar queued or downloading — the setting may be on,
 *   but nothing is written until the head is ready;
 * - null: no head at all, or only one that was refused (it is kept to say
 *   why, and nothing can draft with it).
 */
export type MtpSource = "embedded" | "head" | "head-pending" | null;

export function mtpSource(row: Pick<LocalModelRow, "meta" | "mtpHead">): MtpSource {
  if (rowMeta(row).mtp) return "embedded";
  const head = rowMtpHead(row);
  if (!head || head.status === "failed") return null;
  return head.status === "ready" ? "head" : "head-pending";
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

export function rowMtpHead(row: Pick<LocalModelRow, "mtpHead">): MtpHead | null {
  const h = row.mtpHead as MtpHead | null;
  return h && typeof h.path === "string" && typeof h.revision === "string" ? h : null;
}

/** What the fit estimate needs to price MTP for these settings: the head's
 * layer count and, for a separate head, its file size. Null when MTP is off or
 * there is no head. A head still downloading is priced too — the settings
 * sheet is showing what the load will cost once it is there. */
export function mtpFitInput(
  row: Pick<LocalModelRow, "meta" | "mtpHead">,
  settings: Record<string, unknown>,
): { layers: number; headBytes: number } | null {
  if (settings.mtp !== true) return null;
  const own = rowMeta(row).mtp;
  if (own) return { layers: own.layers, headBytes: 0 };
  const head = rowMtpHead(row);
  return head && head.status !== "failed" ? { layers: head.layers ?? 1, headBytes: head.size } : null;
}

export function rowMeta(row: Pick<LocalModelRow, "meta">): LocalModelMeta {
  return row.meta as LocalModelMeta;
}
