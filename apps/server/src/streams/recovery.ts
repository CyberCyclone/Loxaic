import { and, db, eq, lt } from "@loxaic/db";
import { messages } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { getStreamBroker } from "./index.ts";
import type { StreamBroker } from "./broker.ts";
import type { StreamMeta } from "./types.ts";
import { capErrorText, INTERRUPTED_BY_RESTART } from "./error-text.ts";

/** Any Postgres row still `status: "streaming"` this long after boot has no
 * process that could possibly still be writing to it — the registry is
 * empty until routes/WS handlers are registered, which happens after this
 * runs. Kept short since this only ever matches genuinely-abandoned rows. */
const STALE_STREAMING_MINUTES = 10;

/**
 * Called once at boot, after `initStreamBroker()` and before routes/WS
 * handlers are registered — a message left `status: "streaming"` from a
 * server restart mid-generation would otherwise stay stuck with empty
 * content forever. In Redis mode, `listOrphaned()` finds streams that
 * outlived their process and finalizes them with whatever partial content
 * they'd accumulated. In memory mode nothing survives a crash to look at
 * (the log itself is gone), so the Postgres-side sweep below is that mode's
 * entire recovery story: the row can't be un-stuck with real content, but it
 * at least stops looking like it's still generating.
 */
export async function recoverOrphanedStreams(): Promise<void> {
  const broker = getStreamBroker();
  const orphaned = await broker.driver.listOrphaned();

  for (const meta of orphaned) await recoverOrphanedStream(broker, meta);

  const cutoff = new Date(Date.now() - STALE_STREAMING_MINUTES * 60 * 1000);
  await db
    .update(messages)
    .set({ status: "error", error: INTERRUPTED_BY_RESTART })
    .where(and(eq(messages.status, "streaming"), lt(messages.createdAt, cutoff)));
}

/**
 * One orphaned log. Exported so a test can recover a stream it made without
 * also running the Postgres sweep above, which touches every row in a shared
 * database.
 */
export async function recoverOrphanedStream(broker: StreamBroker, meta: StreamMeta): Promise<void> {
  try {
    const records = await broker.readFrom(meta.streamId, 0);
    const snapshot = broker.foldSnapshot(records);
    for (const m of snapshot.messages) {
      if (m.author_type !== "assistant") continue;
      // Only the message that was still generating was cut off. A multi-
      // iteration run's log also holds every iteration that already finished:
      // those rows are `complete` with their tool_call blocks, and rewriting
      // them would drop the calls (orphaning their tool_results) and stamp a
      // restart on a turn that finished. A `cancelled` one was a user stop.
      if (m.status !== "streaming") continue;
      const blocks: ContentBlock[] = [];
      if (m.thinking) blocks.push({ kind: "thinking", text: m.thinking });
      blocks.push({ kind: "text", text: m.text });
      // A reason the stream already recorded wins; otherwise the restart is it.
      const error = capErrorText(m.error) ?? INTERRUPTED_BY_RESTART;
      await db.update(messages).set({ content: blocks, status: "error", error }).where(eq(messages.id, m.message_id));
    }
  } catch {
    // Best-effort — the sweep below is the backstop either way.
  } finally {
    await broker.driver.finalize(meta.streamId, "error");
  }
}
