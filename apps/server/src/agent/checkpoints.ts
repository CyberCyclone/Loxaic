/**
 * File checkpoints: what a file was before a turn changed it, so a rewind can
 * put it back (#166). Modelled on Claude Code's:
 *
 * - **One checkpoint per turn**, keyed by the turn's user message. A turn's
 *   first `fs_write` or `fs_edit` of a path records the path's state before
 *   it; later writes in the same turn change nothing.
 * - **Only the file-edit tools are tracked.** A `bash` command, the terminal,
 *   and anything outside Loxaic are not, and a restore cannot undo them — the
 *   rewind dialog says so. Neither are symlinks or files over 10 MiB: they are
 *   recorded as such and reported as skipped.
 * - **A sub-agent's edits are its parent's turn's.** A child works in its
 *   parent's workspace and is removed with the turn that spawned it.
 * - **The newest 100 turns are kept** per conversation.
 *
 * The copies are made inside the workspace with `cp -p`, by `exec`, so no file
 * content crosses the wire and the bytes (and mode) are exact:
 *   - a server workspace (a container or a host directory) keeps them beside
 *     the working tree, under `<root>/.loxaic/checkpoints`, and they go when
 *     the workspace is destroyed;
 *   - a folder on the person's own machine, used directly, has no "beside":
 *     its root is the folder. Those go under `~/.loxaic/checkpoints` on that
 *     machine, never inside the person's folder.
 * The database holds only the manifest (`checkpoint_files`).
 */
import posix from "node:path/posix";
import { db, and, asc, desc, eq, gte, gt, inArray, sql } from "@loxaic/db";
import { checkpointFiles } from "@loxaic/db/schema";
import type { SandboxHandle } from "../sandbox/provider.ts";
import { resolvePath } from "./executor.ts";

export const CHECKPOINT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CHECKPOINT_KEEP_TURNS = 100;

/** The turn a write belongs to: the conversation whose workspace it is in,
 * and the user message that turn answers. */
export interface CheckpointTurn {
  conversationId: string;
  turnMessageId: string;
}

export type CheckpointState = "saved" | "missing" | "too_large" | "symlink" | "not_file" | "unknown";

export interface RestoreReport {
  restored: string[];
  skipped: { path: string; reason: string }[];
}

/**
 * Where a workspace keeps its copies. `~` is expanded by the shell on the
 * machine that runs the command, so a direct local folder's copies land in
 * that person's home, wherever it is.
 */
function storeRoot(handle: SandboxHandle): string {
  return handle.root === handle.workdir ? "~/.loxaic/checkpoints" : posix.join(handle.root, ".loxaic", "checkpoints");
}

function turnDir(handle: SandboxHandle, turn: CheckpointTurn): string {
  return `${storeRoot(handle)}/${turn.conversationId}/${turn.turnMessageId}`;
}

/** Expands a leading `~/` in `$2` (the copy directory) before anything else. */
const EXPAND_DIR = 'dir="$2"; case "$dir" in "~/"*) dir="$HOME/${dir#"~/"}";; esac';

const SAVE_SCRIPT = `${EXPAND_DIR}
src="$1"; blob="$3"; max="$4"
if [ -L "$src" ]; then echo symlink; exit 0; fi
if [ ! -e "$src" ]; then echo missing; exit 0; fi
if [ ! -f "$src" ]; then echo not_file; exit 0; fi
size=$(wc -c < "$src" | tr -d ' ')
if [ "$size" -gt "$max" ]; then echo too_large; exit 0; fi
mkdir -p -- "$dir" && cp -p -- "$src" "$dir/$blob" && echo saved`;

/**
 * Called before `fs_write` or `fs_edit` writes `path` (already resolved inside
 * the workspace). Records its state the first time this turn touches it.
 * Never fails the write: a checkpoint that cannot be made means a later
 * restore cannot put this file back, which it then says.
 */
