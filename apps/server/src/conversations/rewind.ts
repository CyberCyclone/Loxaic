/**
 * Removing the end of a conversation: a rewind to one of its messages, or the
 * old reply a retry replaces (#166).
 *
 * `delete.ts` knows what deleting a whole conversation means; this is the
 * only thing that removes part of one, and it follows the same setting. With
 * retention off the removed rows are erased. With "keep for an audit" on they
 * are stamped `deletedAt` — gone for everyone using the conversation and for
 * the model, readable by admins in the transcript — or rewinding would be a
 * way round the audit.
 *
 * What "the end" is: every row created at or after the message rewound to.
 * `createdAt`, not lamport, because a summary written inside a run is placed
 * just *below* the message that run was answering (`cutoffBefore`), yet it was
 * that run's work and goes with it.
 */
import { v4 as uuid } from "uuid";
import { db, and, desc, eq, gt, gte, inArray, isNull, sql } from "@loxaic/db";
import { attachments, conversations, messages, usageRecords } from "@loxaic/db/schema";
import { isNudgeText, type AttachmentRef, type ContentBlock } from "@loxaic/types";
import { getConversationSettings } from "../settings.ts";
import { assertConversationAccess, NotFoundError } from "../streams/authz.ts";
import { getStreamBroker, hasStreamBroker } from "../streams/index.ts";
import { claimConversation, unregisterRun } from "../streams/registry.ts";
import { announceConversationEvent } from "../streams/watchers.ts";

/** A rewind or retry that cannot be done, with the reason the person sees. */
export class RewindError extends Error {
  constructor(
    readonly code: "not_rewindable" | "nothing_to_retry",
    message: string,
  ) {
    super(message);
    this.name = "RewindError";
  }
}

/** The message a run answers, as a starter needs it. */
export interface AnsweredRow {
  id: string;
  lamport: number;
  parentId: string | null;
  text: string;
  attachments: AttachmentRef[];
}

export interface RewindResult {
  /** The rewound message's text, to put back in the composer. */
  text: string;
  /** Its attachments — only for the person who sent it, since only the
   * uploader may send an attachment again. */
  attachments: AttachmentRef[];
  /** True when it had attachments that are not the caller's to send. */
  attachmentsWithheld: boolean;
  removedIds: string[];
}

export interface RewindPreview {
  /** The messages people typed that would go, the rewound one included. */
  turns: number;
  /** How many of those someone else sent. */
  others: number;
  /** Whether admins can still read what is removed (audit retention). */
  retained: boolean;
}

/**
 * Rewinds `conversationId` to `messageId`: that message and everything after
 * it are removed, and its text comes back for the composer. Editors only — the
 * same people who can send — and never while a run is going (the claim is
 * refused with `ConversationBusyError`, which the routes answer with 409).
 */
export async function rewindConversation(input: {
  userId: string;
  conversationId: string;
  messageId: string;
}): Promise<RewindResult> {
  const { userId, conversationId: convId } = input;
  const grant = await assertConversationAccess(userId, convId, "editor");
  if (grant.kind === "subagent") throw new NotFoundError();
  // Held for the whole rewind: a send arriving meanwhile is refused, never
  // written into the suffix being removed. A stream id of its own, which no
  // stream ever has, so nothing can tap or stop it.
  const claim = {
    streamId: `rewind-${uuid()}`,
    conversationId: convId,
    userId,
    abort: new AbortController(),
    approvals: new Map(),
  };
  claimConversation(claim);
  try {
    const target = await rewindTarget(convId, input.messageId);
    const removed = await removeSuffix(convId, target, { inclusive: true, reason: "rewind" });
    const mine = target.authorUserId === userId;
    if (mine && target.attachments.length > 0) await refreshAttachments(target.attachments.map((a) => a.ref));
    return {
      text: target.text,
      attachments: mine ? target.attachments : [],
      attachmentsWithheld: !mine && target.attachments.length > 0,
      removedIds: removed.removedIds,
    };
  } finally {
    unregisterRun(claim.streamId);
  }
}

