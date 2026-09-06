import { v4 as uuid } from "uuid";
import { and, count, db, eq, gt } from "@loxaic/db";
import { conversations, messages, usageRecords, userPrefs } from "@loxaic/db/schema";
import { sanitizeFilename, type AttachmentRef, type ContentBlock, type ContextBreakdown, type TurnUsage } from "@loxaic/types";
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
import { fingerprintPrompt, measureReuse, recordPrompt, type PromptReuse } from "../../inference/prompt-reuse.ts";
import type { PermissionMode, ToolName } from "@loxaic/agent";
import { executeTool, toolNeedsSandbox, type ToolResult } from "../../agent/executor.ts";
import {
  attachActiveSandbox,
  getConversationSandbox,
  hasActiveSandbox,
  hasOverflowWrite,
  markOverflowWritten,
} from "../../agent/sandbox-manager.ts";
import { buildToolset, type Toolset } from "../../mcp/registry.ts";
import { shouldAutoCompact, userAllowsAutoCompact } from "./auto-compact.ts";
import type { StreamProducer } from "../broker.ts";
import { getRun, unregisterRun } from "../registry.ts";

/**
 * Tool round-trips one user message may take, when the user has expressed no
 * preference. Also the ceiling the API clamps to — in auto mode nothing else
 * asks permission, so this is the only thing standing between a confused model
 * and an unbounded amount of work.
 */
export const DEFAULT_MAX_ITERATIONS = 20;
export const MIN_MAX_ITERATIONS = 1;
export const MAX_MAX_ITERATIONS = 50;
/** An approval request left unanswered this long is treated as a denial. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * The smallest number of prior messages the replay window is ever narrowed
 * to. It is a floor, not a fixed size — see `historyAnchor`.
 */
export const HISTORY_LIMIT = 50;

/**
 * How far the window's oldest edge jumps when it finally has to move.
 *
 * A window of exactly HISTORY_LIMIT messages that slides by one on every turn
 * destroys the backend's prompt cache: the prompt no longer *starts* with the
 * same tokens, so llama.cpp/LM Studio re-evaluate the entire history from
 * scratch, every single turn, for the life of the conversation. Measured on a
 * 14.5k-token thread against a local LM Studio: 312 ms when the window held
 * still versus 14,551 ms the turn one message fell off the front — a 45×
 * difference that grows with the conversation.
 *
 * So the window is allowed to *grow* from HISTORY_LIMIT up to
 * HISTORY_LIMIT + HISTORY_STEP - 1 messages, and only re-anchors — paying one
 * full prompt evaluation — once every HISTORY_STEP messages. Every turn in
 * between extends a prefix the backend already has cached.
 */
export const HISTORY_STEP = 25;

/**
 * The oldest message this turn replays, as an offset from the oldest message
 * available (0 = replay everything). Quantised to HISTORY_STEP so it is a
 * *stable* function of the conversation's length rather than a value that
 * drifts by one per message: it holds still for HISTORY_STEP messages at a
 * time, which is what keeps the prompt prefix — and so the backend's KV cache
 * — intact across turns.
 *
 * Exported for the tests that pin the quantisation; `loadHistory` is the only
 * caller.
 */
export function historyAnchor(total: number): number {
  if (total <= HISTORY_LIMIT) return 0;
  return Math.max(0, Math.floor((total - HISTORY_LIMIT) / HISTORY_STEP) * HISTORY_STEP);
}

/**
 * The wire shapes for a tool exchange — built here and nowhere else.
 *
 * The live loop appends these to `chatMessages` as a run proceeds; `loadHistory`
 * rebuilds them from stored blocks on the next turn. If the two ever differ by
 * so much as a key, the next prompt is not a prefix of the last one, the
 * backend re-evaluates from the first tool call in the window, and
 * `reusable_tokens` records 0 for every turn after it — the anchored-window
 * work upstream undone by a serialisation mismatch.
 *
 * They *did* differ, in two ways. The loop sent the model's verbatim
 * `arguments` string and a `name` on the tool message; the replay sent
 * `JSON.stringify` of the parsed args and no `name`.
 *
 * Matching the code was not sufficient on its own: the replayed args come back
 * through Postgres **jsonb, which does not preserve key order** — it re-sorts
 * by key length and bytes — so `{"command":…,"cwd":…}` returns as
 * `{"cwd":…,"command":…}` and re-serialises to different bytes no matter how
 * carefully both call sites are written. Hence `canonicalJson`: order the keys
 * deterministically on both paths and the round-trip stops mattering. The JSON
 * is semantically identical either way, so the model is unaffected.
 */
