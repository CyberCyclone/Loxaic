import { v4 as uuid } from "uuid";
import { and, db, desc, eq, sql } from "@loxaic/db";
import { conversations, messages } from "@loxaic/db/schema";
import type {
  ContentBlock,
  ProjectInstructions,
  StreamEventKind,
  SubAgentInfo,
  SubAgentLive,
  SubAgentProgress,
  SubAgentStatus,
  ThinkingLevel,
  Workspace,
} from "@loxaic/types";
import { SUBAGENT_LOST_ERROR } from "@loxaic/types";
import type { PermissionMode } from "@loxaic/agent";
import { stripControl } from "../../mcp/sanitize.ts";
import { combinedText, renderRootInstructions, resolveDecision } from "../../agent/instructions.ts";
import { describeWorkspace, effectiveWorkspace } from "../../agent/workspace.ts";
import { modelRunInfo } from "../../inference/models.ts";
import { forgetPromptTrace } from "../../inference/prompt-reuse.ts";
import { assertModelUsable } from "../../inference/providers.ts";
import { getSandboxMode } from "../../sandbox/provider.ts";
import type { StreamProducer } from "../broker.ts";
import { turnErrorText } from "../error-text.ts";
import { getStreamBroker } from "../index.ts";
import { registerRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";
import { chatWorkspaceDescription } from "./chatRun.ts";
import { runToolLoop } from "./engine.ts";
import { subagentResultText } from "./subagent-policy.ts";

/**
 * Sub-agents: one run handing a self-contained task to a child run.
 *
 * A child is a whole agent run of its own — its own conversation row, its own
 * stream, its own inference slot — started from inside its parent's tool loop
 * and awaited there. It is its own conversation rather than more rows in the
 * parent's because everything that makes a run correct is keyed by
 * conversation: `loadHistory` would replay the child's messages into the
 * parent's next prompt, the prompt-reuse trace and the request shape would be
 * overwritten by the child's requests, and registering the child under the
 * parent's id would hand it the parent's run lock (and release it, with the
 * parent still running, when the child finished).
 *
 * What a child shares with its parent is deliberate and narrow: the
 * **workspace** (its tools run in the parent's sandbox, so it sees and changes
 * the same files), the **permission mode** (a planning parent gets read-only
 * children; a manual one's children ask before they write), the **sender**
 * (its allowlist, MCP servers and wait settings are the person's who sent the
 * parent's message), and the **stop** (aborting the parent aborts it).
 *
 * What it reports is its final reply, once. Everything else it did stays in
 * its own conversation, which a person can open from its card.
 */

/** What the parent's tool loop knows when it spawns a child. */
export interface SubagentParent {
  convId: string;
  streamId: string;
  /** The parent run's sender — not the conversation's owner. */
  userId: string;
  mode: PermissionMode;
  surface: "chat" | "agent";
  /** The assistant message whose tool call this is. */
  assistantMsgId: string;
  producer: StreamProducer;
  signal: AbortSignal;
  thinkingLevel?: ThinkingLevel;
}

export interface SubagentCall {
  callId: string;
  description: string;
  prompt: string;
  /** Already decided by `subagentModelFor`. */
  model: string;
}

export interface SubagentOutcome {
  /** The tool result the parent's model reads, and that is persisted. */
  output: string;
  ok: boolean;
}

/** Read through a call: the type checker narrows `signal.aborted` to false
 * after the first check and cannot see that the awaits in between change it. */
function hasFired(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** The longest a description is kept. It is a label on a card, not prose. */
const MAX_DESCRIPTION_CHARS = 80;

/**
 * Reads a `subagent` call's arguments. They are a model's, so every one is a
 * claim: a missing prompt is an error the model reads and can correct, never a
 * child started on nothing.
 */
export function parseSubagentArgs(
  args: Record<string, unknown>,
): { description: string; prompt: string; model: unknown } | { error: string } {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return { error: "A sub-agent needs a `prompt`: the complete task, with everything it needs to know." };
  const raw = typeof args.description === "string" ? stripControl(args.description).replace(/\s+/g, " ").trim() : "";
  // A missing label is not worth refusing the call over; the task itself is
  // what matters, and its first words name it well enough.
  const label = raw || prompt.replace(/\s+/g, " ");
  const description = label.length > MAX_DESCRIPTION_CHARS ? `${label.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : label;
  return { description, prompt, model: args.model };
}

/**
 * The child's system prompt.
 *
 * Its own, not the parent's. The agent's planning prompt in particular demands
 * every turn end in `propose_plan` or `ask_questions` — tools a child is not
 * given, because it has no user to hand either to.
 *
 * Built once per child and never again (a child is one run), from things that
 * do not change while it runs: the parent's immutable workspace, the mode, and
 * the instructions snapshot the parent already holds.
 */
export function subagentSystemPrompt(input: {
  surface: "chat" | "agent";
  workspace: Workspace;
  mode: PermissionMode;
  /** The project's instructions block, already rendered, or null. */
  instructions: string | null;
}): string {
  const where =
    input.surface === "agent"
      ? `working ${describeWorkspace(input.workspace, getSandboxMode())}`
      : `working in ${chatWorkspaceDescription()}.`;
  const how =
    input.mode === "planning"
      ? "This run is read-only: investigate with the read-only tools you have. Do not write, edit or execute anything."
      : "Work in small, verifiable steps: read before you edit, and prefer fs_edit over rewriting a whole file.";
  const base = [
    `You are a Loxaic sub-agent, ${where}`,
    "Another agent has handed you one task, in the message below. You share its workspace: files it or other",
    "sub-agents have changed are there, and what you change they will see.",
    how,
    "Do exactly the task you were given and nothing beyond it. Nobody is watching this run and you cannot ask",
    "anyone a question: where something is unclear, make a reasonable assumption and say what you assumed.",
    "Your final message is the only thing the agent that started you will read — not your tool calls, not your",
    "earlier messages. End with a complete, self-contained report: what you found or changed, with file paths,",
    "and anything it needs to know to carry on.",
  ].join(" ");
  return input.instructions ? `${base}\n\n${input.instructions}` : base;
}

/**
 * The project's instructions for a child, from the snapshot its parent stored.
 *
 * Read from the parent's row, never looked up afresh: the lookup can cost a
 * GitHub round trip or a call to someone's machine, and the answer would be
 * the same file. Whole-or-outline is decided for the child's own model and
 * not stored — the stored decision is the parent's, frozen so *its* prompt
 * holds still across runs, and a child has no later run to hold still for.
 */
async function instructionsFor(snapshot: unknown, model: string, parentConvId: string): Promise<string | null> {
  const snap = snapshot as ProjectInstructions | null;
  if (snap?.status !== "found") return null;
  try {
    const windowTokens = (await modelRunInfo(model).catch(() => null))?.windowTokens ?? null;
    const { decision } = resolveDecision(combinedText(snap.text, snap.imports), snap.decision, model, windowTokens);
    return renderRootInstructions(snap, decision);
  } catch (err) {
    // A stranger's file, as in agentSystemPrompt: a render that fails costs
    // this block, never the child.
    console.warn(`could not render project instructions for a sub-agent of ${parentConvId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Runs one sub-agent to its end and returns what the parent is told.
 *
 * Never rejects: every failure — the model cannot be served, a row cannot be
 * written, the child's loop throws — is an `ok: false` result the parent's
 * model reads. A rejection here would escape the parent's per-call handling
 * and fail a turn whose other calls may have run and written.
 *
 * Called from inside the parent's `slot.yieldWhile`, so everything it emits on
 * the parent's stream is out before the parent re-enters the queue.
 */
export async function runSubagent(
  parent: SubagentParent,
  call: SubagentCall,
  hooks?: {
    /**
     * Called once, when the child has its place: it holds an inference slot,
     * or is waiting in line for one. Never called for a child that ends before
     * that — its returned promise settling is the signal then. What lets the
     * caller start a message's children one after another, so they queue in
     * the order they were called.
     */
    onInLine?: () => void;
  },
): Promise<SubagentOutcome> {
  const failed = (reason: string): SubagentOutcome => ({ output: `Could not start the sub-agent: ${reason}`, ok: false });
  if (parent.signal.aborted) return { output: "Stopped by the user before this tool call ran.", ok: false };

  // The same gate a send goes through, before anything is written: a provider
  // that was deleted, a model the allowlist never permitted, or one that
  // pinned models leave no room for. Its messages are ours, written to be
  // shown.
  try {
    await assertModelUsable(call.model);
  } catch (err) {
    return failed((err as Error).message);
  }

  const broker = getStreamBroker();
  const childId = uuid();
  const streamId = uuid();
  const userMsgId = uuid();
  const startedAt = Date.now();
  const info: SubAgentInfo = {
    description: call.description,
    model: call.model,
    mode: parent.mode,
    streamId,
    status: "running",
    startedAt,
  };

  let workspace: Workspace;
  let instructions: string | null;
  let producer: StreamProducer;
  try {
    const parentRow = await db.query.conversations.findFirst({
      where: eq(conversations.id, parent.convId),
      columns: { ownerId: true, workspace: true, instructions: true },
    });
    // Gone means deleted mid-run. The parent's run is being stopped; a child
    // must not be created under a conversation that no longer exists.
    if (!parentRow) return failed("the conversation no longer exists.");
    workspace = effectiveWorkspace(parentRow.workspace);
    instructions = parent.surface === "agent" ? await instructionsFor(parentRow.instructions, call.model, parent.convId) : null;

    await db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: childId,
        // The parent's owner, like the sandbox the child works in: what it
        // makes belongs to whoever owns the thread, whoever sent the message.
        ownerId: parentRow.ownerId,
        title: call.description,
        kind: "subagent",
        modelPref: { model: call.model },
        parentConversationId: parent.convId,
        parentMessageId: parent.assistantMsgId,
        parentCallId: call.callId,
        // No workspace of its own: the child's tools run in the parent's
        // sandbox (engine.ts's `role`). A copy here would be a second place a
        // checkout could be created from.
        subagent: info,
      });
      await tx.insert(messages).values({
        id: userMsgId,
        conversationId: childId,
        parentId: null,
        authorType: "user",
        // Nobody typed it: the parent's model wrote this task.
        authorUserId: null,
        origin: "server",
        lamport: startedAt,
        content: [{ kind: "text", text: call.prompt }] as ContentBlock[],
        status: "complete",
        createdAt: new Date(),
      });
    });

    producer = await broker.openProducer({
      streamId,
      conversationId: childId,
      userId: parent.userId,
      surface: parent.surface,
    });
  } catch (err) {
    console.error(`starting a sub-agent for ${parent.convId} failed:`, err);
    await markEnded(childId, info, "error", "The sub-agent could not be started.").catch(() => undefined);
    return failed("something went wrong on the server.");
  }

  producer.emit({
    kind: "message.start",
    message_id: userMsgId,
    author_type: "user",
    parent_id: null,
    lamport: startedAt,
    text: call.prompt,
    author_user_id: null,
  });
  producer.emit({ kind: "message.end", message_id: userMsgId, status: "complete" });

  // Its own controller, so a person can stop this child and leave its parent
  // (and its siblings) running — and tied to the parent's, so stopping the
  // parent stops it. Checked as well as listened for: a listener added to a
  // signal that has already fired never fires.
  const abort = new AbortController();
  const onParentAbort = () => { abort.abort(); };
  parent.signal.addEventListener("abort", onParentAbort, { once: true });
  if (hasFired(parent.signal)) abort.abort();

  // Under its own conversation id: reachable by `getRun(streamId)` for Stop
  // and approvals, without ever touching the parent's entry in the
  // one-run-per-conversation map.
  registerRun({ streamId, conversationId: childId, userId: parent.userId, abort, approvals: new Map(), model: call.model });
  announceNewRun(childId, streamId);

  parent.producer.emit({
    kind: "subagent.started",
    message_id: parent.assistantMsgId,
    call_id: call.callId,
    conversation_id: childId,
    stream_id: streamId,
    description: call.description,
    model: call.model,
    started_at: startedAt,
  });

  // How the child's stream ended, as the log recorded it. Held in an object
  // because it is written from the listener below, which the type checker
  // cannot see into from the code after the await.
  const ending: { end: { status: Exclude<SubAgentStatus, "running">; error?: string } | null } = { end: null };
  const offEnd = broker.onEnd(streamId, (end) => {
    ending.end = { status: end.status, ...(end.error === undefined ? {} : { error: end.error }) };
  });

  try {
    await runToolLoop({
      streamId,
      convId: childId,
      userId: parent.userId,
      userMsgId,
      userLamport: startedAt,
      model: call.model,
      mode: parent.mode,
      basePrompt: subagentSystemPrompt({ surface: parent.surface, workspace, mode: parent.mode, instructions }),
      surface: parent.surface,
      thinkingLevel: parent.thinkingLevel,
      nestedInstructions: parent.surface === "agent" && workspace.kind !== "scratch",
      role: { kind: "subagent", parentConvId: parent.convId },
      abort,
      producer: mirrorProgress(producer, parent.producer, childId, streamId, hooks?.onInLine),
    });
  } catch (err) {
    // `runToolLoop` rethrows anything that is not a cancellation. Awaited here
    // rather than detached, so unlike the starters' this cannot become an
    // unhandled rejection — but the stream still has to be ended, or it stays
    // "active" for anyone watching the child.
    const text = turnErrorText(err, `sub-agent ${streamId} failed in ${childId}`);
    await producer.end("error", { error: text }).catch(() => undefined);
    ending.end ??= { status: "error", error: text };
  } finally {
    offEnd();
    parent.signal.removeEventListener("abort", onParentAbort);
    // One run long: nothing will ever measure reuse against this again.
    forgetPromptTrace(childId);
  }
  if (!ending.end) {
    // Every deliberate exit of the loop ends the stream; this is the backstop
    // for one that did not, as in chatRun.ts.
    await producer.end("error", { error: "The run ended without a result." }).catch(() => undefined);
  }
  const end = ending.end ?? { status: "error" as const, error: "The run ended without a result." };

  const text = await finalText(childId).catch((err: unknown) => {
    console.warn(`could not read sub-agent ${childId}'s reply: ${(err as Error).message}`);
    return "";
  });
  await markEnded(childId, info, end.status, end.error).catch((err: unknown) => {
    console.warn(`could not record how sub-agent ${childId} ended: ${(err as Error).message}`);
  });
  parent.producer.emit({
    kind: "subagent.ended",
    conversation_id: childId,
    status: end.status,
    ended_at: Date.now(),
    ...(end.error === undefined ? {} : { error: end.error }),
  });

  return {
    output: subagentResultText({ description: call.description, status: end.status, text, error: end.error }),
    ok: end.status === "complete",
  };
}

