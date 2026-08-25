import type { FastifyInstance } from "fastify";
import { auth } from "../auth";
import type { ClientMessage, PermissionMode, ServerMessage } from "@shannon/types";
import { startAgentRun } from "../streams/runs/agentRun.ts";
import { createDelivery } from "./delivery.ts";
import { NotFoundError } from "../streams/authz.ts";
import { findRunByApprovalCallId, getRun } from "../streams/registry.ts";

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
    let userId = session.user.id;

    const safeSend = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const delivery = createDelivery(userId, safeSend, () => socket.bufferedAmount);
    socket.on("close", () => delivery.close());

    socket.on("message", async (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        safeSend({ type: "error", error: "Invalid JSON" });
        return;
      }

      // See ws/chat.ts — re-validated per command, not just at connect.
      const fresh = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (!fresh) {
        socket.close(4001, "Session expired");
        return;
      }
      userId = fresh.user.id;

      try {
        if (msg.type === "agent.send") {
          if (typeof msg.content !== "string" || !msg.content.trim()) {
            safeSend({ type: "error", error: "Content required" });
            return;
          }
          const result = await startAgentRun({
            userId,
            content: msg.content,
            model: msg.model || "default",
            mode: (msg.mode ?? "manual") as PermissionMode,
            conversationId: msg.conversation_id,
            parentId: msg.parent_id,
            incognito: msg.incognito,
          });
          safeSend({
            type: "turn.started",
            stream_id: result.streamId,
            conversation_id: result.conversationId,
            user_message_id: result.userMessageId,
            incognito: result.incognito,
          });
          await delivery.autoSubscribe(result.streamId, result.conversationId);
        } else if (msg.type === "stream.subscribe") {
          await delivery.handleSubscribe(msg.conversation_id, msg.cursors);
        } else if (msg.type === "stream.stop") {
          const run = getRun(msg.stream_id);
          if (run && run.userId === userId) run.abort.abort();
        } else if (msg.type === "agent.mode") {
          // Modes are carried explicitly on every agent.send; this is just a
          // UI-preference echo, not durable server state.
          safeSend({ type: "agent.mode_changed", mode: msg.mode });
        } else if (msg.type === "agent.approve" || msg.type === "agent.deny") {
          const run = findRunByApprovalCallId(userId, msg.call_id);
          const resolve = run?.approvals.get(msg.call_id);
          if (resolve) {
            run!.approvals.delete(msg.call_id);
            resolve(msg.type === "agent.approve");
          }
          // Silently no-op otherwise — unknown/foreign/already-resolved
          // call_id, same "no existence oracle" rule as stream.stop.
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          safeSend({ type: "error", error: "not found" });
        } else {
          safeSend({ type: "error", error: (err as Error).message });
        }
      }
    });

    socket.resume();
  });
}
