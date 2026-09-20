import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, routineRuns, routines } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock } from "@loxaic/types";
import {
  assertAttachmentsOwned,
  assertConversationAccess,
  assertParentInConversation,
} from "../authz.ts";
import { turnErrorText } from "../error-text.ts";
import { getStreamBroker } from "../index.ts";
import { getRunByConversation, registerRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";
import { runToolLoop } from "./engine.ts";
import { assertModelUsable } from "../../inference/providers.ts";
import { recordModelUse } from "../../inference/recent-models.ts";
import { getSandboxMode } from "../../sandbox/provider.ts";

/**
 * Chat is fully tool-capable: the same engine, builtins, and MCP tools as the
 * agent surface. What distinguishes it is the prompt (general assistant, not
 * a coding agent working a checked-out repo) and the approval policy — chat
 * always runs with manual-mode semantics (no mode selector): write builtins
 * and non-allowlisted MCP tools ask, read-only builtins run freely.
 */
/** Built at call time (not a module-load const): SANDBOX_MODE shapes what's
 * true to tell the model about where its tools actually run. */
function chatSystemPrompt(): string {
  const workspace = getSandboxMode() === "host"
    ? "a scratch working directory on the host machine"
    : "an isolated Linux sandbox (working directory /home/loxaic/repo — an empty scratch workspace, not a checked-out project)";
  return [
    "You are Loxaic, a helpful AI assistant. Answer directly from your own knowledge when that is all a question needs.",
    `You also have tools: ${workspace} for running commands and working with files, and possibly external tools from the`,
    "user's connected services. Use a tool when it genuinely helps — live or verifiable information, running code,",
    "reading or writing files — and skip tools otherwise. Before calling a tool, state in one short sentence why.",
  ].join(" ");
}

export interface StartChatRunResult {
  streamId: string;
  conversationId: string;
  userMessageId: string;
}

/** How a run ended, as the stream log finalized it. */
export interface RunSettled {
  status: "complete" | "error" | "cancelled";
  error?: string;
}

export async function startChatRun(input: {
  userId: string;
  content: string;
  model: string;
  conversationId?: string;
  parentId?: string;
  /** Attachment refs from POST /v1/files, in display order. */
  attachments?: string[];
  /**
   * False for a send nobody typed — a scheduled routine run. The picker's
   * "recently used" list is a record of what the user chose to run, and a
   * cron firing at 6am is not a choice, exactly as an automatic compaction
   * is not. Defaults to true.
   */
  recordUse?: boolean;
  /**
   * Called exactly once when the run reaches a terminal status, whatever it
   * is. Wired to the stream log's own finalize (`broker.onEnd`) rather than
   * to `runToolLoop`'s promise, so it fires when the turn is actually over
   * and not after the automatic compaction that may follow it.
   *
   * Must not throw: it runs inside an event emitter with nobody to catch it.
   */
  onSettled?: (info: RunSettled) => void;
}): Promise<StartChatRunResult> {
  const { userId, content } = input;
  const broker = getStreamBroker();

  // Before anything is written: a bad ref must fail the whole send, not
  // leave a half-created conversation behind.
  const atts = input.attachments?.length ? await assertAttachmentsOwned(userId, input.attachments) : [];

  let convId = input.conversationId;
  let model = input.model;

  if (convId) {
    // Sending is an editor action: a viewer may watch this conversation
    // stream but must not put words in it.
    const grant = await assertConversationAccess(userId, convId, "editor");
    // A routine's chats run on the routine's model and only that one — a
    // follow-up typed into a run must not quietly move the conversation onto
    // whatever the composer last had selected, and an older client that names
    // a model cannot drift it either. The routine is the one place the model
    // is chosen. A routine with no model (one that predates the column) has
    // nothing to enforce, so a person continuing it by hand keeps their pick.
    if (grant.kind === "routine") {
      model = (await routineModelFor(convId)) ?? model;
    }
    if (input.parentId) {
      await assertParentInConversation(convId, input.parentId);
    }
  }

  // Same rule for the model as for attachments: a reference naming a provider
  // that was deleted, switched off, or never allowed this model cannot be
  // served, and refusing it here is what keeps the allowlist a spending limit
  // rather than a presentation detail in the picker. After the lookups above
  // so it judges the model actually about to be used, and still before the
  // insert below, so a refusal leaves nothing behind.
  await assertModelUsable(model);

  if (!convId) {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: conversationTitle(content, atts) })
      .returning();
    convId = conv.id;
  }

  if (getRunByConversation(convId)) {
    throw new Error("A response is already in progress for this conversation");
  }

  const userMsgId = uuid();
  const userLamport = Date.now();
  await db.insert(messages).values({
    id: userMsgId,
    conversationId: convId,
    parentId: input.parentId ?? null,
    authorType: "user",
    authorUserId: userId,
    origin: "server",
    lamport: userLamport,
    content: [
      ...atts.map((a): ContentBlock => ({
        kind: "attachment",
        ref: a.ref,
        mime: a.mime,
        ...(a.name === undefined ? {} : { name: a.name }),
      })),
      { kind: "text", text: content },
    ] as ContentBlock[],
    status: "complete",
    createdAt: new Date(),
  });

  // After the send is committed to, so a refused turn never reorders the
  // picker; before the run, so the next screen the user opens is already
  // right. It swallows its own failures — the list is a convenience, the turn
  // is not — but it is awaited, so the write cannot land after the request.
  if (input.recordUse !== false) {
    await recordModelUse(userId, model);
  }

  const streamId = uuid();
  const producer = await broker.openProducer({
    streamId,
    conversationId: convId,
    userId,
    surface: "chat",
  });

  producer.emit({
    kind: "message.start",
    message_id: userMsgId,
    author_type: "user",
    parent_id: input.parentId ?? null,
    text: content,
    ...(atts.length ? { attachments: atts } : {}),
  });
  producer.emit({ kind: "message.end", message_id: userMsgId, status: "complete" });

  const abort = new AbortController();
  registerRun({ streamId, conversationId: convId, userId, abort, approvals: new Map() });
  announceNewRun(convId, streamId);

  // Wired before the loop starts, because a run that fails inside its first
  // await would otherwise finalize before anyone was listening.
  const settle = onceSettled(input.onSettled, broker.onEnd.bind(broker), streamId);

  // Detached: the caller gets turn.started immediately, and generation
  // continues independent of whatever socket happened to start it.
  runToolLoop({
    streamId,
    convId,
    userId,
    userMsgId,
    userLamport,
    model,
    mode: "manual",
    basePrompt: chatSystemPrompt(),
    surface: "chat",
    abort,
    producer,
  }).then(
    () => {
      // Every deliberate exit of the loop ends the stream, so this normally
      // finds the run already settled. If it does not, the stream would stay
      // "active" forever — a resync would keep waiting on a run nothing is
      // running — so end it rather than leave it hanging.
      settle({ status: "error", error: "The run ended without a result." });
    },
    async (err: unknown) => {
      // `runToolLoop` rethrows anything that is not a cancellation, and
      // nothing above this point catches it: as a bare `void` it was an
      // unhandled rejection that also left the stream active. Reachable with
      // nobody watching now that a cron can start a run.
      const text = turnErrorText(err, `run failed in ${convId}`);
      console.error(`run ${streamId} failed in ${convId}:`, err);
      // Idempotent — a no-op if the loop already ended the stream itself.
      await producer.end("error", { error: text }).catch(() => undefined);
      settle({ status: "error", error: text });
    },
  );

  return { streamId, conversationId: convId, userMessageId: userMsgId };
}

