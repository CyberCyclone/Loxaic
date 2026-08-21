import type { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { eq } from "@shannon/db";
import { db } from "@shannon/db";
import { auth } from "../auth";
import { messages, conversations } from "@shannon/db/schema";
import { usageRecords } from "@shannon/db/schema";
import { streamCompletion } from "../inference/provider";
import { TOOLS, toolRequiresApproval, type ToolName, type PermissionMode } from "@shannon/agent";
import type { ContentBlock } from "@shannon/types";

export function agentWsHandler(app: FastifyInstance) {
  app.get("/ws/agent", { websocket: true }, async (connection, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) return connection.socket.close(4001, "Missing token");

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
    });
    if (!session) return connection.socket.close(4001, "Invalid session");
    const userId = session.user.id;

    let currentMode: PermissionMode = "manual";
    let approvalQueue: Map<string, { resolve: (approved: boolean) => void }> = new Map();

    connection.socket.on("message", async (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "agent.send") {
        const { content, conversation_id, parent_id, mode } = msg as {
          content: string; conversation_id?: string; parent_id?: string; mode?: PermissionMode;
        };
        if (mode) currentMode = mode;

        let convId = conversation_id;
        if (!convId) {
          const title = content.slice(0, 80);
          const [conv] = await db.insert(conversations).values({ ownerId: userId, title, kind: "agent" }).returning();
          convId = conv.id;
        }

        // Create user message
        const userMsgId = uuid();
        await db.insert(messages).values({
          id: userMsgId, conversationId: convId, parentId: parent_id || null,
          authorType: "user", authorUserId: userId, origin: "server",
          lamport: Date.now(), content: [{ kind: "text", text: content }], status: "complete",
          createdAt: new Date(),
        });
        connection.socket.send(JSON.stringify({ type: "agent.conversation", conversation_id: convId }));

        // Build system prompt with tools
        const systemPrompt = currentMode === "planning"
          ? "You are in PLANNING mode. Read the codebase, analyze the task, and produce a detailed plan. Do NOT write any code. Output your plan as text."
          : `You are a coding agent. You have access to these tools:\n${JSON.stringify(TOOLS, null, 2)}\n\nWhen the user asks you to do something, think step by step and use tools to complete the task. Explain your reasoning as you go.`;

        const messagesList = [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content },
        ];

        const assistantMsgId = uuid();
        await db.insert(messages).values({
          id: assistantMsgId, conversationId: convId, parentId: userMsgId,
          authorType: "assistant", origin: "server", model: "agent",
          lamport: Date.now() + 1, content: [{ kind: "text", text: "" }],
          status: "streaming", createdAt: new Date(),
        });

        try {
          let fullText = "";
          for await (const event of streamCompletion("default", messagesList)) {
            if (event.type === "delta") {
              fullText += event.content;
              connection.socket.send(JSON.stringify({ type: "agent.delta", text: event.content }));
            } else if (event.type === "done") {
              await db.update(messages).set({
                content: [{ kind: "text", text: fullText }], status: "complete",
              }).where(eq(messages.id, assistantMsgId));

              await db.insert(usageRecords).values({
                id: uuid(), userId, conversationId: convId, messageId: assistantMsgId, model: "agent",
                origin: "server", inputTokens: event.result.usage.prompt_tokens,
                cachedTokens: event.result.timings?.cache_n || 0,
                outputTokens: event.result.usage.completion_tokens,
                promptMs: event.result.timings?.prompt_ms || null,
                predictMs: event.result.timings?.predicted_ms || null,
                totalMs: event.result.timings?.total_ms || null,
                promptTps: event.result.timings?.prompt_per_second || null,
                predictedTps: event.result.timings?.predicted_per_second || null,
              });

              connection.socket.send(JSON.stringify({
                type: "agent.done", text: fullText, usage: event.result.usage,
              }));
            }
          }
        } catch (err) {
          await db.update(messages).set({ status: "error" }).where(eq(messages.id, assistantMsgId));
          connection.socket.send(JSON.stringify({ type: "agent.error", error: (err as Error).message }));
        }
      }

      if (msg.type === "agent.mode") {
        currentMode = (msg as { mode: PermissionMode }).mode;
        connection.socket.send(JSON.stringify({ type: "agent.mode_changed", mode: currentMode }));
      }

      if (msg.type === "agent.approve") {
        const { call_id } = msg as { call_id: string };
        const pending = approvalQueue.get(call_id);
        if (pending) pending.resolve(true);
      }

      if (msg.type === "agent.deny") {
        const { call_id } = msg as { call_id: string };
        const pending = approvalQueue.get(call_id);
        if (pending) pending.resolve(false);
      }
    });
  });
}