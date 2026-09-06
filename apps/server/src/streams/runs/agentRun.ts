import { v4 as uuid } from "uuid";
import { db } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock } from "@loxaic/types";
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

/** Built at call time (not a module-load const): SANDBOX_MODE shapes what's
 * true to tell the model about where it's actually running. */
function baseSystemPrompt(): string {
  const location = getSandboxMode() === "host"
    ? "directly on the host machine, in a scratch working directory created for this conversation"
    : "inside an isolated Linux sandbox container, with the repository checked out at /home/loxaic/repo (your working directory; relative paths resolve there)";
  return [
    `You are Loxaic, a coding agent working ${location}.`,
    "Work in small, verifiable steps: read before you edit, and prefer fs_edit over rewriting a whole file.",
    "Use the tools available to you rather than guessing at file contents. Explain what you are doing as you go,",
    "and finish with a short summary of what changed.",
  ].join(" ");
}

function planningSystemPrompt(): string {
  const location = getSandboxMode() === "host" ? "on the host machine" : "at /home/loxaic/repo";
  return [
    `You are Loxaic in PLANNING mode. Investigate the repository ${location} using the read-only tools`,
    "available to you and produce a concrete, step-by-step plan. Do not write, edit, or execute anything —",
    "no files may change in this mode. Finish with the plan as prose.",
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
  if (convId) {
    // Sending is an editor action — see chatRun.ts.
    await assertConversationAccess(userId, convId, "editor");
    if (input.parentId) await assertParentInConversation(convId, input.parentId);
  } else {
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
    basePrompt: mode === "planning" ? planningSystemPrompt() : baseSystemPrompt(),
    surface: "agent",
    abort,
    producer,
  });

  return { streamId, conversationId: convId, userMessageId: userMsgId };
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
