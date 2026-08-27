import { v4 as uuid } from "uuid";
import { and, db, eq, gt } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import type { ContentBlock, ContextBreakdown, TurnUsage } from "@shannon/types";
import { streamCompletion, type ChatMessage, type ToolCall, type CompletionResult } from "../../inference/provider.ts";
import { invalidateBackendModels, listBackendModels, resolveWindow } from "../../inference/models.ts";
import { addChars, apportion, summaryMessage, tallyChatMessages } from "../../inference/context.ts";
import { isToolName, toOpenAiTools, toolRequiresApproval, WRITE_TOOLS, type PermissionMode } from "@shannon/agent";
import { executeTool, toolNeedsSandbox } from "../../agent/executor.ts";
import { getConversationSandbox } from "../../agent/sandbox-manager.ts";
import { getSandboxMode } from "../../sandbox/provider.ts";
import { assertConversationAccess, assertParentInConversation } from "../authz.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRun, getRunByConversation, registerRun, unregisterRun } from "../registry.ts";
import { announceNewRun } from "../watchers.ts";

/** Hard ceiling on tool round-trips per user message. */
const MAX_ITERATIONS = 20;
/** An approval request left unanswered this long is treated as a denial. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** How many prior messages to replay as context. */
export const HISTORY_LIMIT = 50;

/**
 * A plain function call rather than a direct `abort.signal.aborted` read:
 * the signal can flip true at any point during the awaits that follow an
 * earlier check in the same iteration, but the type checker doesn't model
 * that, so a direct re-read gets narrowed to a stale "still false" — this
 * indirection is what keeps that narrowing from applying.
 */
function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

/** See chatRun's SUMMARY_LOOKBACK — skip cards are `summary`-authored but
 * textless, and must never act as a compaction cutoff. */
const SUMMARY_LOOKBACK = 20;

/** Built at call time (not a module-load const): SANDBOX_MODE shapes what's
 * true to tell the model about where it's actually running. */
function baseSystemPrompt(): string {
  const location = getSandboxMode() === "host"
    ? "directly on the host machine, in a scratch working directory created for this conversation"
    : "inside an isolated Linux sandbox container, with the repository checked out at /home/shannon/repo (your working directory; relative paths resolve there)";
  return [
    `You are Shannon, a coding agent working ${location}.`,
    "Work in small, verifiable steps: read before you edit, and prefer fs_edit over rewriting a whole file.",
    "Use the tools available to you rather than guessing at file contents. Explain what you are doing as you go,",
    "and finish with a short summary of what changed.",
  ].join(" ");
}

function planningSystemPrompt(): string {
  const location = getSandboxMode() === "host" ? "on the host machine" : "at /home/shannon/repo";
  return [
    `You are Shannon in PLANNING mode. Investigate the repository ${location} using the read-only tools`,
    "available to you and produce a concrete, step-by-step plan. Do not write, edit, or execute anything —",
    "no files may change in this mode. Finish with the plan as prose.",
  ].join(" ");
}

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

  void runAgentTurn({ streamId, convId, userId, userMsgId, model, mode, abort, producer });

  return { streamId, conversationId: convId, userMessageId: userMsgId, incognito: false };
}