export async function recordBeforeWrite(handle: SandboxHandle, turn: CheckpointTurn, path: string): Promise<void> {
  try {
    const existing = await db
      .select({ id: checkpointFiles.id })
      .from(checkpointFiles)
      .where(
        and(
          eq(checkpointFiles.conversationId, turn.conversationId),
          eq(checkpointFiles.turnMessageId, turn.turnMessageId),
          eq(checkpointFiles.path, path),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;
    const firstOfTurn = await isNewTurn(turn);
    // The row first, so its id names the copy. It says `unknown` until the
    // copy reports back, and stays so if it never does — a failed or thrown
    // exec, or a server that stopped in between. Never `missing` as a
    // placeholder: a restore deletes a `missing` file, and this one may exist.
    const row = await db
      .insert(checkpointFiles)
      // The app's clock, as every message row's is: a rewind compares the two.
      .values({ conversationId: turn.conversationId, turnMessageId: turn.turnMessageId, path, state: "unknown", createdAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: checkpointFiles.id })
      .then((r) => r.at(0));
    // Another call in this turn recorded it first.
    if (!row) return;
    const res = await handle.exec(
      ["bash", "-c", SAVE_SCRIPT, "_", path, turnDir(handle, turn), row.id, String(CHECKPOINT_MAX_FILE_BYTES)],
      { workdir: handle.workdir, timeoutMs: 60_000 },
    );
    const state = res.stdout.trim() as CheckpointState;
    if (res.exitCode !== 0 || !["saved", "missing", "too_large", "symlink", "not_file"].includes(state)) {
      // Kept as `unknown`, so a restore names this file rather than passing
      // over it as if this turn had never touched it.
      console.warn(`could not checkpoint ${path}: ${res.stderr.trim() || `exit ${String(res.exitCode)}`}`);
      return;
    }
    await db.update(checkpointFiles).set({ state }).where(eq(checkpointFiles.id, row.id));
    if (firstOfTurn) await pruneOldTurns(handle, turn.conversationId);
  } catch (err) {
    console.warn(`could not checkpoint ${path}: ${(err as Error).message}`);
  }
}

async function isNewTurn(turn: CheckpointTurn): Promise<boolean> {
  const rows = await db
    .select({ id: checkpointFiles.id })
    .from(checkpointFiles)
    .where(and(eq(checkpointFiles.conversationId, turn.conversationId), eq(checkpointFiles.turnMessageId, turn.turnMessageId)))
    .limit(1);
  return rows.length === 0;
}

/** Keeps the newest `CHECKPOINT_KEEP_TURNS` turns' checkpoints. */
async function pruneOldTurns(handle: SandboxHandle, conversationId: string): Promise<void> {
  const turns = await db
    .select({ turn: checkpointFiles.turnMessageId, first: sql<Date>`min(${checkpointFiles.createdAt})` })
    .from(checkpointFiles)
    .where(eq(checkpointFiles.conversationId, conversationId))
    .groupBy(checkpointFiles.turnMessageId)
    .orderBy(desc(sql`min(${checkpointFiles.createdAt})`));
  const old = turns.slice(CHECKPOINT_KEEP_TURNS).map((t) => t.turn);
  if (old.length > 0) await dropTurns(handle, conversationId, old);
}

/** Forgets turns' checkpoints: their copies and their rows. */
export async function dropTurns(handle: SandboxHandle | null, conversationId: string, turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) return;
  if (handle) {
    const dirs = turnIds.map((t) => turnDir(handle, { conversationId, turnMessageId: t }));
    await handle
      .exec(
        ["bash", "-c", 'for d in "$@"; do case "$d" in "~/"*) d="$HOME/${d#"~/"}";; esac; rm -rf -- "$d"; done', "_", ...dirs],
        { workdir: handle.workdir, timeoutMs: 60_000 },
      )
      .catch((err: unknown) => {
        console.warn(`could not remove checkpoint copies in ${conversationId}: ${(err as Error).message}`);
      });
  }
  await db
    .delete(checkpointFiles)
    .where(and(eq(checkpointFiles.conversationId, conversationId), inArray(checkpointFiles.turnMessageId, turnIds)));
}

/**
 * Removes every copy a conversation's checkpoints made in this workspace, for
 * a conversation being deleted. A server workspace's copies would go with the
 * workspace anyway; a folder on someone's own machine keeps its copies in
 * their home directory, which destroying that workspace never touches — and
 * those copies are what the agent was about to overwrite, the person's own
 * file contents. Throws when the workspace cannot be reached; the caller
 * decides what that costs.
 */
export async function dropConversationCopies(handle: SandboxHandle, conversationId: string): Promise<void> {
  const res = await handle.exec(
    ["bash", "-c", `${EXPAND_DIR}\nrm -rf -- "$dir/$1"`, "_", conversationId, storeRoot(handle)],
    { workdir: handle.workdir, timeoutMs: 60_000 },
  );
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `exit ${String(res.exitCode)}`);
}

