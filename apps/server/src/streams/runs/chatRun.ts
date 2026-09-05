import { v4 as uuid } from "uuid";
import { db } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock } from "@loxaic/types";
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

export async function startChatRun(input: {
  userId: string;
  content: string;
  model: string;
  conversationId?: string;
  parentId?: string;
  /** Attachment refs from POST /v1/files, in display order. */
  attachments?: string[];
}): Promise<StartChatRunResult> {
  const { userId, content, model } = input;
  const broker = getStreamBroker();

  // Before anything is written: a bad ref must fail the whole send, not
  // leave a half-created conversation behind.
  const atts = input.attachments?.length ? await assertAttachmentsOwned(userId, input.attachments) : [];

  let convId = input.conversationId;

  if (convId) {
    // Sending is an editor action: a viewer may watch this conversation
    // stream but must not put words in it.
    await assertConversationAccess(userId, convId, "editor");
    if (input.parentId) {
      await assertParentInConversation(convId, input.parentId);
    }
  } else {
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

  // Detached: the caller gets turn.started immediately, and generation
  // continues independent of whatever socket happened to start it.
  void runToolLoop({
    streamId,
    convId,
    userId,
    userMsgId,
    model,
    mode: "manual",
    basePrompt: chatSystemPrompt(),
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