async function runAgentTurn(ctx: {
  streamId: string;
  convId: string;
  userId: string;
  userMsgId: string;
  model: string;
  mode: PermissionMode;
  abort: AbortController;
  producer: StreamProducer;
}): Promise<void> {
  const { streamId, convId, userId, model, mode, abort, producer } = ctx;

  try {
    const systemPrompt = mode === "planning" ? planningSystemPrompt() : baseSystemPrompt();
    const tools = toOpenAiTools(mode === "planning" ? WRITE_TOOLS : []);
    const history = await loadHistory(convId);
    // The compaction summary rides as a second system message, after the real
    // system prompt and before the replayed turns — everything older than it
    // stays in Postgres and on screen but is no longer sent.
    const summaryMsg = history.summaryText ? summaryMessage(history.summaryText) : null;
    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...(summaryMsg ? [summaryMsg] : []),
      ...history.messages,
    ];

    let parentId = ctx.userMsgId;
    let lastAssistantId: string | null = null;
    let finished = false;
    // Set when any iteration triggered a JIT load, so the cached model list —
    // and with it the context window — can be dropped before the client refreshes.
    let jitLoaded = false;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      if (abort.signal.aborted) break;
      producer.emit({ kind: "iteration", n: iteration, max: MAX_ITERATIONS });

      const assistantMsgId = uuid();
      lastAssistantId = assistantMsgId;
      await db.insert(messages).values({
        id: assistantMsgId,
        conversationId: convId,
        parentId,
        authorType: "assistant",
        origin: "server",
        model,
        lamport: Date.now(),
        content: [] as ContentBlock[],
        status: "streaming",
        createdAt: new Date(),
      });
      producer.emit({
        kind: "message.start",
        message_id: assistantMsgId,
        author_type: "assistant",
        parent_id: parentId,
        model,
      });

      let text = "";
      let thinking = "";
      let toolCalls: ToolCall[] = [];
      let doneResult: CompletionResult | null = null;

      let windowTokens: number | null = null;
      try {
        const backendModels = await listBackendModels();
        const targetModel = backendModels.find((m) => m.id === model);
        windowTokens = targetModel?.loaded_context_tokens ?? targetModel?.context_tokens ?? null;
        if (targetModel && !targetModel.loaded) {
          jitLoaded = true;
          producer.emit({ kind: "model.loading", message_id: assistantMsgId });
        }
      } catch {
        // Best-effort — fall back to the generic "thinking" indicator.
      }

      // Snapshot what this iteration is actually sending. `chatMessages` grows
      // as tool calls and results are appended, so it has to be measured here
      // rather than once per run — and `tools` is measured with it, since the
      // schemas ride in `body.tools` and appear nowhere in the message list.
      // The summary message is tallied separately: tallyChatMessages would
      // classify its system role as `system` and silently fold the compacted
      // history into the system-prompt row.
      const tally = tallyChatMessages(
        summaryMsg ? chatMessages.filter((m) => m !== summaryMsg) : chatMessages,
        tools,
      );
      if (summaryMsg) addChars(tally, "summary", summaryMsg.content);
      const breakdownMeta = {
        historyMessages: history.messages.length,
        historyLimit: HISTORY_LIMIT,
        historyTruncated: history.truncated,
        windowTokens,
      };

      try {
        for await (const event of streamCompletion(model, chatMessages, { tools, signal: abort.signal })) {
          if (event.type === "delta") {
            text += event.content;
            producer.emit({ kind: "text.delta", message_id: assistantMsgId, text: event.content });
          } else if (event.type === "thinking") {
            thinking += event.content;
            producer.emit({ kind: "thinking.delta", message_id: assistantMsgId, text: event.content });
          } else {
            toolCalls = event.result.toolCalls;
            doneResult = event.result;
            await recordUsage({
              runId: streamId,
              userId,
              convId,
              messageId: assistantMsgId,
              model,
              result: event.result,
              context: apportion(
                tally,
                event.result.usage.prompt_tokens,
                event.result.usage.completion_tokens,
                breakdownMeta,
              ),
            });
          }
        }
      } catch (err) {
        const isAbort = (err as Error).name === "AbortError" || abort.signal.aborted;
        const status = isAbort ? "cancelled" : "error";
        const errorMessage = (err as Error).message;
        const blocks: ContentBlock[] = [];
        if (thinking) blocks.push({ kind: "thinking", text: thinking });
        if (text) blocks.push({ kind: "text", text });
        await db.update(messages).set({ content: blocks, status }).where(eq(messages.id, assistantMsgId)).catch(() => undefined);
        const eventError = isAbort ? undefined : errorMessage;
        producer.emit({ kind: "message.end", message_id: assistantMsgId, status, error: eventError });
        await producer.end(status, { error: eventError }).catch(() => undefined);
        return;
      }

      // Persist the assistant turn as ordered blocks: thinking, prose, calls.
      const blocks: ContentBlock[] = [];
      if (thinking) blocks.push({ kind: "thinking", text: thinking });
      if (text) blocks.push({ kind: "text", text });
      for (const call of toolCalls) {
        blocks.push({
          kind: "tool_call",
          call_id: call.id,
          tool: call.function.name,
          args: safeParseArgs(call.function.arguments),
        });
        producer.emit({
          kind: "tool.call",
          message_id: assistantMsgId,
          call_id: call.id,
          tool: call.function.name,
          args: safeParseArgs(call.function.arguments),
        });
      }
      await db
        .update(messages)
        .set({ content: blocks.length ? blocks : [{ kind: "text", text: "" }], status: "complete" })
        .where(eq(messages.id, assistantMsgId));

      if (toolCalls.length === 0) {
        finished = true;
        await db
          .update(conversations)
          .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
        // Same as chat: a window read before a JIT load is the model's max,
        // not what the backend allocated. Re-read it now that loading is done.
        if (jitLoaded) {
          invalidateBackendModels();
          breakdownMeta.windowTokens = (await resolveWindow(model)) ?? breakdownMeta.windowTokens;
        }
        const usage: TurnUsage | undefined = doneResult
          ? {
              prompt_tokens: doneResult.usage.prompt_tokens,
              completion_tokens: doneResult.usage.completion_tokens,
              total_tokens: doneResult.usage.total_tokens,
              prompt_tps: doneResult.promptTps,
              gen_tps: doneResult.genTps,
              total_ms: doneResult.totalMs,
              // This is the terminating iteration, so `tally` and `doneResult`
              // describe the same call — the breakdown lines up exactly.
              context: apportion(
                tally,
                doneResult.usage.prompt_tokens,
                doneResult.usage.completion_tokens,
                breakdownMeta,
              ),
            }
          : undefined;
        producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage });
        await producer.end("complete", { usage });
        break;
      }

      // toolCalls.length > 0: message.end is deferred — the run continues
      // (tool results still need to land on this message before it's done).
      chatMessages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      parentId = assistantMsgId;

      // ── Run each requested tool ───────────────────────────
      const resultBlocks: ContentBlock[] = [];
      for (const call of toolCalls) {
        const outcome = await runOneToolCall({ streamId, convId, userId, mode, producer, assistantMsgId }, call);
        resultBlocks.push({
          kind: "tool_result",
          call_id: call.id,
          output: outcome.output,
          ...(outcome.diff ? { diff: outcome.diff } : {}),
        });
        chatMessages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: outcome.output,
        });
      }
      producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete" });

      const toolMsgId = uuid();
      await db.insert(messages).values({
        id: toolMsgId,
        conversationId: convId,
        parentId: assistantMsgId,
        authorType: "tool",
        origin: "server",
        lamport: Date.now(),
        content: resultBlocks,
        status: "complete",
        createdAt: new Date(),
      });
      parentId = toolMsgId;

      if (isAborted(abort)) {
        // This iteration's tools already ran and its message.end already
        // went out above as "complete" — the tool results are real and
        // stay. What stops here is the *run continuing to another
        // iteration*, so the stream itself ends cancelled without touching
        // an already-finished message.
        await db
          .update(conversations)
          .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
        await producer.end("cancelled");
        return;
      }
    }

    if (!finished) {
      if (lastAssistantId) {
        await db
          .update(conversations)
          .set({ activeLeafId: lastAssistantId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
      }
      await producer.end("error", {
        error: `Stopped after ${String(MAX_ITERATIONS)} tool iterations without a final answer.`,
      });
    }
  } finally {
    unregisterRun(streamId);
  }
}

