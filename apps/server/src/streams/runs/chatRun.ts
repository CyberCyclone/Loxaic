import { v4 as uuid } from "uuid";
import { db } from "@shannon/db";
import { conversations, messages } from "@shannon/db/schema";
import type { ContentBlock } from "@shannon/types";
import { assertConversationAccess, assertParentInConversation } from "../authz.ts";
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
    : "an isolated Linux sandbox (working directory /home/shannon/repo — an empty scratch workspace, not a checked-out project)";
  return [
    "You are Shannon, a helpful AI assistant. Answer directly from your own knowledge when that is all a question needs.",
    `You also have tools: ${workspace} for running commands and working with files, and possibly external tools from the`,
    "user's connected services. Use a tool when it genuinely helps — live or verifiable information, running code,",
    "reading or writing files — and skip tools otherwise. Before calling a tool, state in one short sentence why.",
  ].join(" ");
}

export interface StartChatRunResult {
  streamId: string;
  conversationId: string;
  userMessageId: string;
  incognito: boolean;
}

export async function startChatRun(input: {
  userId: string;
  content: string;
  model: string;
  conversationId?: string;
  parentId?: string;
  incognito?: boolean;
}): Promise<StartChatRunResult> {
  const { userId, content, model } = input;
  const broker = getStreamBroker();

  let convId = input.conversationId;
  let incognito = false;

  if (convId) {
    const access = await assertConversationAccess(userId, convId);
    incognito = access.incognito;
    if (input.parentId && !incognito) {
      await assertParentInConversation(convId, input.parentId);
    }
  } else if (input.incognito) {
    convId = uuid();
    await broker.driver.putEphemeralConv({
      id: convId,
      ownerId: userId,
      title: content.slice(0, 80),
      kind: "chat",
      createdAt: Date.now(),
    });
    incognito = true;
  } else {
    const [conv] = await db.insert(conversations).values({ ownerId: userId, title: content.slice(0, 80) }).returning();
    convId = conv.id;
  }

  if (getRunByConversation(convId)) {
    throw new Error("A response is already in progress for this conversation");
  }

  const userMsgId = uuid();
  if (!incognito) {
    await db.insert(messages).values({
      id: userMsgId,
      conversationId: convId,
      parentId: input.parentId ?? null,
      authorType: "user",
      authorUserId: userId,
      origin: "server",
      lamport: Date.now(),
      content: [{ kind: "text", text: content }] as ContentBlock[],
      status: "complete",
      createdAt: new Date(),
    });
  } else {
    await broker.driver.touchEphemeralConv(convId);
  }

  const streamId = uuid();
  const producer = await broker.openProducer({
    streamId,
    conversationId: convId,
    userId,
    surface: "chat",
    incognito,
  });

  producer.emit({
    kind: "message.start",
    message_id: userMsgId,
    author_type: "user",
    parent_id: input.parentId ?? null,
    text: content,
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
    incognito,
    abort,
    producer,
  });

  return { streamId, conversationId: convId, userMessageId: userMsgId, incognito };
}
