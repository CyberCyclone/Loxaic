/**
 * What deleting a conversation actually does.
 *
 * Two outcomes, decided by one deployment-wide setting (`settings.ts`'s
 * conversation group), and the client is told which before it asks:
 *
 * - **Retention off** (the default): the conversation is *erased*. Its row,
 *   its messages, its shares and its sandbox go; its uploads follow when the
 *   attachment sweep next runs; its usage rows survive with nothing left
 *   pointing at the conversation.
 * - **Retention on**: the row is marked `deletedAt` and becomes invisible to
 *   every ordinary path (`resolveAccess` refuses a deleted row, so the owner,
 *   its share-holders and every socket see what they would see if it were
 *   gone), readable only through the admin audit routes until
 *   `conversations/reaper.ts` erases it.
 *
 * The ordering below is the load-bearing part, and it is not the obvious one.
 */
import { db, and, eq } from "@loxaic/db";
import { conversations, messages, sandboxes, usageRecords } from "@loxaic/db/schema";
import { destroyConversationSandboxes } from "../agent/sandbox-manager.ts";
import { getConversationSettings } from "../settings.ts";
import { getRunByConversation, waitForRunEnd } from "../streams/registry.ts";
import { getStreamBroker, hasStreamBroker } from "../streams/index.ts";

/** Just enough of a logger to not depend on fastify's type here. */
export interface DeleteLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * How long to wait for an aborted run to unwind before doing the cleanup
 * anyway. Generous: a run is usually gone in milliseconds once its inference
 * request is aborted, but one parked mid-`bash` only notices between calls.
 * Nothing is lost by giving up early — the second purge pass runs regardless.
 */
const RUN_UNWIND_TIMEOUT_MS = 30_000;

export type DeleteOutcome = "erased" | "retained";

/**
 * Deletes a conversation on behalf of its owner, honouring the retention
 * policy. Returns which of the two happened, so the caller can log it.
 *
 * Callers authorize first — this function is the *how*, never the *whether*.
 */
export async function deleteConversation(id: string, log: DeleteLogger): Promise<DeleteOutcome> {
  if (!getConversationSettings().keepDeleted) {
    await purgeConversation(id, log);
    return "erased";
  }

  await db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, id));
  // The run stops on this path too. `resolveAccess` refuses a deleted row, so
  // nothing *new* can start — but a run already in flight holds its own
  // references and keeps generating into a conversation the user has been told
  // is gone, and the cleanup below is about to destroy the sandbox its tool
  // calls are using. Leaving it running would make "deleted" mean two
  // different things depending on a setting the user cannot see.
  getRunByConversation(id)?.abort.abort();
  // A retained conversation is still one the user is finished with, and its
  // sandbox is not retained by anything: nothing can reach the conversation to
  // resume it, and the admin audit view reads rows, not containers. So the
  // live resources go either way — only the record is kept.
  detachedCleanup(id, log);
  return "retained";
}

/**
 * Erases a conversation and everything that describes it. The one place that
 * knows what "fully deleted" means here.
 *
 * Idempotent, because it is called from three places that can race each other
 * (the owner's delete, an admin's "Delete now", the sweep) and because it runs
 * its own second pass below.
 */
export async function purgeConversation(id: string, log: DeleteLogger): Promise<void> {
  // The row goes *first*, and in the same transaction as the messages.
  //
  // Every authorization path in the server ends at `resolveAccess`, which
  // answers null for a row that is not there — so the instant this commits,
  // nothing new can start a run, send a message, or read the thread. Deleting
  // the messages first and the row second would leave a window in which the
  // conversation still exists and is empty, which a live socket can write into.
  await eraseRows(id);

  // Only now stop the run. Anything it writes from here on is an orphan by
  // construction (its conversation is gone), which is what the second pass
  // below collects; doing this first would just widen the window above.
  getRunByConversation(id)?.abort.abort();

  detachedCleanup(id, log, { purge: true });
}

/**
 * The part of a delete the user does not wait on.
 *
 * Reclaiming a container and re-running a DELETE are not things a click should
 * block on, or fail on — the record is already gone as far as every reader is
 * concerned. Deliberately fire-and-forget, with its own catch, exactly like
 * the sandbox destruction it replaces.
 */