/**
 * The checkpoints a rewind to (or a retry of) the message created at
 * `since` would restore: every record made at or after it. Ordered oldest
 * first, so the first record of a path is its state before that point.
 */
export async function checkpointsSince(
  conversationId: string,
  since: Date,
  opts: { inclusive: boolean } = { inclusive: true },
) {
  return db
    .select()
    .from(checkpointFiles)
    .where(
      and(
        eq(checkpointFiles.conversationId, conversationId),
        opts.inclusive ? gte(checkpointFiles.createdAt, since) : gt(checkpointFiles.createdAt, since),
      ),
    )
    .orderBy(asc(checkpointFiles.createdAt));
}

const RESTORE_SCRIPT = `${EXPAND_DIR}
dst="$1"; blob="$3"; state="$4"
if [ -L "$dst" ]; then echo symlink; exit 0; fi
if [ "$state" = missing ]; then
  if [ -d "$dst" ]; then echo is_dir; exit 0; fi
  rm -f -- "$dst" && echo deleted; exit 0
fi
if [ ! -f "$dir/$blob" ]; then echo no_copy; exit 0; fi
if [ -d "$dst" ]; then echo is_dir; exit 0; fi
mkdir -p -- "$(dirname -- "$dst")" && rm -f -- "$dst" && cp -p -- "$dir/$blob" "$dst" && echo restored`;

const SKIP_REASONS: Record<string, string> = {
  too_large: "larger than 10 MiB, so no copy was kept",
  symlink: "a symbolic link, which checkpoints do not follow",
  not_file: "not a regular file",
  is_dir: "a directory is there now",
  no_copy: "its copy is gone",
  unknown: "no copy could be made before the agent changed it",
};

/**
 * Puts every file the given records describe back to its state at the
 * oldest record. Records come from `checkpointsSince`. A failure on one file
 * skips that file; nothing is all-or-nothing, and the report says which.
 */
export async function restoreCheckpoints(
  handle: SandboxHandle,
  conversationId: string,
  records: Awaited<ReturnType<typeof checkpointsSince>>,
  signal?: AbortSignal,
): Promise<RestoreReport> {
  const report: RestoreReport = { restored: [], skipped: [] };
  const seen = new Set<string>();
  for (const rec of records) {
    if (seen.has(rec.path)) continue;
    seen.add(rec.path);
    // Stopped, or out of time: what is left stays as it is, and is named.
    if (signal?.aborted) {
      report.skipped.push({ path: rec.path, reason: "the restore stopped before reaching it" });
      continue;
    }
    if (rec.state === "too_large" || rec.state === "symlink" || rec.state === "not_file" || rec.state === "unknown") {
      report.skipped.push({ path: rec.path, reason: SKIP_REASONS[rec.state] });
      continue;
    }
    let path: string;
    try {
      // Re-checked: stored paths were resolved inside the workspace once, and
      // a restore writes there.
      path = resolvePath(handle, rec.path);
    } catch {
      report.skipped.push({ path: rec.path, reason: "outside the workspace" });
      continue;
    }
    const dir = turnDir(handle, { conversationId, turnMessageId: rec.turnMessageId });
    try {
      const res = await handle.exec(["bash", "-c", RESTORE_SCRIPT, "_", path, dir, rec.id, rec.state], {
        workdir: handle.workdir,
        timeoutMs: 60_000,
        ...(signal ? { signal } : {}),
      });
      const out = res.stdout.trim();
      if (res.exitCode === 0 && (out === "restored" || out === "deleted")) report.restored.push(rec.path);
      else report.skipped.push({ path: rec.path, reason: SKIP_REASONS[out] ?? (res.stderr.trim() || "the copy could not be put back") });
    } catch (err) {
      report.skipped.push({ path: rec.path, reason: (err as Error).message });
    }
  }
  return report;
}

/** Turns with checkpoints at or after `since`, for the rewind dialog. */
export async function hasCheckpointsSince(conversationId: string, since: Date, inclusive = true): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(distinct ${checkpointFiles.path})::int` })
    .from(checkpointFiles)
    .where(
      and(
        eq(checkpointFiles.conversationId, conversationId),
        inclusive ? gte(checkpointFiles.createdAt, since) : gt(checkpointFiles.createdAt, since),
      ),
    );
  return rows.at(0)?.n ?? 0;
}