/** What a rewind to `messageId` would remove, for the confirm dialog. */
export async function previewRewind(input: {
  userId: string;
  conversationId: string;
  messageId: string;
}): Promise<RewindPreview> {
  const { userId, conversationId: convId } = input;
  const grant = await assertConversationAccess(userId, convId, "editor");
  if (grant.kind === "subagent") throw new NotFoundError();
  const target = await rewindTarget(convId, input.messageId);
  const rows = await suffixRows(convId, target.id, true);
  const typed = rows.filter((r) => r.authorType === "user" && !isNudgeText(textOf(r.content as ContentBlock[])));
  return {
    turns: typed.length,
    others: typed.filter((r) => r.authorUserId !== userId).length,
    retained: getConversationSettings().keepDeleted,
  };
}

/**
 * For a retry, whose caller already holds the conversation's claim: removes
 * everything after the newest message someone typed, and returns that
 * message, which stays and is answered again. Only the newest can be retried,
 * so there is nothing to choose.
 */
export async function removeAfterForRetry(convId: string): Promise<AnsweredRow> {
  const rows = await db
    .select({
      id: messages.id,
      lamport: messages.lamport,
      parentId: messages.parentId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, convId), eq(messages.authorType, "user"), isNull(messages.deletedAt)))
    .orderBy(desc(messages.lamport), desc(messages.createdAt))
    .limit(20);
  // The newest user rows may be nudges the last run wrote (a check-in's
  // "answer now", a compaction's "continue"); the message to answer again is
  // the newest one a person typed.
  const row = rows.find((r) => !isNudgeText(textOf(r.content as ContentBlock[])));
  if (!row) throw new RewindError("nothing_to_retry", "There is no message to answer again.");
  await removeSuffix(convId, { id: row.id, createdAt: row.createdAt }, { inclusive: false, reason: "retry" });
  const blocks = row.content as ContentBlock[];
  return { id: row.id, lamport: row.lamport, parentId: row.parentId, text: textOf(blocks), attachments: attachmentsOf(blocks) };
}

interface Target {
  id: string;
  createdAt: Date;
  authorUserId: string | null;
  text: string;
  attachments: AttachmentRef[];
}

/** The message to rewind to, refused unless it is one a person typed here. */
async function rewindTarget(convId: string, messageId: string): Promise<Target> {
  const row = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.conversationId, convId), isNull(messages.deletedAt)),
    columns: { id: true, authorType: true, authorUserId: true, content: true, createdAt: true },
  });
  if (!row) throw new NotFoundError();
  const blocks = row.content as ContentBlock[];
  const text = textOf(blocks);
  if (row.authorType !== "user" || isNudgeText(text)) {
    throw new RewindError("not_rewindable", "Only a message someone typed can be rewound to.");
  }
  return { id: row.id, createdAt: row.createdAt, authorUserId: row.authorUserId, text, attachments: attachmentsOf(blocks) };
}

/** The rows a rewind (inclusive) or retry (exclusive) of `pivotId` removes.
 * Compared in SQL against the stored value: `created_at` has microseconds in
 * Postgres and milliseconds in a JS Date (see history-page.ts). */
function suffixRows(convId: string, pivotId: string, inclusive: boolean) {
  const pivot = sql`(SELECT m2.created_at FROM messages m2 WHERE m2.id = ${pivotId})`;
  return db
    .select({ id: messages.id, authorType: messages.authorType, authorUserId: messages.authorUserId, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, convId),
        isNull(messages.deletedAt),
        inclusive ? gte(messages.createdAt, pivot) : gt(messages.createdAt, pivot),
      ),
    );
}

/**
 * Removes the suffix, its sub-agents, and the stream logs that would otherwise
 * bring it back, then tells every device watching. The caller holds the
 * conversation's claim.
 */
