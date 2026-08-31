import { v4 as uuid } from "uuid";
import { and, db, eq, gt } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import { sanitizeFilename, type AttachmentRef, type ContentBlock, type ContextBreakdown, type TurnUsage } from "@shannon/types";
import {
  countDocumentParts,
  countImageParts,
  streamCompletion,
  visionErrorMessage,
  type ChatMessage,
  type ToolCall,
  type CompletionResult,
} from "../../inference/provider.ts";
import {
  attachmentContentParts,
  DOCUMENT_SYSTEM_ADDENDUM,
  selectAffordableAttachments,
} from "../../files/storage.ts";
import { invalidateBackendModels, listBackendModels, resolveWindow } from "../../inference/models.ts";
import { addChars, apportion, summaryMessage, tallyChatMessages } from "../../inference/context.ts";
import type { PermissionMode, ToolName } from "@shannon/agent";
import { executeTool, toolNeedsSandbox, type ToolResult } from "../../agent/executor.ts";
import { attachActiveSandbox, getConversationSandbox, hasActiveSandbox } from "../../agent/sandbox-manager.ts";
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

/** See loadEphemeralHistory's SUMMARY_LOOKBACK — skip cards are
 * `summary`-authored but textless, and must never act as a compaction cutoff. */
const SUMMARY_LOOKBACK = 20;

/**
 * The run's system prompt: the surface's base prompt, plus whichever
 * untrusted-content addenda this turn actually needs.
 *
 * Pure and exported so the addenda can be asserted directly — the same reason
 * `stripImagesForCompaction` is extracted in compactRun.ts. Driving a whole
 * run through the mock cannot show what the system prompt contained, and that
 * blind spot is exactly how DOCUMENT_SYSTEM_ADDENDUM came to be defined,
 * documented in AGENTS.md as the document path's prompt-injection defence,
 * and never once appended to a prompt.
 */
