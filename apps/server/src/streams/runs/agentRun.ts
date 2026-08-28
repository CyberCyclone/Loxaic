import { v4 as uuid } from "uuid";
import { db } from "@shannon/db";
import { conversations, messages } from "@shannon/db/schema";
import type { ContentBlock } from "@shannon/types";
import type { PermissionMode } from "@shannon/agent";
import { assertConversationAccess, assertParentInConversation } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import { getRunByConversation, registerRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";
import { runToolLoop } from "./engine.ts";

const BASE_SYSTEM_PROMPT = [
  "You are Shannon, a coding agent working inside an isolated Linux sandbox.",
  "The repository is checked out at /home/shannon/repo, which is your working directory; relative paths resolve there.",
  "Work in small, verifiable steps: read before you edit, and prefer fs_edit over rewriting a whole file.",
  "Use the tools available to you rather than guessing at file contents. Explain what you are doing as you go,",
  "and finish with a short summary of what changed.",
].join(" ");

const PLANNING_SYSTEM_PROMPT = [
  "You are Shannon in PLANNING mode. Investigate the repository at /home/shannon/repo using the read-only tools",
  "available to you and produce a concrete, step-by-step plan. Do not write, edit, or execute anything —",
  "no files may change in this mode. Finish with the plan as prose.",
].join(" ");

export interface StartAgentRunResult {
  streamId: string;
  conversationId: string;
  userMessageId: string;
  incognito: boolean;
}

export async function startAgentRun(input: {
  userId: string;
  content: string;
  model: string;
  mode: PermissionMode;
  conversationId?: string;
  parentId?: string;
  incognito?: boolean;
}): Promise<StartAgentRunResult> {
  if (input.incognito) {
    // Fast-follow: incognito chat is supported end-to-end; incognito agent
    // runs need the sandbox lifecycle to skip Postgres too, which is a
    // bigger bite (see plan). Reject explicitly rather than silently
    // dropping the user's stated intent.
    throw new Error("Incognito isn't supported for agent runs yet");
  }

  const { userId, content, model, mode } = input;
  const broker = getStreamBroker();

  let convId = input.conversationId;
  if (convId) {
    const access = await assertConversationAccess(userId, convId);
    if (access.incognito) throw new Error("Incognito isn't supported for agent runs yet");
    if (input.parentId) await assertParentInConversation(convId, input.parentId);
  } else {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: content.slice(0, 80), kind: "agent" })
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
    content: [{ kind: "text", text: content }] as ContentBlock[],
    status: "complete",
    createdAt: new Date(),
  });

  const streamId = uuid();
  const producer = await broker.openProducer({
    streamId,
    conversationId: convId,
    userId,
    surface: "agent",
    incognito: false,
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

  void runToolLoop({
    streamId,
    convId,
    userId,
    userMsgId,
    model,
    mode,
    basePrompt: mode === "planning" ? PLANNING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT,
    incognito: false,
    abort,
    producer,
  });

  return { streamId, conversationId: convId, userMessageId: userMsgId, incognito: false };
}
