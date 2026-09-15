import { and, db, eq, lt } from "@loxaic/db";
import { messages } from "@loxaic/db/schema";
import type { ContentBlock } from "@loxaic/types";
import { getStreamBroker } from "./index.ts";
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

  for (const meta of orphaned) {
    try {
      const records = await broker.readFrom(meta.streamId, 0);
      const snapshot = broker.foldSnapshot(records);
      for (const m of snapshot.messages) {
        if (m.author_type !== "assistant") continue;
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

  const cutoff = new Date(Date.now() - STALE_STREAMING_MINUTES * 60 * 1000);
  await db
    .update(messages)
    .set({ status: "error", error: INTERRUPTED_BY_RESTART })
    .where(and(eq(messages.status, "streaming"), lt(messages.createdAt, cutoff)));
}