function canonicalJson(value: unknown): string {
  // undefined can't reach here: object entries are filtered below, and the
  // top-level caller always passes an object.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function toolCallsForPrompt(calls: { id: string; name: string; args: unknown }[]): ToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: canonicalJson(c.args ?? {}) },
  }));
}

export function assistantMessageForPrompt(text: string, calls: ToolCall[]): ChatMessage {
  // Trimmed *here*, in the shared builder, rather than by one caller.
  // `loadHistory` reads assistant text through `textOf`, which trims; the live
  // loop passes the raw accumulated deltas, which do not. A model ending its
  // text with "\n" before a tool call — routine — therefore sent
  // `content: "Running it.\n"` during the run and `content: "Running it."` on
  // the next one, breaking the prefix at that message and recording
  // reusable_tokens: 0 for the turn after it. Whitespace-only text was worse:
  // live sent "\n" (truthy) where the replay sent null.
  const content = text.trim();
  // Key order matters as well as content: prompt fingerprints hash each
  // message with JSON.stringify, so two objects that differ only in key order
  // hash differently.
  return { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function toolResultMessageForPrompt(callId: string, name: string | undefined, output: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, ...(name === undefined ? {} : { name }), content: output };
}

/**
 * This user's tool-iteration ceiling, clamped to the supported range.
 *
 * Clamped on read as well as on write: the column is plain data, and a value
 * that arrived any other way (a migration, a hand-edited row, a future admin
 * tool) must not be able to remove the only brake auto mode has. A failed
 * lookup falls back to the default rather than to "unlimited".
 */
async function userMaxIterations(userId: string): Promise<number> {
  try {
    const row = await db.query.userPrefs.findFirst({
      where: eq(userPrefs.userId, userId),
      columns: { maxIterations: true },
    });
    const value = row?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    return Math.min(MAX_MAX_ITERATIONS, Math.max(MIN_MAX_ITERATIONS, value));
  } catch {
    return DEFAULT_MAX_ITERATIONS;
  }
}

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

/** Skip cards are `summary`-authored but textless, and must never act as a
 * compaction cutoff — hence a bounded lookback rather than "the newest". */
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
  /** Which surface started this run. Only needed so an automatic compaction
   * opens its stream on the same one. */
  surface: "chat" | "agent";
  abort: AbortController;
  producer: StreamProducer;
}): Promise<void> {
  const { streamId, convId, userId, model, mode, abort, producer } = ctx;

  // Decided inside the loop, acted on outside it: startCompactRun takes the
  // per-conversation lock this run is still holding until `finally` releases
  // it, so triggering in place would refuse itself with "already in progress".
  let autoCompact = false;

  try {
    const maxIterations = await userMaxIterations(userId);
    const toolset = await buildToolset(userId, { mode, conversationId: convId });
    const tools = toolset.openAiTools;
    // History is loaded before the system prompt is assembled, because whether
    // this turn carries a document decides whether the document addendum goes
    // in — the same pairing MCP has, where wrapResult's markers are only
    // meaningful alongside an addendum saying what they mean.
    const history = await loadHistory(convId);
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

    // Per-message hashes from the previous iteration; safe to reuse because
    // `chatMessages` is only ever appended to below.
    let carriedHashes: readonly string[] | undefined;

    let parentId = ctx.userMsgId;
    let lastAssistantId: string | null = null;
    let finished = false;
    // Set when any iteration triggered a JIT load, so the cached model list —
    // and with it the context window — can be dropped before the client refreshes.
    let jitLoaded = false;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (abort.signal.aborted) break;
      producer.emit({ kind: "iteration", n: iteration, max: maxIterations });

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
      // Fingerprint the exact payload about to go out — same reason the tally
      // is taken here rather than once per run: `chatMessages` grows as tool
      // calls and results are appended, and each iteration is its own request
      // with its own prefix relationship to the one before it.
      //
      // Hashes from the previous iteration are carried forward: `chatMessages`
      // is append-only within a run, and re-hashing it whole each time meant
      // re-reading every inlined image data URI on every iteration. See
      // fingerprintPrompt for the guarantee this relies on.
      const fingerprint = fingerprintPrompt(model, chatMessages, tools, carriedHashes);
      carriedHashes = fingerprint.messageHashes;
      const reuse = measureReuse(convId, fingerprint);
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
            recordPrompt(convId, fingerprint, event.result.usage.prompt_tokens);
            await recordUsage({
              runId: streamId,
              userId,
              convId,
              messageId: assistantMsgId,
              model,
              result: event.result,
              reuse,
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
        // A text-only model choking on image parts is a user-fixable
        // situation, not an outage — say so instead of relaying the backend's
        // phrasing, which is different for every runtime.
        const raw = (err as Error).message;
        const errorMessage = !isAbort && hadImages ? (visionErrorMessage(raw) ?? raw) : raw;
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
              ttft_ms: doneResult.ttftMs,
              cached_tokens: doneResult.cachedTokens,
              reusable_tokens: reuse.tokens,
              ...(history.omittedAttachments.length
                ? { omitted_attachments: history.omittedAttachments }
                : {}),
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
        // Checked here rather than before the next turn starts: this is the
        // one point where the *measured* size of the prompt and the window it
        // was assembled against are both in hand. The threshold leaves room
        // for the turn that follows, which is what makes acting after the
        // fact safe.
        autoCompact = shouldAutoCompact({
          usedTokens: doneResult ? doneResult.usage.prompt_tokens + doneResult.usage.completion_tokens : 0,
          windowTokens: breakdownMeta.windowTokens ?? null,
          historyMessages: history.messages.length,
        });
        producer.emit({ kind: "message.end", message_id: assistantMsgId, status: "complete", usage });
        await producer.end("complete", { usage });
        break;
      }

      // toolCalls.length > 0: message.end is deferred — the run continues
      // (tool results still need to land on this message before it's done).
      // Normalised through the same builder the replay uses — see
      // toolCallsForPrompt for what drifting apart costs.
      const promptCalls = toolCallsForPrompt(
        toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: safeParseArgs(c.function.arguments) })),
      );
      chatMessages.push(assistantMessageForPrompt(text, promptCalls));
      parentId = assistantMsgId;

      // ── Run each requested tool ───────────────────────────
      const resultBlocks: ContentBlock[] = [];
      for (const call of toolCalls) {
        const outcome = await runOneToolCall({ streamId, convId, userId, mode, toolset, producer, assistantMsgId }, call);
        resultBlocks.push({
          kind: "tool_result",
          call_id: call.id,
          output: outcome.output,
          ...(outcome.diff ? { diff: outcome.diff } : {}),
        });
        chatMessages.push(toolResultMessageForPrompt(call.id, call.function.name, outcome.output));
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
        error: `Stopped after ${String(maxIterations)} tool iterations without a final answer.`,
      });
    }
  } finally {
    unregisterRun(streamId);
  }

  // Past the `finally`, so the lock is free. Deliberately not reached by the
  // error and cancel paths above, which `return` — a run that failed has not
  // established what the prompt costs, and compacting after a user pressed
  // stop would be the opposite of what they asked for.
  // The pref is checked here rather than beside shouldAutoCompact so an
  // ordinary turn never pays for the query — only a turn that has already
  // decided it wants to compact asks whether it may.
  if (autoCompact && (await userAllowsAutoCompact(userId))) {
    try {
      // Dynamic on purpose: compactRun imports this module's history loader,
      // so a static import here would close a cycle between the two. See
      // auto-compact.ts.
      const { startCompactRun } = await import("./compactRun.ts");
      await startCompactRun({ userId, conversationId: convId, model, surface: ctx.surface, auto: true });
    } catch (err) {
      // Best-effort. A refused lock (the user sent again the instant the turn
      // ended) or a backend hiccup must not surface as a failure of the turn
      // that already succeeded — the threshold will simply be met again next
      // time.
      console.warn(`auto-compaction skipped for ${convId}: ${(err as Error).message}`);
    }
  }
}