/**
 * Bridges the stream log's terminal status to the caller's callback, once.
 *
 * `broker.onEnd` is the source of truth — it is what the producer's own
 * `end()` emits, so the status here is exactly the one the log recorded. The
 * promise handlers above are the backstop for the case it never fires.
 */
function onceSettled(
  cb: ((info: RunSettled) => void) | undefined,
  onEnd: (streamId: string, listener: (info: RunSettled) => void) => () => void,
  streamId: string,
): (info: RunSettled) => void {
  if (!cb) return () => undefined;
  let done = false;
  const fire = (info: RunSettled) => {
    if (done) return;
    done = true;
    off();
    try {
      cb(info);
    } catch (err) {
      // The caller's bookkeeping is not allowed to take the run down with it.
      console.error(`run ${streamId} settle handler threw:`, err);
    }
  };
  const off = onEnd(streamId, (info) => {
    fire({ status: info.status, ...(info.error === undefined ? {} : { error: info.error }) });
  });
  return fire;
}

/**
 * The model of the routine whose run created this conversation, or null when
 * the conversation is not a routine's after all (nothing joins) or the routine
 * predates the column.
 *
 * Reached only for a `kind: "routine"` conversation, so an ordinary chat send
 * pays nothing for it.
 */
async function routineModelFor(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ model: routines.model })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routineRuns.conversationId, conversationId))
    .limit(1);
  return rows.length === 0 ? null : rows[0].model;
}

/** Title for a conversation opened by this message. An attachment-only send
 * has no text to name it after, so the first file's own name is used — far
 * more useful in the thread list than a literal "Image", and the only label
 * the user would recognize. */
function conversationTitle(content: string, atts: AttachmentRef[]): string {
  const text = content.slice(0, 80).trim();
  if (text) return text;
  return atts[0]?.name ?? "Attachment";
}
