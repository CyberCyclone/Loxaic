import { v4 as uuid } from "uuid";
import { and, db, eq, gt } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import type { ContentBlock, ContextBreakdown, TurnUsage } from "@shannon/types";
import { streamCompletion, type ChatMessage, type ToolCall, type CompletionResult } from "../../inference/provider.ts";
import { invalidateBackendModels, listBackendModels, resolveWindow } from "../../inference/models.ts";
import { addChars, apportion, summaryMessage, tallyChatMessages } from "../../inference/context.ts";
import type { PermissionMode, ToolName } from "@shannon/agent";
import { executeTool, toolNeedsSandbox, type ToolResult } from "../../agent/executor.ts";
import { getConversationSandbox } from "../../agent/sandbox-manager.ts";
import { buildToolset, type Toolset } from "../../mcp/registry.ts";
import { getStreamBroker } from "../index.ts";
import type { StreamProducer } from "../broker.ts";
import { getRun, unregisterRun } from "../registry.ts";

/** Hard ceiling on tool round-trips per user message. */
const MAX_ITERATIONS = 20;
/** An approval request left unanswered this long is treated as a denial. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** How many prior messages to replay as context. */
export const HISTORY_LIMIT = 50;

/** See loadEphemeralHistory's SUMMARY_LOOKBACK — skip cards are
 * `summary`-authored but textless, and must never act as a compaction cutoff. */
const SUMMARY_LOOKBACK = 20;

/**
 * The shared tool loop behind both surfaces. The starter (startChatRun /
 * startAgentRun) has already created the conversation, persisted the user
 * message, opened the producer, and registered the run; this drives the
 * model ↔ tool round-trips until the model answers without calling a tool.
 *
 * `incognito` runs write nothing conversation-scoped to Postgres — message
 * rows, activeLeafId, and usage records are all skipped; the stream log is
 * the only record.
 */
export async function runToolLoop(ctx: {
  streamId: string;
  convId: string;
  userId: string;
  userMsgId: string;
  model: string;
  mode: PermissionMode;
  /** Surface-appropriate system prompt, or null for none. The engine appends
   * the MCP untrusted-content addendum when MCP tools are offered. */
  basePrompt: string | null;
  incognito: boolean;
  abort: AbortController;
  producer: StreamProducer;
}): Promise<void> {
  const { streamId, convId, userId, model, mode, incognito, abort, producer } = ctx;

  try {
    const toolset = await buildToolset(userId, { mode, conversationId: convId });
    const promptParts = [ctx.basePrompt, toolset.systemPromptAddendum].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    const systemPrompt = promptParts.length ? promptParts.join("\n\n") : null;
    const tools = toolset.openAiTools;
    const history = incognito ? await loadEphemeralHistory(convId) : await loadHistory(convId);
    // The compaction summary rides as a second system message, after the real
    // system prompt and before the replayed turns — everything older than it
    // stays in Postgres and on screen but is no longer sent.
    const summaryMsg = history.summaryText ? summaryMessage(history.summaryText) : null;
    const chatMessages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt } as ChatMessage] : []),
      ...(summaryMsg ? [summaryMsg] : []),
      ...history.messages,
    ];

    let parentId = ctx.userMsgId;
    let lastAssistantId: string | null = null;
    let finished = false;
    // Set when any iteration triggered a JIT load, so the cached model list —
    // and with it the context window — can be dropped before the client refreshes.
    let jitLoaded = false;

    for (let iteration = 1; iteration <= MAX_ITERATIONS && !finished; iteration++) {
      if (abort.signal.aborted) break;
      producer.emit({ kind: "iteration", n: iteration, max: MAX_ITERATIONS });

      const assistantMsgId = uuid();
      lastAssistantId = assistantMsgId;
      if (!incognito) {
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
      }
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
          } else if (event.type === "done") {
            toolCalls = event.result.toolCalls;
            doneResult = event.result;
            if (!incognito) {
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
        }
      } catch (err) {
        const isAbort = (err as Error)?.name === "AbortError" || abort.signal.aborted;
        const status = isAbort ? "cancelled" : "error";
        const errorMessage = (err as Error).message;
        const blocks: ContentBlock[] = [];
        if (thinking) blocks.push({ kind: "thinking", text: thinking });
        if (text) blocks.push({ kind: "text", text });
        if (!incognito) {
          await db.update(messages).set({ content: blocks, status }).where(eq(messages.id, assistantMsgId)).catch(() => {});
        }
        const eventError = isAbort ? undefined : errorMessage;
        producer.emit({ kind: "message.end", message_id: assistantMsgId, status, error: eventError });
        await producer.end(status, { error: eventError }).catch(() => {});
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
      if (!incognito) {
        await db
          .update(messages)
          .set({ content: blocks.length ? blocks : [{ kind: "text", text: "" }], status: "complete" })
          .where(eq(messages.id, assistantMsgId));
      }

      if (toolCalls.length === 0) {
        finished = true;
        if (!incognito) {
          await db
            .update(conversations)
            .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
            .where(eq(conversations.id, convId));
        }
        // A window read before a JIT load is the model's max, not what the
        // backend allocated. Re-read it now that loading is done.
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
        const outcome = await runOneToolCall({ streamId, convId, userId, mode, incognito, toolset, producer, assistantMsgId }, call);
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
      if (!incognito) {
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
      }
      parentId = toolMsgId;

      if (abort.signal.aborted) {
        // This iteration's tools already ran and its message.end already
        // went out above as "complete" — the tool results are real and
        // stay. What stops here is the *run continuing to another
        // iteration*, so the stream itself ends cancelled without touching
        // an already-finished message.
        if (!incognito) {
          await db
            .update(conversations)
            .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
            .where(eq(conversations.id, convId));
        }
        await producer.end("cancelled");
        return;
      }
    }

    if (!finished) {
      if (lastAssistantId && !incognito) {
        await db
          .update(conversations)
          .set({ activeLeafId: lastAssistantId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));
      }
      await producer.end("error", {
        error: `Stopped after ${MAX_ITERATIONS} tool iterations without a final answer.`,
      });
    }
  } finally {
    unregisterRun(streamId);
  }
}

