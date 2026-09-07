import { v4 as uuid } from "uuid";
import { count, db, eq } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock, Workspace } from "@loxaic/types";
import type { PermissionMode } from "@loxaic/agent";
import {
  assertAttachmentsOwned,
  assertConversationAccess,
  assertParentInConversation,
} from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import { getRunByConversation, registerRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";
import { runToolLoop } from "./engine.ts";
import { getSandboxMode } from "../../sandbox/provider.ts";
import { describeWorkspace, loadWorkspace } from "../../agent/workspace.ts";

/**
 * Built at call time from the conversation's immutable workspace and the
 * deployment's sandbox mode — the two things that decide what is true to tell
 * the model about where it is working. Nothing live goes in here: the prompt
 * is the front of every request's prefix, and a prompt that varied between
 * turns would cost a full re-evaluation each time (see agent/workspace.ts).
 *
 * The old text told the model "the repository checked out at /home/loxaic/
 * repo" for every conversation, when there was never anything checked out.
 */
export function baseSystemPrompt(workspace: Workspace): string {
  return [
    `You are Loxaic, a coding agent working ${describeWorkspace(workspace, getSandboxMode())}`,
    "Work in small, verifiable steps: read before you edit, and prefer fs_edit over rewriting a whole file.",
    "Use the tools available to you rather than guessing at file contents. Explain what you are doing as you go,",
    "and finish with a short summary of what changed.",
  ].join(" ");
}

export function planningSystemPrompt(workspace: Workspace): string {
  return [
    `You are Loxaic in PLANNING mode, working ${describeWorkspace(workspace, getSandboxMode())}`,
    "Investigate using the read-only tools available to you and produce a concrete, step-by-step plan.",
    "Do not write, edit, or execute anything — no files may change in this mode. Finish with the plan as prose.",
  ].join(" ");
}

export interface StartAgentRunResult {
  streamId: string;
  conversationId: string;
  userMessageId: string;
}

export async function startAgentRun(input: {
  userId: string;
  content: string;
  model: string;
  mode: PermissionMode;
  conversationId?: string;
  parentId?: string;
  /** Attachment refs from POST /v1/files, in display order. */
  attachments?: string[];
}): Promise<StartAgentRunResult> {
  const { userId, content, model, mode } = input;
  const broker = getStreamBroker();

  // Before anything is written: a bad ref must fail the whole send, not
  // leave a half-created conversation behind.
  const atts = input.attachments?.length ? await assertAttachmentsOwned(userId, input.attachments) : [];

  let convId = input.conversationId;
  let workspace: Workspace = { kind: "scratch" };
  if (convId) {
    // Sending is an editor action — see chatRun.ts.
    await assertConversationAccess(userId, convId, "editor");
    if (input.parentId) await assertParentInConversation(convId, input.parentId);
    const loaded = await loadWorkspace(convId);
    if (loaded) workspace = loaded.workspace;
    // A conversation the client created up front (to choose a workspace) has
    // the placeholder title until its first message arrives — the implicit
    // path below names it from the message, so this one has to as well.
    await titleIfUnnamed(convId, conversationTitle(content, atts));
  } else {
    // The implicit path: a send with no conversation opens one. Kept for
    // clients that predate the chooser; it is always a scratch workspace.
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: conversationTitle(content, atts), kind: "agent" })
      .returning();
    convId = conv.id;
  }

  if (getRunByConversation(convId)) {
    throw new Error("A run is already in progress for this conversation");
  }

  const userMsgId = uuid();
  await db.insert(messages).values({
    id: userMsgId,
    conversationId: convId,
    parentId: input.parentId ?? null,
    authorType: "user",
    authorUserId: userId,
    origin: "server",
    lamport: Date.now(),
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

  const streamId = uuid();
  const producer = await broker.openProducer({
    streamId,
    conversationId: convId,
    userId,
    surface: "agent",
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

  void runToolLoop({
    streamId,
    convId,
    userId,
    userMsgId,
    model,
    mode,
    basePrompt: mode === "planning" ? planningSystemPrompt(workspace) : baseSystemPrompt(workspace),
    surface: "agent",
    abort,
    producer,
  });

  return { streamId, conversationId: convId, userMessageId: userMsgId };
}

/**
 * Names a conversation still carrying the placeholder title, once and only
 * once. The message count is what makes it "once": a user who renames a
 * thread to literally "New conversation" must not have it overwritten by the
 * next send.
 */
async function titleIfUnnamed(convId: string, title: string): Promise<void> {
  const row = await db.query.conversations.findFirst({
    where: eq(conversations.id, convId),
    columns: { title: true },
  });
  if (row?.title !== "New conversation") return;
  const [existing] = await db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.conversationId, convId));
  if (existing.n > 0) return;
  await db.update(conversations).set({ title, updatedAt: new Date() }).where(eq(conversations.id, convId));
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
