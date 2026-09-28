import { v4 as uuid } from "uuid";
import { count, db, eq } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type { AttachmentRef, ContentBlock, InstructionsDecision, McpOverrides, Workspace } from "@loxaic/types";
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
import { assertModelUsable } from "../../inference/providers.ts";
import { recordModelUse } from "../../inference/recent-models.ts";
import { getSandboxMode } from "../../sandbox/provider.ts";
import { describeWorkspace, loadWorkspace } from "../../agent/workspace.ts";
import { combinedText, ensureInstructions, renderRootInstructions, resolveDecision, saveDecision } from "../../agent/instructions.ts";
import { modelRunInfo } from "../../inference/models.ts";

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
    "Investigate using the read-only tools available to you. Do not write, edit, or execute anything — no files",
    "may change in this mode.",
    "Every turn ends by calling exactly one of two tools, never with a prose answer: propose_plan with the",
    "complete plan in Markdown, once you can plan well; or ask_questions, when the user's answers would change the",
    "plan. This holds whatever the request is, even one that is not about code — plan it, or ask what you need to.",
    "The user reviews the plan or answers the questions in a panel, so do not restate either as prose.",
    "If the user asks for changes, submit the whole revised plan again. If they reject a plan, do not implement it:",
    "ask what they would like instead with ask_questions.",
  ].join(" ");
}

/**
 * The run's whole system prompt: the mode's base prompt, then the project's
 * own instructions file when the workspace has one (agent/instructions.ts).
 *
 * Run inside the tool loop, before its first request, rather than in the
 * starter: reading the file can take a GitHub round trip or a call to the
 * user's machine, and `turn.started` must not wait on that. Everything it
 * adds is a function of what is stored — the snapshot and its frozen
 * decision — so every run of a conversation builds the same text.
 */
export async function agentSystemPrompt(input: {
  convId: string;
  ownerId: string;
  workspace: Workspace;
  mode: PermissionMode;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const base = input.mode === "planning" ? planningSystemPrompt(input.workspace) : baseSystemPrompt(input.workspace);
  const snap = await ensureInstructions(input.convId, input.ownerId, input.workspace, input.signal).catch((err: unknown) => {
    console.warn(`project instructions unavailable for ${input.convId}: ${(err as Error).message}`);
    return null;
  });
  if (snap?.status !== "found") return base;
  const windowTokens = (await modelRunInfo(input.model).catch(() => null))?.windowTokens ?? null;
  const resolved = resolveDecision(combinedText(snap.text, snap.imports), snap.decision, input.model, windowTokens);
  let decision: InstructionsDecision | undefined = resolved.decision;
  if (resolved.changed) {
    // The prompt follows what is stored, never a decision the database did
    // not keep: rendered from an unsaved one, the next run would decide
    // again against a window that has moved and change the prompt's front.
    // So a failed save renders the stored decision, or no block this run.
    const saved = await saveDecision(input.convId, snap, resolved.decision).then(
      () => true,
      (err: unknown) => {
        console.warn(`could not store the instructions decision for ${input.convId}: ${(err as Error).message}`);
        return false;
      },
    );
    if (!saved) decision = snap.decision;
  }
  if (!decision) return base;
  try {
    return `${base}\n\n${renderRootInstructions(snap, decision)}`;
  } catch (err) {
    // The file is a stranger's, and a snapshot is permanent: a render that
    // fails must cost this block, never every turn of the conversation.
    console.warn(`could not render project instructions for ${input.convId}: ${(err as Error).message}`);
    return base;
  }
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
  /** MCP choices made before the conversation existed. Written only when this
   * send creates the conversation, so its first request already follows
   * them; an existing conversation's choices change through PATCH. */
  mcpOverrides?: McpOverrides | null;
}): Promise<StartAgentRunResult> {
  const { userId, content, model, mode } = input;
  const broker = getStreamBroker();

  // Before anything is written: a bad ref must fail the whole send, not
  // leave a half-created conversation behind.
  const atts = input.attachments?.length ? await assertAttachmentsOwned(userId, input.attachments) : [];

  // Same rule for the model — see chatRun.ts.
  await assertModelUsable(model);

  let convId = input.conversationId;
  let workspace: Workspace = { kind: "scratch" };
  let ownerId = userId;
  if (convId) {
    // Sending is an editor action — see chatRun.ts.
    await assertConversationAccess(userId, convId, "editor");
    if (input.parentId) await assertParentInConversation(convId, input.parentId);
    const loaded = await loadWorkspace(convId);
    if (loaded) {
      workspace = loaded.workspace;
      ownerId = loaded.ownerId;
    }
    // A conversation the client created up front (to choose a workspace) has
    // the placeholder title until its first message arrives — the implicit
    // path below names it from the message, so this one has to as well.
    await titleIfUnnamed(convId, conversationTitle(content, atts));
  } else {
    // The implicit path: a send with no conversation opens one. Kept for
    // clients that predate the chooser; it is always a scratch workspace.
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerId: userId,
        title: conversationTitle(content, atts),
        kind: "agent",
        mcpOverrides: input.mcpOverrides ?? null,
      })
      .returning();
    convId = conv.id;
  }

  if (getRunByConversation(convId)) {
    throw new Error("A run is already in progress for this conversation");
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

  // See chatRun.ts: recorded once the send is committed to.
  await recordModelUse(userId, model);

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
    lamport: userLamport,
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
    userLamport,
    model,
    mode,
    basePrompt: () => agentSystemPrompt({ convId, ownerId, workspace, mode, model, signal: abort.signal }),
    surface: "agent",
    // The same gate agentSystemPrompt applies to the root file: a scratch
    // workspace has no project, only what the model wrote.
    nestedInstructions: workspace.kind !== "scratch",
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