/** Approval gate + execution for a single model-requested tool call. */
async function runOneToolCall(
  ctx: { streamId: string; convId: string; userId: string; mode: PermissionMode; toolset: Toolset; producer: StreamProducer; assistantMsgId: string },
  call: ToolCall,
): Promise<{ output: string; diff?: { path: string; oldContent: string | null; newContent: string | null }[] }> {
  const { convId, userId, mode, toolset, producer, assistantMsgId } = ctx;
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
  reuse: PromptReuse;
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
    // Null, not 0, when the backend says nothing — see the column's comment.
    cachedTokens: result.cachedTokens,
    reusableTokens: input.reuse.tokens,
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
 * blocks are dropped (display-only), and tool calls and results that lost
 * their partner are stripped in both directions — an interrupted run leaves a
 * dangling call, and the window's oldest edge can orphan a result; most
 * servers reject either.
 *
 * The replayed window is anchored, not sliding: its oldest edge is quantised
 * to HISTORY_STEP so that consecutive turns send a prompt the previous turn's
 * prompt is a *prefix* of, which is the whole basis of the backend's KV
 * cache. See HISTORY_STEP for what a per-message slide costs.
 */
export async function loadHistory(
  conversationId: string,
): Promise<{
  messages: ChatMessage[];
  truncated: boolean;
  summaryText: string | null;
  /** Attachments this prompt left out because their class's budget was full.
   * The model is told (`attachmentContentParts` substitutes a marker), and
   * this is how the *user* gets told too — without it the thumbnail sits in
   * the transcript looking exactly like one the model can see. */
  omittedAttachments: AttachmentRef[];
}> {
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

  const replayable = summaryRow
    ? and(eq(messages.conversationId, conversationId), gt(messages.lamport, summaryRow.lamport))
    : eq(messages.conversationId, conversationId);

  // A real COUNT(*), where the old code inferred "is there more?" from a
  // limit+1 fetch. The window's oldest edge has to be a stable function of
  // how long the conversation is (historyAnchor), and that needs the actual
  // length — an over-fetch by one can only answer the yes/no. One indexed
  // count per run (not per tool iteration) is a fair price for a prompt
  // prefix the backend can cache.
  const [{ total }] = await db
    .select({ total: count() })
    .from(messages)
    .where(replayable);

  const anchor = historyAnchor(total);
  const windowSize = total - anchor;
  const truncated = anchor > 0;

  const rows = windowSize > 0
    ? await db.query.messages.findMany({
        where: replayable,
        orderBy: (msgs, { desc }) => [desc(messages.lamport), desc(msgs.createdAt)],
        columns: { authorType: true, content: true, status: true, lamport: true },
        limit: windowSize,
      })
    : [];
  const ordered = rows.reverse();

  // Call ids in both directions. `resolvedCallIds` strips an assistant's
  // dangling tool_call (an interrupted run) — but the window's oldest edge
  // can equally cut the other way, leaving a tool_result whose assistant
  // tool_call fell outside it. A `role: "tool"` message with no preceding
  // call is rejected outright by most backends, so `presentCallIds` drops
  // those too. Both sets are collected before anything is emitted, because
  // the rows they describe are interleaved.
  const resolvedCallIds = new Set<string>();
  const presentCallIds = new Set<string>();
  // A tool_result block stores no tool name, but the live loop puts one on the
  // message it sends — so the name has to come from the assistant's matching
  // tool_call block or the two shapes diverge.
  const callNames = new Map<string, string>();
  for (const row of ordered) {
    for (const block of row.content as ContentBlock[]) {
      if (row.authorType === "tool" && block.kind === "tool_result") resolvedCallIds.add(block.call_id);
      if (row.authorType === "assistant" && block.kind === "tool_call") {
        presentCallIds.add(block.call_id);
        callNames.set(block.call_id, block.tool);
      }
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
  // Same verdict `attachmentContentParts` acts on below, so the two can't
  // disagree about what was sent. De-duplicated by ref: one file dropped is
  // one thing to tell the user, however many turns repeated it.
  const omittedAttachments = affordable
    ? [...new Map(
        attachmentTurns
          .flat()
          .filter((a) => !affordable.has(a.ref))
          .map((a) => [a.ref, a] as const),
      ).values()]
    : [];

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
      const calls = toolCallsForPrompt(
        blocks
          .filter((b): b is Extract<ContentBlock, { kind: "tool_call" }> => b.kind === "tool_call")
          .filter((b) => resolvedCallIds.has(b.call_id))
          .map((b) => ({ id: b.call_id, name: b.tool, args: b.args })),
      );
      if (!text && calls.length === 0) continue;
      out.push(assistantMessageForPrompt(text, calls));
      continue;
    }

    if (row.authorType === "tool") {
      for (const block of blocks) {
        if (block.kind !== "tool_result") continue;
        if (!presentCallIds.has(block.call_id)) continue;
        out.push(toolResultMessageForPrompt(block.call_id, callNames.get(block.call_id), block.output));
      }
    }
  }
  return { messages: out, truncated, summaryText, omittedAttachments };
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
    // Written once per (sandbox, ref), not once per turn. loadHistory runs
    // before every model call, so without this a conversation carrying one
    // overflowing document would base64 and re-stream its whole cached text
    // (up to MAX_CACHED_EXTRACTION_BYTES, ~5.3 MB on the wire) into the
    // container on every single turn, for the life of the conversation. The
    // content is immutable — keyed on a.ref, and the sidecar never changes —
    // so re-writing it can only ever reproduce the same bytes.
    if (hasOverflowWrite(handle.ref, a.ref)) return `./${relPath}`;
    await handle.writeFileBinary(`${handle.workdir}/${relPath}`, Buffer.from(fullText, "utf8"));
    markOverflowWritten(handle.ref, a.ref);
    return `./${relPath}`;
  } catch {
    // Writing the overflow is a nicety, not a requirement — a failure here
    // (sandbox mid-stop, disk full) must degrade to the pathless note, never
    // fail the run.
    return null;
  }
}