function detachedCleanup(id: string, log: DeleteLogger, opts?: { purge?: boolean }): void {
  void (async () => {
    // Wait for the aborted run to actually finish before cleaning up: it is
    // still writing message rows, and its tool calls still hold the sandbox we
    // are about to destroy.
    const ended = await waitForRunEnd(id, RUN_UNWIND_TIMEOUT_MS);
    if (!ended) {
      log.warn(
        { conversationId: id },
        "a run was still active when its conversation was deleted — cleaning up anyway",
      );
    }

    if (opts?.purge) {
      // The second pass, and the reason the wait above is an optimisation
      // rather than a correctness requirement. Two kinds of row can appear
      // after the transaction committed: the ones an unwinding run wrote (its
      // cancelled assistant message, a stopped tool result), and the ones a
      // send that had already passed authorization was about to write. Both
      // reference a conversation that no longer exists, so nothing but this
      // will ever collect them.
      await eraseRows(id).catch((err: unknown) => {
        log.warn({ err, conversationId: id }, "failed to re-erase rows after a deleted conversation's run ended");
      });
    }

    // The stream log holds the transcript too — every text delta of every run,
    // for up to STREAM_TTL_SECONDS. Erasing the messages and leaving these
    // would keep the conversation's content readable by a resync for another
    // day. Best-effort: the broker is not initialized in every process that
    // can reach this code (route tests mount routes without a broker), and a
    // TTL will collect them regardless.
    await deleteStreamLogs(id).catch((err: unknown) => {
      log.warn({ err, conversationId: id }, "failed to delete stream logs for a deleted conversation");
    });

    // A sandbox now persists across idle periods rather than being cleaned up
    // by a short timer, so without this a deleted conversation leaves a
    // container holding its files running on the host with nothing left that
    // could ever reach it — the user cannot open the conversation, and the
    // abandoned reaper would take weeks.
    await destroyConversationSandboxes(id).catch((err: unknown) => {
      log.warn({ err, conversationId: id }, "failed to destroy sandboxes for a deleted conversation");
    });

    if (opts?.purge) {
      await deleteDestroyedSandboxRows(id).catch((err: unknown) => {
        log.warn({ err, conversationId: id }, "failed to delete sandbox rows for a deleted conversation");
      });
    }
  })();
}

/**
 * The transaction: messages gone, usage detached, conversation gone.
 *
 * `conversation_shares` is the only table with a foreign key to
 * `conversations`, so it cascades; nothing else does, which is exactly why
 * this function exists rather than a bare DELETE.
 */
async function eraseRows(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(messages).where(eq(messages.conversationId, id));
    // Usage rows are counts and timings — tokens, milliseconds, a model name —
    // with no content and no title. They are kept, because they are what the
    // Stats screen's lifetime totals are made of and deleting a conversation
    // is not a claim that the tokens were never spent. They are *detached*,
    // because a row still naming a conversation that no longer exists would
    // keep it in "recent conversations" as an id nothing can resolve.
    await tx
      .update(usageRecords)
      .set({ conversationId: null, messageId: null })
      .where(eq(usageRecords.conversationId, id));
    await tx.delete(conversations).where(eq(conversations.id, id));
  });
}

/**
 * Drops the conversation's sandbox rows, but only the ones whose container is
 * confirmed gone.
 *
 * A row whose destroy failed must stay: it is the only record that a container
 * exists, and the abandoned reaper is what eventually reclaims it. Deleting it
 * here would strand that container for good.
 */
async function deleteDestroyedSandboxRows(id: string): Promise<void> {
  await db
    .delete(sandboxes)
    .where(and(eq(sandboxes.conversationId, id), eq(sandboxes.status, "destroyed")));
}

async function deleteStreamLogs(id: string): Promise<void> {
  if (!hasStreamBroker()) return;
  const broker = getStreamBroker();
  const streamIds = await broker.driver.listConvStreams(id);
  for (const streamId of streamIds) await broker.driver.deleteStream(streamId);
}

/**
 * Restores a retained conversation to its owner.
 *
 * Its shares come back with it (they were never deleted — nothing cascaded,
 * because the row survived). Its sandbox does not: that was destroyed when the
 * conversation was deleted, and a workspace cannot be un-destroyed. An agent
 * conversation restored this way starts a fresh sandbox on its next tool call,
 * from the workspace it was created with.
 */
export async function restoreConversation(id: string): Promise<void> {
  await db
    .update(conversations)
    .set({ deletedAt: null, deletedHold: false })
    .where(eq(conversations.id, id));
}

/** Erases a batch of conversations, one at a time so a single failure does not
 * abandon the rest. Used by the sweep. */
export async function purgeConversations(ids: string[], log: DeleteLogger): Promise<number> {
  let purged = 0;
  for (const id of ids) {
    try {
      await purgeConversation(id, log);
      purged++;
    } catch (err) {
      log.warn({ err, conversationId: id }, "failed to erase a retained conversation past its window");
    }
  }
  return purged;
}