/**
 * The child's producer, with each event that changes what its card shows
 * mirrored onto the parent's stream as `subagent.progress`.
 *
 * On the parent's stream so a thread's cards, its Sub-agents list and a
 * child's approval need no subscription to the child: subscribing to every
 * running child would put several streams of text deltas on one socket for a
 * view that shows none of them. Only the child's open panel subscribes.
 *
 * Emitted on change, with no timer behind it: every structural event is kept
 * in the stream log for its TTL, and the one figure that moves continuously —
 * elapsed time — is the client's to count from `started_at`.
 */
function mirrorProgress(
  child: StreamProducer,
  parent: StreamProducer,
  childConvId: string,
  childStreamId: string,
  onInLine?: () => void,
): StreamProducer {
  let tokensOut = 0;
  let pendingCallId: string | null = null;
  let inLine = false;
  // The first sign the child has reached the scheduler: a place in the queue,
  // or — when a slot was free — its first iteration.
  const reachedLine = () => {
    if (inLine) return;
    inLine = true;
    onInLine?.();
  };
  const report = (fields: Omit<SubAgentProgress, "conversation_id">) => {
    parent.emit({ kind: "subagent.progress", conversation_id: childConvId, ...fields });
  };
  const observe = (event: StreamEventKind) => {
    switch (event.kind) {
      case "run.queued":
        reachedLine();
        report({ state: "queued", queue_position: event.position });
        break;
      case "iteration":
        reachedLine();
        report({ state: "running", iteration: event.n });
        break;
      case "message.usage": {
        tokensOut += event.usage.completion_tokens;
        report({
          // What is in the child's window now: the breakdown's own total when
          // there is one (it counts the reply), else prompt plus reply.
          context_used: event.usage.context?.used_tokens ?? event.usage.prompt_tokens + event.usage.completion_tokens,
          window_tokens: event.usage.context?.window_tokens ?? null,
          last_gen_tps: event.usage.gen_tps,
          last_prompt_tps: event.usage.prompt_tps,
          tokens_out: tokensOut,
        });
        break;
      }
      case "approval.request": {
        pendingCallId = event.call_id;
        const { kind: _kind, ...request } = event;
        report({ state: "awaiting_approval", pending_approval: { stream_id: childStreamId, ...request } });
        break;
      }
      case "tool.result":
        // However the wait ended — allowed, refused, timed out, stopped — its
        // call now has a result, and the question is no longer open.
        if (pendingCallId === event.call_id) {
          pendingCallId = null;
          report({ state: "running", pending_approval: null });
        }
        break;
      default:
        break;
    }
  };
  return {
    emit: (event) => {
      child.emit(event);
      observe(event);
    },
    end: (status, info) => child.end(status, info),
  };
}