export function assembleSystemPrompt(
  basePrompt: string | null,
  toolAddendum: string | null,
  hasDocuments: boolean,
): string | null {
  const parts = [basePrompt, toolAddendum, hasDocuments ? DOCUMENT_SYSTEM_ADDENDUM : null].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length ? parts.join("\n\n") : null;
}

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
    const tools = toolset.openAiTools;
    // History is loaded before the system prompt is assembled, because whether
    // this turn carries a document decides whether the document addendum goes
    // in — the same pairing MCP has, where wrapResult's markers are only
    // meaningful alongside an addendum saying what they mean.
    const history = incognito ? await loadEphemeralHistory(convId) : await loadHistory(convId);
    const hasDocuments = history.messages.some(
      (m) => m.role === "user" && countDocumentParts(m.content) > 0,
    );
    const systemPrompt = assembleSystemPrompt(ctx.basePrompt, toolset.systemPromptAddendum, hasDocuments);
    // The compaction summary rides as a second system message, after the real
    // system prompt and before the replayed turns — everything older than it
    // stays in Postgres and on screen but is no longer sent.
    const summaryMsg = history.summaryText ? summaryMessage(history.summaryText) : null;
    const chatMessages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt } as ChatMessage] : []),
      ...(summaryMsg ? [summaryMsg] : []),
      ...history.messages,
    ];
    // Only user turns ever carry image parts, and the loop below only appends
    // assistant and tool messages — so this holds for every iteration.
    const hadImages = chatMessages.some((m) => m.role === "user" && countImageParts(m.content) > 0);

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
          } else {
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
        const isAbort = (err as Error).name === "AbortError" || abort.signal.aborted;
        const status = isAbort ? "cancelled" : "error";
        // A text-only model choking on image parts is a user-fixable
        // situation, not an outage — say so instead of relaying the backend's
        // phrasing, which is different for every runtime.
        const raw = (err as Error).message;
        const errorMessage = !isAbort && hadImages ? (visionErrorMessage(raw) ?? raw) : raw;
        const blocks: ContentBlock[] = [];
        if (thinking) blocks.push({ kind: "thinking", text: thinking });
        if (text) blocks.push({ kind: "text", text });
        if (!incognito) {
          await db.update(messages).set({ content: blocks, status }).where(eq(messages.id, assistantMsgId)).catch(() => undefined);
        }
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

      if (isAborted(abort)) {
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
        error: `Stopped after ${String(MAX_ITERATIONS)} tool iterations without a final answer.`,
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

  // The MCP branch returned above, so this is a builtin by construction — and
  // builtin names come from TOOLS, so the ToolName narrowing is sound.
  const builtinName = resolved.name as ToolName;

  let handle = null;
  if (toolNeedsSandbox(builtinName)) {
    try {
      // Incognito conversations get a sandbox with no Postgres bookkeeping
      // row — the boot-time orphan sweep covers a crashed process instead.
      handle = await getConversationSandbox(userId, convId, { ephemeral: incognito });
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

  const result: ToolResult = await executeTool(handle, builtinName, args);
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

  // Which attachments this prompt can afford, decided over the whole replay
  // before any of it is read off disk — see selectAffordableAttachments.
  // Skipping the walk when the thread has none keeps the common case free of
  // stats.
  const complete = ordered.filter((row) => row.status === "complete");
  const attachmentTurns = complete
    .filter((row) => row.authorType === "user")
    .map((row) => attachmentsOf((row.content ?? []) as ContentBlock[]));
  const affordable = attachmentTurns.some((t) => t.length > 0)
    ? await selectAffordableAttachments(attachmentTurns)
    : undefined;

  const out: ChatMessage[] = [];
  for (const row of complete) {
    const blocks = (row.content ?? []) as ContentBlock[];

    if (row.authorType === "user") {
      const text = textOf(blocks);
      const atts = attachmentsOf(blocks);
      // Image-only turns have no text at all, so the emptiness check can't
      // gate them the way it gates a genuinely blank message.
      if (atts.length > 0) {
        out.push({
          role: "user",
          content: await attachmentContentParts(atts, text, affordable, (a, fullText) =>
            writeOverflowToSandbox(conversationId, a, fullText),
          ),
        });
      } else if (text) {
        out.push({ role: "user", content: text });
      }
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

/** Attachment blocks in stored order — which is the order they were sent in,
 * and the order they must reach the model in. */
function attachmentsOf(blocks: ContentBlock[]): AttachmentRef[] {
  return blocks
    .filter((b): b is Extract<ContentBlock, { kind: "attachment" }> => b.kind === "attachment")
    .map((b) => ({ ref: b.ref, mime: b.mime, ...(b.name === undefined ? {} : { name: b.name }) }));
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}

/**
 * Writes a truncated document's full extracted text into the conversation's
 * sandbox, if one is already running — see hasActiveSandbox/attachActiveSandbox
 * for why this never creates one. Both chat and agent share this tool loop
 * and can each have a sandbox, so the gate is "is one already live", not
 * which surface this run is.
 *
 * Uses writeFileBinary, not writeFile: the container provider's writeFile
 * passes its payload as a bash argv element, which a multi-megabyte document
 * (now that extraction caches up to MAX_CACHED_EXTRACTION_BYTES) would blow
 * past ARG_MAX on. writeFileBinary streams over stdin instead.
 */
async function writeOverflowToSandbox(
  convId: string,
  a: AttachmentRef,
  fullText: string,
): Promise<string | null> {
  if (!hasActiveSandbox(convId)) return null;
  try {
    const handle = await attachActiveSandbox(convId);
    if (!handle) return null;
    // This file's content is the extracted text, not the original bytes — a
    // PDF's overflow file is plain text, not a PDF. Stripping the original
    // extension before appending ".txt" keeps that honest (report.pdf ->
    // report.txt) and, as a side effect, avoids a doubled extension for a
    // source that was already named "*.txt".
    const baseName = sanitizeFilename(a.name ?? "file").replace(/\.[^./]+$/, "");
    const relPath = `attachments/${a.ref.slice(0, 8)}-${baseName}.txt`;
    await handle.writeFileBinary(`${handle.workdir}/${relPath}`, Buffer.from(fullText, "utf8"));
    return `./${relPath}`;
  } catch {
    // Writing the overflow is a nicety, not a requirement — a failure here
    // (sandbox mid-stop, disk full) must degrade to the pathless note, never
    // fail the run.
    return null;
  }
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

  // Snapshot messages become a summary marker, a batch of prompt messages (an
  // assistant turn and its tool results travel together, so the cutoff below
  // can never separate a call from its result), or — for a user turn carrying
  // images — an unresolved "user" item. That one stays unresolved until the
  // cutoff is known: resolving it means reading images off disk, and the image
  // budget has to be spent over the turns actually replayed, newest-first.
  type Item =
    | { kind: "summary"; text: string }
    | { kind: "msgs"; msgs: ChatMessage[] }
    | { kind: "user"; atts: AttachmentRef[]; text: string };
  const items: Item[] = [];
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
        // Incognito writes nothing to Postgres, so message.start's attachment
        // list is the only record that this turn carried images at all.
        if (m.attachments?.length) {
          items.push({ kind: "user", atts: m.attachments, text: m.text });
        } else if (m.text) {
          items.push({ kind: "msgs", msgs: [{ role: "user", content: m.text }] });
        }
        continue;
      }
      if (m.author_type === "assistant") {
        // Type-predicate filter, so `output` narrows to string for the tool
        // messages below rather than needing a non-null assertion.
        const resolved = m.tool_calls.filter(
          (t): t is typeof t & { output: string } => t.output !== undefined,
        );
        const calls: ToolCall[] = resolved.map((t) => ({
          id: t.call_id,
          type: "function" as const,
          function: { name: t.tool, arguments: JSON.stringify(t.args) },
        }));
        if (!m.text && calls.length === 0) continue;
        items.push({
          kind: "msgs",
          msgs: [
            { role: "assistant", content: m.text || null, ...(calls.length ? { tool_calls: calls } : {}) },
            ...resolved.map((t) => ({ role: "tool" as const, tool_call_id: t.call_id, content: t.output })),
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

  const replayed = items.slice(lastSummaryIdx + 1);
  const attachmentTurns = replayed
    .filter((i): i is Extract<Item, { kind: "user" }> => i.kind === "user")
    .map((i) => i.atts);
  const affordable =
    attachmentTurns.length > 0 ? await selectAffordableAttachments(attachmentTurns) : undefined;

  const out: ChatMessage[] = [];
  for (const item of replayed) {
    if (item.kind === "msgs") out.push(...item.msgs);
    else if (item.kind === "user") {
      out.push({
        role: "user",
        content: await attachmentContentParts(item.atts, item.text, affordable, (a, fullText) =>
          writeOverflowToSandbox(conversationId, a, fullText),
        ),
      });
    }
  }
  const truncated = out.length > HISTORY_LIMIT;
  const capped = out.slice(-HISTORY_LIMIT);
  // A head cut can behead an assistant-with-calls, leaving its tool messages
  // orphaned at the front — drop those or the backend rejects the list.
  while (capped.length && capped[0].role === "tool") capped.shift();
  return { messages: capped, truncated, summaryText };
}
