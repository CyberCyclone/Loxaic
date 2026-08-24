import type { FastifyInstance } from "fastify";
import { eq } from "@shannon/db";
import { auth } from "../auth";
import { db } from "@shannon/db";
import { conversations, messages } from "@shannon/db/schema";
import { streamCompletion } from "../inference/provider";
import { listBackendModels } from "../inference/models";
import type { ContentBlock } from "@shannon/types";
import { v4 as uuid } from "uuid";
import { usageRecords } from "@shannon/db/schema";

export function chatWsHandler(app: FastifyInstance) {
  app.get("/ws/chat", { websocket: true }, async (socket, request) => {
    // Pause the socket immediately: auth below is async, and a client that
    // sends its first message right after `open` can otherwise have that
    // frame parsed and emitted (to zero listeners) before we've attached
    // ours further down — silently dropping it. Resumed once we're ready.
    socket.pause();

    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    if (!session) {
      socket.close(4001, "Invalid session");
      return;
    }
    const userId = session.user.id;

    socket.on("message", async (raw: Buffer) => {
      let msg: { type: string; [key: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "chat.error", error: "Invalid JSON" }));
        return;
      }

      if (msg.type === "chat.send") {
        const content = (msg as { content?: unknown }).content;
        const conversationId = (msg as { conversation_id?: string }).conversation_id;
        const parentId = (msg as { parent_id?: string }).parent_id;
        const model = ((msg as { model?: string }).model) || "default";

        if (typeof content !== "string" || !content.trim()) {
          socket.send(JSON.stringify({ type: "chat.error", error: "Content required" }));
          return;
        }

        let convId = conversationId;

        // Create conversation if needed
        if (!convId) {
          const title = content.slice(0, 80);
          const [conv] = await db
            .insert(conversations)
            .values({ ownerId: userId, title })
            .returning();
          convId = conv.id;
        }

        // Create user message
        const userMsgId = uuid();
        await db.insert(messages).values({
          id: userMsgId,
          conversationId: convId,
          parentId: parentId || null,
          authorType: "user",
          authorUserId: userId,
          origin: "server",
          lamport: Date.now(),
          content: [{ kind: "text", text: content }] as ContentBlock[],
          status: "complete",
          createdAt: new Date(),
        });

        // Notify client of new conversation
        socket.send(
          JSON.stringify({ type: "chat.conversation", conversation_id: convId, message_id: userMsgId })
        );

        // Build message context. Ordered *descending* so `limit` keeps the
        // most recent 50 (ascending + limit would send the oldest 50 and
        // silently drop everything the user just said in a long thread).
        const history = await db.query.messages.findMany({
          where: eq(messages.conversationId, convId),
          orderBy: (msgs, { desc }) => [desc(msgs.createdAt)],
          columns: { authorType: true, content: true },
          limit: 50,
        });
        history.reverse();

        const chatMessages = history
          .filter((h) => h.authorType === "user" || h.authorType === "assistant")
          .map((h) => ({
            role: (h.authorType === "user" ? "user" : "assistant") as "user" | "assistant",
            content: extractText(h.content as ContentBlock[]),
          }));

        // Create assistant message placeholder
        const assistantMsgId = uuid();
        await db.insert(messages).values({
          id: assistantMsgId,
          conversationId: convId,
          parentId: userMsgId,
          authorType: "assistant",
          origin: "server",
          model,
          lamport: Date.now() + 1,
          content: [{ kind: "text", text: "" }],
          status: "streaming",
          createdAt: new Date(),
        });

        // Update active leaf
        await db
          .update(conversations)
          .set({ activeLeafId: assistantMsgId, updatedAt: new Date() })
          .where(eq(conversations.id, convId));

        // Let the client distinguish "waiting on a JIT model load" from
        // ordinary generation latency — LM Studio can take many seconds to
        // load a model on first use of a completion request.
        try {
          const backendModels = await listBackendModels();
          const targetModel = backendModels.find((m) => m.id === model);
          if (targetModel && !targetModel.loaded) {
            socket.send(
              JSON.stringify({ type: "chat.model_loading", conversation_id: convId, message_id: assistantMsgId })
            );
          }
        } catch {
          // Best-effort — fall back to the generic "thinking" indicator.
        }

        // Stream from inference
        try {
          let fullText = "";
          let fullThinking = "";
          for await (const event of streamCompletion(model, chatMessages)) {
            if (event.type === "delta") {
              fullText += event.content;
              socket.send(
                JSON.stringify({
                  type: "chat.delta",
                  message_id: assistantMsgId,
                  conversation_id: convId,
                  delta: event.content,
                })
              );
            } else if (event.type === "thinking") {
              fullThinking += event.content;
              socket.send(
                JSON.stringify({
                  type: "chat.thinking",
                  message_id: assistantMsgId,
                  conversation_id: convId,
                  delta: event.content,
                })
              );
            } else if (event.type === "done") {
              // Update message with full content — reasoning (if any) as its
              // own block so it renders in the same collapsible thinking UI
              // as the agent flow, not lost or flattened into the answer.
              const blocks: ContentBlock[] = [];
              if (fullThinking) blocks.push({ kind: "thinking", text: fullThinking });
              blocks.push({ kind: "text", text: fullText });
              await db
                .update(messages)
                .set({
                  content: blocks,
                  status: "complete",
                })
                .where(eq(messages.id, assistantMsgId));

              // Record usage
              if (event.result.usage.total_tokens > 0 || event.result.timings) {
                await db.insert(usageRecords).values({
                  id: uuid(),
                  userId,
                  conversationId: convId,
                  messageId: assistantMsgId,
                  model,
                  origin: "server",
                  inputTokens: event.result.usage.prompt_tokens,
                  cachedTokens: event.result.timings?.cache_n || 0,
                  outputTokens: event.result.usage.completion_tokens,
                  ttftMs: event.result.ttftMs,
                  promptMs: event.result.timings?.prompt_ms || null,
                  predictMs: event.result.timings?.predicted_ms || null,
                  totalMs: event.result.totalMs,
                  promptTps: event.result.promptTps,
                  predictedTps: event.result.genTps,
                });
              }

              socket.send(
                JSON.stringify({
                  type: "chat.message_complete",
                  message_id: assistantMsgId,
                  conversation_id: convId,
                  usage: {
                    ...event.result.usage,
                    prompt_tps: event.result.promptTps,
                    gen_tps: event.result.genTps,
                    total_ms: event.result.totalMs,
                  },
                })
              );
            }
          }
        } catch (err) {
          const errorMessage = (err as Error).message;
          // Written into the message itself (not just sent as an event) so the
          // error shows up inline in the thread like any other reply, and
          // survives a reload instead of vanishing with a toast.
          await db
            .update(messages)
            .set({ content: [{ kind: "text", text: errorMessage }], status: "error" })
            .where(eq(messages.id, assistantMsgId));
          socket.send(
            JSON.stringify({
              type: "chat.error",
              conversation_id: convId,
              message_id: assistantMsgId,
              error: errorMessage,
            })
          );
        }
      }
    });

    socket.resume();
  });
}

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.kind === "text" || b.kind === "thinking")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}