/** The text of the child's last assistant message — its report. Ordered as
 * the engine replays, never by insertion (AGENTS.md, "A read without
 * `orderBy` has no order"). Empty when it never wrote one. */
async function finalText(childConvId: string): Promise<string> {
  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, childConvId), eq(messages.authorType, "assistant")))
    .orderBy(desc(messages.lamport), desc(messages.createdAt))
    .limit(1);
  const blocks = (rows.at(0)?.content ?? []) as ContentBlock[];
  return blocks
    .filter((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function markEnded(
  childConvId: string,
  info: SubAgentInfo,
  status: Exclude<SubAgentStatus, "running">,
  error?: string,
): Promise<void> {
  const ended: SubAgentInfo = { ...info, status, endedAt: Date.now(), ...(error ? { error } : {}) };
  await db.update(conversations).set({ subagent: ended, updatedAt: new Date() }).where(eq(conversations.id, childConvId));
}

/**
 * When this process started. A child still marked `running` in the database
 * from before then belongs to a process that is gone.
 */
const BOOT_AT = Date.now();

/**
 * Ends the children a dead process left marked `running`.
 *
 * A run lives in one process's memory; after a restart nothing will ever move
 * such a row, and its card would say "running" for good, with a Stop that
 * reaches nothing. Bounded by this process's own start, like the routines
 * reconcile, so a child spawned while the server is still coming up is never
 * caught by the sweep meant for the previous process's.
 *
 * `ownerId` scopes it for tests, which share one database.
 */
export async function reconcileOrphanedSubagents(ownerId?: string): Promise<number> {
  const rows = await db
    .select({ id: conversations.id, subagent: conversations.subagent })
    .from(conversations)
    .where(
      and(
        eq(conversations.kind, "subagent"),
        sql`${conversations.subagent}->>'status' = 'running'`,
        sql`(${conversations.subagent}->>'startedAt')::float8 < ${BOOT_AT}`,
        ...(ownerId ? [eq(conversations.ownerId, ownerId)] : []),
      ),
    );
  for (const row of rows) {
    const info = row.subagent as SubAgentInfo;
    await markEnded(row.id, info, "error", SUBAGENT_LOST_ERROR);
  }
  return rows.length;
}

/**
 * A thread's sub-agents, as `SubAgentLive` rows, from what is stored.
 *
 * What the Sub-agents list and the cards read after a reload, or once the
 * stream log's TTL has passed. The figures come from `usage_records`: the
 * newest request's rates and context, and the reply tokens over all of them.
 * A child this process is not running cannot be `running`, whatever its row
 * says — the caller passes what the registry knows.
 */
export async function listSubagents(
  parentConvId: string,
  isRunning: (streamId: string) => boolean,
): Promise<SubAgentLive[]> {
  const rows = await db
    .select({
      id: conversations.id,
      subagent: conversations.subagent,
      parentMessageId: conversations.parentMessageId,
      parentCallId: conversations.parentCallId,
      // The outer table is named literally in both subqueries: drizzle renders
      // a column of a single-table select without its table, and a bare "id"
      // inside the subquery is `usage_records.id`.
      tokensOut: sql<number | null>`(
        SELECT SUM(u.output_tokens)::float8 FROM usage_records u WHERE u.conversation_id = "conversations"."id"
      )`,
      last: sql<{
        input: number | null;
        output: number | null;
        gen: number | null;
        prompt: number | null;
        window: number | null;
        used: number | null;
      } | null>`(
        SELECT jsonb_build_object(
          'input', u.input_tokens,
          'output', u.output_tokens,
          'gen', u.predicted_tps,
          'prompt', u.prompt_tps,
          'window', (u.context_breakdown->>'window_tokens')::float8,
          'used', (u.context_breakdown->>'used_tokens')::float8
        )
        FROM usage_records u
        WHERE u.conversation_id = "conversations"."id"
        ORDER BY u.created_at DESC
        LIMIT 1
      )`,
    })
    .from(conversations)
    .where(and(eq(conversations.parentConversationId, parentConvId), eq(conversations.kind, "subagent")))
    .orderBy(desc(conversations.createdAt))
    .limit(200);

  const out: SubAgentLive[] = [];
  for (const row of rows) {
    const info = row.subagent as SubAgentInfo | null;
    if (!info || !row.parentMessageId || !row.parentCallId) continue;
    const lost = info.status === "running" && !isRunning(info.streamId);
    const status: SubAgentStatus = lost ? "error" : info.status;
    const used = row.last ? (row.last.used ?? (row.last.input ?? 0) + (row.last.output ?? 0)) : null;
    out.push({
      conversation_id: row.id,
      stream_id: info.streamId,
      message_id: row.parentMessageId,
      call_id: row.parentCallId,
      description: info.description,
      model: info.model,
      started_at: info.startedAt,
      status,
      ...(status === "running" ? { state: "running" as const } : {}),
      ...(info.endedAt !== undefined ? { ended_at: info.endedAt } : {}),
      ...(lost ? { error: SUBAGENT_LOST_ERROR } : info.error ? { error: info.error } : {}),
      context_used: used,
      window_tokens: row.last?.window ?? null,
      last_gen_tps: row.last?.gen ?? null,
      last_prompt_tps: row.last?.prompt ?? null,
      ...(row.tokensOut != null ? { tokens_out: row.tokensOut } : {}),
    });
  }
  return out;
}