/** Approval gate + execution for a single model-requested tool call. */
async function runOneToolCall(
  ctx: { streamId: string; convId: string; userId: string; mode: PermissionMode; producer: StreamProducer; assistantMsgId: string },
  call: ToolCall,
): Promise<{ output: string; diff?: { path: string; oldContent: string | null; newContent: string | null }[] }> {
  const { convId, userId, mode, producer, assistantMsgId } = ctx;
  const toolName = call.function.name;
  const args = safeParseArgs(call.function.arguments);

  if (!isToolName(toolName)) {
    const output = `Unknown tool "${toolName}". Available tools: see the tool list.`;
    producer.emit({
      kind: "tool.result",
      message_id: assistantMsgId,
      call_id: call.id,
      tool: toolName,
      output,
      ok: false,
    });
    return { output };
  }

  if (toolRequiresApproval(toolName, mode)) {
    producer.emit({ kind: "approval.request", call_id: call.id, tool: toolName, args });
    const approved = await waitForApproval(ctx.streamId, call.id);
    if (!approved) {
      const output = "User denied this tool call.";
      producer.emit({
        kind: "tool.result",
        message_id: assistantMsgId,
        call_id: call.id,
        tool: toolName,
        output,
        ok: false,
      });
      return { output };
    }
  }

  let handle = null;
  if (toolNeedsSandbox(toolName)) {
    try {
      handle = await getConversationSandbox(userId, convId);
    } catch (err) {
      // The underlying error (from the container provider) already names
      // what was tried and how to fix it — see container-provider.ts's
      // requireDocker().
      const output = `Could not start a sandbox: ${(err as Error).message}`;
      producer.emit({
        kind: "tool.result",
        message_id: assistantMsgId,
        call_id: call.id,
        tool: toolName,
        output,
        ok: false,
      });
      return { output };
    }
  }

  const result = await executeTool(handle, toolName, args);
  if (result.todos) producer.emit({ kind: "todos", todos: result.todos });
  producer.emit({
    kind: "tool.result",
    message_id: assistantMsgId,
    call_id: call.id,
    tool: toolName,
    output: result.output,
    ok: result.ok,
    ...(result.diff ? { diff: result.diff } : {}),
  });
  return { output: result.output, diff: result.diff };
}

