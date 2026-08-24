import type { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { db, desc, eq } from "@shannon/db";
import { conversations, messages, usageRecords } from "@shannon/db/schema";
import { auth } from "../auth";
import { streamCompletion, type ChatMessage, type ToolCall, type CompletionResult } from "../inference/provider";
import { listBackendModels } from "../inference/models";
import {
  isToolName,
  toOpenAiTools,
  toolRequiresApproval,
  WRITE_TOOLS,
  type AgentEvent,
  type PermissionMode,
  type ToolName,
} from "@shannon/agent";
import { executeTool, toolNeedsSandbox } from "../agent/executor";
import { getConversationSandbox } from "../agent/sandbox-manager";
import type { ContentBlock } from "@shannon/types";

/** Hard ceiling on tool round-trips per user message. */
const MAX_ITERATIONS = 20;
/** An approval request left unanswered this long is treated as a denial. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** How many prior messages to replay as context. */
const HISTORY_LIMIT = 50;

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

export function agentWsHandler(app: FastifyInstance) {
  app.get("/ws/agent", { websocket: true }, async (socket, request) => {
    // See ws/chat.ts for why this must happen before the async auth check.
    socket.pause();

    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) return socket.close(4001, "Missing token");

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    if (!session) return socket.close(4001, "Invalid session");
    const userId = session.user.id;

    let currentMode: PermissionMode = "manual";
    let busy = false;
    const approvalQueue = new Map<string, (approved: boolean) => void>();

    const send = (event: AgentEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    socket.on("close", () => {
      // Nobody is left to answer an approval prompt; fail them closed so the
      // in-flight run unwinds instead of hanging for the full timeout.
      for (const resolve of approvalQueue.values()) resolve(false);
      approvalQueue.clear();
    });

    socket.on("message", async (raw: Buffer) => {
      let msg: { type?: string; [key: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "agent.error", error: "Invalid JSON" });
        return;
      }

      if (msg.type === "agent.mode") {
        const mode = msg.mode;
        if (mode !== "planning" && mode !== "manual" && mode !== "auto") {
          send({ type: "agent.error", error: "Invalid mode" });
          return;
        }
        currentMode = mode;
        send({ type: "agent.mode_changed", mode });
        return;
      }

      if (msg.type === "agent.approve" || msg.type === "agent.deny") {
        const callId = msg.call_id;
        if (typeof callId !== "string") return;
        const resolve = approvalQueue.get(callId);
        if (resolve) {
          approvalQueue.delete(callId);
          resolve(msg.type === "agent.approve");
        }
        return;
      }

      if (msg.type !== "agent.send") return;

      const content = msg.content;
      if (typeof content !== "string" || !content.trim()) {
        send({ type: "agent.error", error: "Content required" });
        return;
      }
      if (busy) {
        send({ type: "agent.error", error: "A run is already in progress on this connection" });
        return;
      }
      if (msg.mode === "planning" || msg.mode === "manual" || msg.mode === "auto") {
        currentMode = msg.mode;
      }

      busy = true;
      try {
        await runTurn({
          send,
          userId,
          content,
          conversationId: typeof msg.conversation_id === "string" ? msg.conversation_id : undefined,
          parentId: typeof msg.parent_id === "string" ? msg.parent_id : undefined,
          model: typeof msg.model === "string" && msg.model ? msg.model : "default",
          getMode: () => currentMode,
          approvalQueue,
        });
      } catch (err) {
        send({ type: "agent.error", error: (err as Error).message });
      } finally {
        busy = false;
      }
    });

    socket.resume();
  });
}

type TurnContext = {
  send: (event: AgentEvent) => void;
  userId: string;
  content: string;
  conversationId?: string;
  parentId?: string;
  model: string;
  getMode: () => PermissionMode;
  approvalQueue: Map<string, (approved: boolean) => void>;
};