/** Approval gate + execution for a single model-requested tool call. */
async function runOneToolCall(
  ctx: { streamId: string; convId: string; userId: string; mode: PermissionMode; incognito: boolean; toolset: Toolset; producer: StreamProducer; assistantMsgId: string },
  call: ToolCall,
): Promise<{ output: string; diff?: { path: string; oldContent: string | null; newContent: string | null }[] }> {
  const { convId, userId, mode, incognito, toolset, producer, assistantMsgId } = ctx;
  const toolName = call.function.name;
  const args = safeParseArgs(call.function.arguments);

  const resolved = toolset.get(toolName);
  if (!resolved) {
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

  if (toolset.requiresApproval(resolved, mode)) {
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

  if (resolved.source.kind === "mcp") {
    // No sandbox involvement: MCP dispatch validates args, calls the server,
    // and returns wrapped untrusted output. Failures are ok:false results.
    const result = await toolset.dispatchMcp(resolved, args);
    producer.emit({
      kind: "tool.result",
      message_id: assistantMsgId,
      call_id: call.id,
      tool: toolName,
      output: result.output,
      ok: result.ok,
    });
    return { output: result.output };
  }

  // Builtin names come from TOOLS by construction, so the narrowing is sound.
  const builtinName = resolved.source.kind === "builtin" ? (resolved.name as ToolName) : null;

  let container = null;
  if (builtinName && toolNeedsSandbox(builtinName)) {
    try {
      // Incognito conversations get a sandbox with no Postgres bookkeeping
      // row — the boot-time orphan sweep covers a crashed process instead.
      container = await getConversationSandbox(userId, convId, { ephemeral: incognito });
    } catch (err) {
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

  const result: ToolResult = builtinName
    ? await executeTool(container, builtinName, args)
    : { ok: false, output: `Unknown tool: ${toolName}` };
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
    const parsed = JSON.parse(raw || "{}");
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
    cachedTokens: result.timings?.cache_n || 0,
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
    const blocks = (row.content as ContentBlock[]) ?? [];

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

/**
 * Incognito counterpart of loadHistory: rebuilt from the stream log's folded
 * snapshots — there's no Postgres row to query, since none was ever written.
 * Tool turns replay too: the fold attaches each tool.result onto its call, so
 * a call with an `output` is resolved and a call without one is dangling and
 * stripped, mirroring the Postgres loader exactly. The newest summary (a
 * compact run's message) lives in the same log; only what came after it is
 * replayed — same cutoff rule as the Postgres path, and skip cards are
 * textless so they never act as a cutoff.
 */
export async function loadEphemeralHistory(
  conversationId: string,
): Promise<{ messages: ChatMessage[]; truncated: boolean; summaryText: string | null }> {
  const broker = getStreamBroker();
  const runIds = (await broker.driver.listConvStreams(conversationId)).slice(-HISTORY_LIMIT);

  // Snapshot messages become either a summary marker or a batch of prompt
  // messages (an assistant turn and its tool results travel together, so the
  // cutoff below can never separate a call from its result).
  const items: ({ kind: "summary"; text: string } | { kind: "msgs"; msgs: ChatMessage[] })[] = [];
  for (const runId of runIds) {
    const records = await broker.readFrom(runId, 0);
    const snapshot = broker.foldSnapshot(records);
    for (const m of snapshot.messages) {
      if (m.status !== "complete") continue;
      if (m.author_type === "summary") {
        if (m.text) items.push({ kind: "summary", text: m.text });
        continue;
      }
      if (m.author_type === "user") {
        if (m.text) items.push({ kind: "msgs", msgs: [{ role: "user", content: m.text }] });
        continue;
      }
      if (m.author_type === "assistant") {
        const resolved = m.tool_calls.filter((t) => t.output !== undefined);
        const calls: ToolCall[] = resolved.map((t) => ({
          id: t.call_id,
          type: "function" as const,
          function: { name: t.tool, arguments: JSON.stringify(t.args ?? {}) },
        }));
        if (!m.text && calls.length === 0) continue;
        items.push({
          kind: "msgs",
          msgs: [
            { role: "assistant", content: m.text || null, ...(calls.length ? { tool_calls: calls } : {}) },
            ...resolved.map((t) => ({ role: "tool" as const, tool_call_id: t.call_id, content: t.output as string })),
          ],
        });
      }
      // author_type "tool" snapshot messages carry nothing to replay: the
      // fold already attached their results onto the assistant's calls.
    }
  }

  const lastSummaryIdx = items.map((i) => i.kind).lastIndexOf("summary");
  const summaryText =
    lastSummaryIdx >= 0 ? (items[lastSummaryIdx] as { kind: "summary"; text: string }).text : null;

  const out: ChatMessage[] = [];
  for (const item of items.slice(lastSummaryIdx + 1)) {
    if (item.kind === "msgs") out.push(...item.msgs);
  }
  const truncated = out.length > HISTORY_LIMIT;
  const capped = out.slice(-HISTORY_LIMIT);
  // A head cut can behead an assistant-with-calls, leaving its tool messages
  // orphaned at the front — drop those or the backend rejects the list.
  while (capped.length && capped[0].role === "tool") capped.shift();
  return { messages: capped, truncated, summaryText };
}
