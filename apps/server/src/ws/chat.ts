import type { FastifyInstance } from "fastify";
import { auth } from "../auth";
import { findCommand, type ClientMessage, type ServerMessage } from "@shannon/types";
import { startChatRun } from "../streams/runs/chatRun.ts";
import { startCompactRun } from "../streams/runs/compactRun.ts";
import { createDelivery } from "./delivery.ts";
import { NotFoundError } from "../streams/authz.ts";
import { getRun } from "../streams/registry.ts";

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

      // Re-validate the session on every command, not just at connect — a
      // socket can live far longer than a token's lifetime. A revoked or
      // expired session then loses the connection at the next command
      // instead of staying authenticated for as long as the socket happens
      // to stay open.
      const fresh = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (!fresh) {
        socket.close(4001, "Session expired");
        return;
      }
      userId = fresh.user.id;

      try {
        if (msg.type === "chat.send") {
          if (typeof msg.content !== "string" || !msg.content.trim()) {
            safeSend({ type: "error", error: "Content required" });
            return;
          }
          const result = await startChatRun({
            userId,
            content: msg.content,
            model: msg.model || "default",
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
        } else if (msg.type === "command.run") {
          // The registry is the authority — the same list the client's
          // palette renders. `compact` is the only entry today; the palette
          // never offers anything else, so an unknown name here is a bug or
          // a hand-rolled client, and an explicit error beats silence.
          const cmd = findCommand(msg.command ?? "");
          if (!cmd || cmd.name !== "compact") {
            safeSend({ type: "error", error: `Unknown command: ${msg.command}` });
            return;
          }
          if (!msg.conversation_id) {
            safeSend({ type: "error", error: "Nothing to compact — start a conversation first" });
            return;
          }
          const result = await startCompactRun({
            userId,
            conversationId: msg.conversation_id,
            model: msg.model || "default",
            args: msg.args,
            surface: "chat",
          });
          safeSend({
            type: "turn.started",
            stream_id: result.streamId,
            conversation_id: result.conversationId,
            // No user message exists for a command — the summary message is
            // the run's root, and the client only uses this for correlation.
            user_message_id: result.summaryMessageId,
            incognito: result.incognito,
          });
          await delivery.autoSubscribe(result.streamId, result.conversationId);
        } else if (msg.type === "stream.subscribe") {
          await delivery.handleSubscribe(msg.conversation_id, msg.cursors);
        } else if (msg.type === "stream.stop") {
          // Silently no-op for an unknown/foreign/already-finished stream —
          // matches "no existence oracle": a wrong-owner stop must look
          // identical to a stop for a stream that never existed.
          const run = getRun(msg.stream_id);
          if (run && run.userId === userId) run.abort.abort();
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