async function runTurn(ctx: TurnContext): Promise<void> {
  const { send, userId, content, model } = ctx;
  const runId = uuid();
  let lamport = Date.now();
  const nextLamport = () => ++lamport;

  // ── Conversation + user message ─────────────────────────
  let convId = ctx.conversationId;
  if (convId) {
    const owned = await db.query.conversations.findFirst({
      where: eq(conversations.id, convId),
      columns: { id: true, ownerId: true },
    });
    if (!owned || owned.ownerId !== userId) {
      send({ type: "agent.error", error: "Conversation not found" });
      return;
    }
  } else {
    const [conv] = await db
      .insert(conversations)
      .values({ ownerId: userId, title: content.slice(0, 80), kind: "agent" })
      .returning();
    convId = conv.id;
  }

  const userMsgId = uuid();
  await db.insert(messages).values({
    id: userMsgId,
    conversationId: convId,
    parentId: ctx.parentId || null,
    authorType: "user",
    authorUserId: userId,
    origin: "server",
    lamport: nextLamport(),
    content: [{ kind: "text", text: content }] as ContentBlock[],
    status: "complete",
    createdAt: new Date(),
  });
  send({ type: "agent.conversation", conversation_id: convId, message_id: userMsgId });

  // ── Context ─────────────────────────────────────────────
  const mode = ctx.getMode();
  const systemPrompt = mode === "planning" ? PLANNING_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT;
  const tools = toOpenAiTools(mode === "planning" ? WRITE_TOOLS : []);

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(await loadHistory(convId)),
  ];

  let parentId = userMsgId;
  let lastAssistantId: string | null = null;
  let finished = false;

  for (let iteration = 1; iteration <= MAX_ITERATIONS && !finished; iteration++) {
    send({ type: "agent.iteration", conversation_id: convId, iteration, max: MAX_ITERATIONS });

    const assistantMsgId = uuid();
    lastAssistantId = assistantMsgId;
    await db.insert(messages).values({
      id: assistantMsgId,
      conversationId: convId,
      parentId,
      authorType: "assistant",
      origin: "server",
      model,
      lamport: nextLamport(),
      content: [] as ContentBlock[],
      status: "streaming",
      createdAt: new Date(),
    });

    let text = "";
    let thinking = "";
    let toolCalls: ToolCall[] = [];
    let doneResult: CompletionResult | null = null;

    try {
      const backendModels = await listBackendModels();
      const targetModel = backendModels.find((m) => m.id === model);
      if (targetModel && !targetModel.loaded) {
        send({ type: "agent.model_loading", conversation_id: convId, message_id: assistantMsgId });
      }
    } catch {
      // Best-effort — fall back to the generic "thinking" indicator.
    }

    try {
      for await (const event of streamCompletion(model, chatMessages, { tools })) {
        if (event.type === "delta") {
          text += event.content;
          send({ type: "agent.delta", conversation_id: convId, message_id: assistantMsgId, text: event.content });
        } else if (event.type === "thinking") {
          thinking += event.content;
          send({ type: "agent.thinking", conversation_id: convId, message_id: assistantMsgId, text: event.content });
        } else if (event.type === "done") {
          toolCalls = event.result.toolCalls;
          doneResult = event.result;
          await recordUsage({
            runId, userId, convId, messageId: assistantMsgId, model, result: event.result,
          });
        }
      }
    } catch (err) {
      await db.update(messages).set({ status: "error" }).where(eq(messages.id, assistantMsgId));
      send({ type: "agent.error", conversation_id: convId, error: (err as Error).message });
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
      send({
        type: "agent.done",
        conversation_id: convId,
        message_id: assistantMsgId,
        text,
        usage: doneResult
          ? {
              ...doneResult.usage,
              prompt_tps: doneResult.promptTps,
              gen_tps: doneResult.genTps,
              total_ms: doneResult.totalMs,
            }
          : undefined,
      });
      break;
    }

    chatMessages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
    parentId = assistantMsgId;

    // ── Run each requested tool ───────────────────────────
    const resultBlocks: ContentBlock[] = [];
    for (const call of toolCalls) {
      const outcome = await runOneToolCall(ctx, convId, call);
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

    const toolMsgId = uuid();
    await db.insert(messages).values({
      id: toolMsgId,
      conversationId: convId,
      parentId: assistantMsgId,
      authorType: "tool",
      origin: "server",
      lamport: nextLamport(),
      content: resultBlocks,
      status: "complete",
      createdAt: new Date(),
    });
    parentId = toolMsgId;
  }

  if (!finished) {
    if (lastAssistantId) {
      await db
        .update(conversations)
        .set({ activeLeafId: lastAssistantId, updatedAt: new Date() })
        .where(eq(conversations.id, convId));
    }
    send({
      type: "agent.error",
      conversation_id: convId,
      error: `Stopped after ${MAX_ITERATIONS} tool iterations without a final answer.`,
    });
  }
}

