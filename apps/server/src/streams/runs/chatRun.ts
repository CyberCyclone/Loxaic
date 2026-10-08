import { v4 as uuid } from "uuid";
import { db, eq } from "@loxaic/db";
import { conversations, messages, routineRuns, routines } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock, McpOverrides, ThinkingLevel } from "@loxaic/types";
import {
  assertAttachmentsOwned,
  assertConversationAccess,
  assertParentInConversation,
  NotFoundError,
} from "../authz.ts";
import { claimConversation, unregisterRun, type RunHandle } from "../registry.ts";
import { hasNoMessages } from "./stageRun.ts";
import { startRunOnRow, type RunSettled, type StartedRun } from "./start-run.ts";
import { removeAfterForRetry } from "../../conversations/rewind.ts";
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
export function chatWorkspaceDescription(): string {
  return getSandboxMode() === "host"
    ? "a scratch working directory on the host machine"
    : "an isolated Linux sandbox (working directory /home/loxaic/repo — an empty scratch workspace, not a checked-out project)";
}

function chatSystemPrompt(): string {
  const workspace = chatWorkspaceDescription();
  return [
    "You are Loxaic, a helpful AI assistant. Answer directly from your own knowledge when that is all a question needs.",
    `You also have tools: ${workspace} for running commands and working with files, and possibly external tools from the`,
    "user's connected services. Use a tool when it genuinely helps — live or verifiable information, running code,",
    "reading or writing files — and skip tools otherwise. Before calling a tool, state in one short sentence why.",
  ].join(" ");
}

export type StartChatRunResult = StartedRun;
export type { RunSettled };

export async function startChatRun(input: {
  userId: string;
  content: string;
  model: string;
  conversationId?: string;
  parentId?: string;
  /** Attachment refs from POST /v1/files, in display order. */
  attachments?: string[];
  /** MCP choices made before the conversation existed. Written only when this
   * send creates the conversation, so its first request already follows
   * them; an existing conversation's choices change through PATCH. */
  mcpOverrides?: McpOverrides | null;
  /** The context stage chosen in Context settings before the conversation
   * existed. Read only when this send opens the conversation. */
  contextStage?: number;
  /** How hard to think (inference/thinking.ts). Absent means
   * `DEFAULT_THINKING_LEVEL` — what a routine, which has no picker, gets. */
  thinkingLevel?: ThinkingLevel;
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

  // Before anything is written: a bad ref must fail the whole send, not
  // leave a half-created conversation behind.
  const atts = input.attachments?.length ? await assertAttachmentsOwned(userId, input.attachments) : [];

  let convId = input.conversationId;
  let model = input.model;
  // Whether this is a routine's conversation. A routine's runs may use
  // sub-agents; a plain chat's may not — chat is a conversation, and the
  // sub-agent tool's schema would cost every chat turn its tokens for
  // something a chat rarely needs.
  let routine = false;

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
      routine = true;
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
      .values({ ownerId: userId, title: conversationTitle(content, atts), mcpOverrides: input.mcpOverrides ?? null })
      .returning();
    convId = conv.id;
  }

  // Claimed before anything below is written, so a rewind or a second send
  // arriving meanwhile is refused rather than interleaved (claimConversation).
  const claim: RunHandle = {
    streamId: uuid(),
    conversationId: convId,
    userId,
    abort: new AbortController(),
    approvals: new Map(),
    model,
  };
  claimConversation(claim);
  try {
    // Before the user message lands: this send opens the conversation (a new
    // chat, or a routine's fresh run), so its model starts at the stage it
    // chose or at standard — see stageRun.ts.
    const opening = await hasNoMessages(convId);

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
    // right. It swallows its own failures — the list is a convenience, the
    // turn is not — but it is awaited, so the write cannot land after the
    // request.
    if (input.recordUse !== false) {
      await recordModelUse(userId, model);
    }

    return await startRunOnRow({
      claim,
      surface: "chat",
      row: { id: userMsgId, lamport: userLamport, parentId: input.parentId ?? null, text: content, attachments: atts },
      loop: () => ({
        model,
        mode: "manual",
        basePrompt: chatSystemPrompt(),
        newConversation: opening ? { chosenStage: input.contextStage } : undefined,
        thinkingLevel: input.thinkingLevel,
        ...(routine ? { subagents: { routine: true } } : {}),
      }),
      onSettled: input.onSettled,
    });
  } catch (err) {
    // Anything thrown here is from before the loop started (startRunOnRow
    // returns as soon as it has), so the slot is still the starter's to give
    // back. A no-op when startRunOnRow already did.
    unregisterRun(claim.streamId);
    throw err;
  }
}

/**
 * Answers a chat conversation's newest message again (`chat.retry`): the
 * reply and anything after it are removed, and a new run starts on the same
 * stored message. On `model` — the composer's current choice — except in a
 * routine's conversation, which only ever runs on its routine's model.
 */
export async function retryChatRun(input: {
  userId: string;
  conversationId: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}): Promise<StartChatRunResult> {
  const { userId, conversationId: convId } = input;
  const grant = await assertConversationAccess(userId, convId, "editor");
  if (grant.kind !== "chat" && grant.kind !== "routine") throw new NotFoundError();
  const routine = grant.kind === "routine";
  const model = routine ? ((await routineModelFor(convId)) ?? input.model) : input.model;
  await assertModelUsable(model);

  const claim: RunHandle = {
    streamId: uuid(),
    conversationId: convId,
    userId,
    abort: new AbortController(),
    approvals: new Map(),
    model,
  };
  claimConversation(claim);
  try {
    const row = await removeAfterForRetry(convId);
    await recordModelUse(userId, model);
    return await startRunOnRow({
      claim,
      surface: "chat",
      row,
      loop: () => ({
        model,
        mode: "manual",
        basePrompt: chatSystemPrompt(),
        thinkingLevel: input.thinkingLevel,
        ...(routine ? { subagents: { routine: true } } : {}),
      }),
    });
  } catch (err) {
    unregisterRun(claim.streamId);
    throw err;
  }
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