async function removeSuffix(
  convId: string,
  pivot: { id: string; createdAt: Date },
  opts: { inclusive: boolean; reason: "rewind" | "retry" },
): Promise<{ removedIds: string[]; removedStreamIds: string[] }> {
  const rows = await suffixRows(convId, pivot.id, opts.inclusive);
  const removedIds = rows.map((r) => r.id);
  // A removed notice that the project's instructions changed was the only
  // thing telling the model about that change. Forgetting the newest version
  // makes the next run compare against the system prompt's and say so again —
  // possibly repeating part of an older notice, which costs tokens and nothing
  // else. Reconstructing the version before the removed notice is not
  // possible: it is stored nowhere.
  const removedNotice = rows.some((r) => (r.content as ContentBlock[]).some((b) => b.kind === "instructions_update"));
  const keep = getConversationSettings().keepDeleted;

  const children =
    removedIds.length === 0
      ? []
      : await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.parentConversationId, convId), inArray(conversations.parentMessageId, removedIds)));
  const childIds = children.map((c) => c.id);

  if (removedIds.length > 0) {
    await db.transaction(async (tx) => {
      const now = new Date();
      if (keep) {
        await tx.update(messages).set({ deletedAt: now }).where(inArray(messages.id, removedIds));
        // A child is reached only through its parent (`resolveAccess`), and a
        // stamped child is refused — so the stamp hides it as the rows'
        // stamps hide them, and the admin transcript can still read it.
        if (childIds.length > 0) {
          await tx.update(conversations).set({ deletedAt: now }).where(inArray(conversations.id, childIds));
        }
      } else {
        await tx.delete(messages).where(inArray(messages.id, removedIds));
        if (childIds.length > 0) {
          await tx.delete(messages).where(inArray(messages.conversationId, childIds));
          await tx
            .update(usageRecords)
            .set({ conversationId: null, messageId: null })
            .where(inArray(usageRecords.conversationId, childIds));
          await tx.delete(conversations).where(inArray(conversations.id, childIds));
        }
      }
      // Kept and detached, as a whole conversation's are (delete.ts): the
      // tokens were spent, and Stats' lifetime totals are made of them. Left
      // attached, the context ring would go on reading the removed turn as
      // the conversation's size.
      await tx
        .update(usageRecords)
        .set({ conversationId: null, messageId: null })
        .where(inArray(usageRecords.messageId, removedIds));
      const leaf = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, convId), isNull(messages.deletedAt)))
        .orderBy(desc(messages.lamport), desc(messages.createdAt))
        .limit(1)
        .then((r) => r.at(0));
      await tx
        .update(conversations)
        .set({
          activeLeafId: leaf?.id ?? null,
          updatedAt: now,
          ...(removedNotice ? { instructions: sql`${conversations.instructions} - 'latest'` } : {}),
        })
        .where(eq(conversations.id, convId));
    });
  }

  const removedStreamIds = await deleteRemovedStreams(convId, pivot.createdAt, childIds);
  announceConversationEvent({
    type: "conversation.rewound",
    conversation_id: convId,
    from_message_id: pivot.id,
    removed_ids: removedIds,
    removed_stream_ids: removedStreamIds,
    reason: opts.reason,
  });
  return { removedIds, removedStreamIds };
}

/**
 * Deletes the stream logs of the runs that wrote the removed rows: a resync
 * folds the conversation's last runs into snapshots, and a snapshot of a
 * removed run would put its messages back on every device for as long as the
 * log is kept. A run belongs to the suffix when its stream began at or after
 * the pivot message — which also catches compaction and stage runs, which
 * write no rows of their own. Its sub-agents' logs go whole.
 *
 * Best-effort, as for a deleted conversation: not every process has a broker,
 * and the client ignores a removed run's snapshot anyway.
 */
async function deleteRemovedStreams(convId: string, pivotAt: Date, childIds: readonly string[]): Promise<string[]> {
  if (!hasStreamBroker()) return [];
  const broker = getStreamBroker();
  const removed: string[] = [];
  try {
    for (const streamId of await broker.driver.listConvStreams(convId)) {
      const meta = await broker.getMeta(streamId);
      if (!meta || meta.createdAt < pivotAt.getTime()) continue;
      await broker.driver.deleteStream(streamId);
      removed.push(streamId);
    }
    for (const childId of childIds) {
      for (const streamId of await broker.driver.listConvStreams(childId)) await broker.driver.deleteStream(streamId);
    }
  } catch (err) {
    console.warn(`could not delete the stream logs of a rewound part of ${convId}: ${(err as Error).message}`);
  }
  return removed;
}

/**
 * Restarts the attachment sweep's grace for files going back to a composer.
 * The grace counts from upload, and erasing their message leaves them
 * unreferenced: without this an image sent a day ago would be collected
 * before it could be sent again.
 */
async function refreshAttachments(refs: string[]): Promise<void> {
  await db.update(attachments).set({ createdAt: new Date() }).where(inArray(attachments.id, refs));
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

function attachmentsOf(blocks: ContentBlock[]): AttachmentRef[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { kind: "attachment" }> => b.kind === "attachment")
    .map((b) => ({ ref: b.ref, mime: b.mime, ...(b.name === undefined ? {} : { name: b.name }) }));
}