/** Approval gate + execution for a single model-requested tool call. */
async function runOneToolCall(
  ctx: TurnContext,
  convId: string,
  call: ToolCall,
): Promise<{ output: string; diff?: { path: string; oldContent: string | null; newContent: string | null }[] }> {
  const { send } = ctx;
  const toolName = call.function.name;
  const args = safeParseArgs(call.function.arguments);

  if (!isToolName(toolName)) {
    const output = `Unknown tool "${toolName}". Available tools: see the tool list.`;
    send({ type: "agent.tool_call", conversation_id: convId, call_id: call.id, tool: toolName as ToolName, args });
    send({ type: "agent.tool_result", conversation_id: convId, call_id: call.id, tool: toolName as ToolName, output, ok: false });
    return { output };
  }

  send({ type: "agent.tool_call", conversation_id: convId, call_id: call.id, tool: toolName, args });

  if (toolRequiresApproval(toolName, ctx.getMode())) {
    send({ type: "agent.approval_request", conversation_id: convId, call_id: call.id, tool: toolName, args });
    const approved = await waitForApproval(ctx.approvalQueue, call.id);
    if (!approved) {
      const output = "User denied this tool call.";
      send({ type: "agent.tool_result", conversation_id: convId, call_id: call.id, tool: toolName, output, ok: false });
      return { output };
    }
  }

  let container = null;
  if (toolNeedsSandbox(toolName)) {
    try {
      container = await getConversationSandbox(ctx.userId, convId);
    } catch (err) {
      const output = `Could not start a sandbox: ${(err as Error).message}`;
      send({ type: "agent.tool_result", conversation_id: convId, call_id: call.id, tool: toolName, output, ok: false });
      return { output };
    }
  }

  const result = await executeTool(container, toolName, args);
  if (result.todos) {
    send({ type: "agent.todos", conversation_id: convId, todos: result.todos });
  }
  send({
    type: "agent.tool_result",
    conversation_id: convId,
    call_id: call.id,
    tool: toolName,
    output: result.output,
    ok: result.ok,
    ...(result.diff ? { diff: result.diff } : {}),
  });
  return { output: result.output, diff: result.diff };
}

function waitForApproval(
  queue: Map<string, (approved: boolean) => void>,
  callId: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      queue.delete(callId);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    queue.set(callId, (approved) => {
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
  result: {
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    timings: { cache_n?: number; prompt_ms: number; predicted_ms: number; total_ms?: number; prompt_per_second: number; predicted_per_second: number } | null;
    ttftMs: number | null;
    totalMs: number;
    promptTps: number | null;
    genTps: number | null;
  };
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
  });
}

/**
 * Rebuilds the OpenAI message list from stored content blocks.
 * Thinking blocks are dropped (they are display-only), and assistant tool
 * calls with no matching tool_result are stripped — an interrupted run would
 * otherwise leave a dangling call that most servers reject.
 */
async function loadHistory(conversationId: string): Promise<ChatMessage[]> {
  const rows = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: [desc(messages.lamport), desc(messages.createdAt)],
    columns: { authorType: true, content: true, status: true, lamport: true },
    limit: HISTORY_LIMIT,
  });
  const ordered = rows.reverse();

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
  return out;
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}