/** Approvals are run-scoped (registry), not connection-scoped — a different
 * device/socket than the one that started the run can approve or deny. */
function waitForApproval(streamId: string, callId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const run = getRun(streamId);
      run?.approvals.delete(callId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    const run = getRun(streamId);
    if (!run) {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    run.approvals.set(callId, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
  });
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function recordUsage(input: {
  runId: string;
  userId: string;
  convId: string;
  messageId: string;
  model: string;
  result: CompletionResult;
  context?: ContextBreakdown;
}): Promise<void> {
  const { result } = input;
  // Guard against writing an all-zero row when a provider reports nothing.
  if (result.usage.total_tokens <= 0 && !result.timings) return;
  await db.insert(usageRecords).values({
    id: uuid(),
    userId: input.userId,
    conversationId: input.convId,
    messageId: input.messageId,
    runId: input.runId,
    model: input.model,
    origin: "server",
    inputTokens: result.usage.prompt_tokens,
    cachedTokens: result.timings?.cache_n ?? 0,
    outputTokens: result.usage.completion_tokens,
    ttftMs: result.ttftMs,
    promptMs: result.timings?.prompt_ms ?? null,
    predictMs: result.timings?.predicted_ms ?? null,
    totalMs: result.totalMs,
    promptTps: result.promptTps,
    predictedTps: result.genTps,
    contextBreakdown: input.context ?? null,
  });
}

/**
 * Rebuilds the OpenAI message list from stored content blocks. Thinking
 * blocks are dropped (display-only), and assistant tool calls with no
 * matching tool_result are stripped — an interrupted run would otherwise
 * leave a dangling call that most servers reject.
 */
export async function loadHistory(
  conversationId: string,
): Promise<{ messages: ChatMessage[]; truncated: boolean; summaryText: string | null }> {
  // The newest real compaction point, keyed on lamport — the same ordering
  // the main query below uses. Rows at or before it are represented by the
  // summary text and excluded from the replay.
  const summaryRows = await db.query.messages.findMany({
    where: and(
      eq(messages.conversationId, conversationId),
      eq(messages.authorType, "summary"),
      eq(messages.status, "complete"),
    ),
    orderBy: (msgs, { desc }) => [desc(messages.lamport), desc(msgs.createdAt)],
    columns: { content: true, lamport: true },
    limit: SUMMARY_LOOKBACK,
  });
  const summaryRow = summaryRows
    .map((r) => ({ text: textOf(r.content as ContentBlock[]), lamport: r.lamport }))
    .find((r) => r.text.length > 0);
  const summaryText = summaryRow?.text ?? null;

  // One over the limit, so we can tell the client whether older turns were
  // already dropped. Cheaper than a second COUNT(*).
  const rows = await db.query.messages.findMany({
    where: summaryRow
      ? and(eq(messages.conversationId, conversationId), gt(messages.lamport, summaryRow.lamport))
      : eq(messages.conversationId, conversationId),
    orderBy: (msgs, { desc }) => [desc(messages.lamport), desc(msgs.createdAt)],
    columns: { authorType: true, content: true, status: true, lamport: true },
    limit: HISTORY_LIMIT + 1,
  });
  const truncated = rows.length > HISTORY_LIMIT;
  const ordered = rows.slice(0, HISTORY_LIMIT).reverse();

  const resolvedCallIds = new Set<string>();
  for (const row of ordered) {
    if (row.authorType !== "tool") continue;
    for (const block of row.content as ContentBlock[]) {
      if (block.kind === "tool_result") resolvedCallIds.add(block.call_id);
    }
  }

  const out: ChatMessage[] = [];
  for (const row of ordered) {
    if (row.status !== "complete") continue;
    const blocks = (row.content ?? []) as ContentBlock[];

    if (row.authorType === "user") {
      const text = textOf(blocks);
      if (text) out.push({ role: "user", content: text });
      continue;
    }

    if (row.authorType === "assistant") {
      const text = textOf(blocks);
      const calls: ToolCall[] = blocks
        .filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call")
        .filter((b) => resolvedCallIds.has(b.call_id))
        .map((b) => ({
          id: b.call_id,
          type: "function" as const,
          function: { name: b.tool, arguments: JSON.stringify(b.args ?? {}) },
        }));
      if (!text && calls.length === 0) continue;
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    if (row.authorType === "tool") {
      for (const block of blocks) {
        if (block.kind !== "tool_result") continue;
        out.push({ role: "tool", tool_call_id: block.call_id, content: block.output });
      }
    }
  }
  return { messages: out, truncated, summaryText };
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}
