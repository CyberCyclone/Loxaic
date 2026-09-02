import type { FastifyInstance } from "fastify";
import { resolveSessionFromToken } from "../auth/middleware";
import { findCommand, validateSendAttachments, type ClientMessage, type ServerMessage } from "@shannon/types";
import { startChatRun } from "../streams/runs/chatRun.ts";
import { startCompactRun } from "../streams/runs/compactRun.ts";
import { createDelivery } from "./delivery.ts";
import { NotFoundError, atLeast, resolveAccess } from "../streams/authz.ts";
import { findRunByApprovalCallId, getRun } from "../streams/registry.ts";

/** Minimal shape of the underlying `ws` socket we actually touch. `ws` ships
 * no type declarations of its own (and none are installed here), so without
 * this, everything @fastify/websocket hands us as `socket` resolves to `any`. */
interface WsConnection {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  pause(): void;
  resume(): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
}

/**
 * May this user act on this run — stop it, or answer its tool approvals?
 *
 * Editor or better on the run's *conversation*, not "did you start it". A
 * conversation shared for editing has more than one legitimate participant,
 * and the run's starter may well have gone offline mid-run (runs deliberately
 * outlive the socket that began them). A viewer must never reach either path.
 *
 * Returns false rather than throwing: both callers deliberately no-op on
 * refusal, so an unauthorized stop is indistinguishable from a stop for a
 * stream that never existed.
 */
async function mayActOnRun(userId: string, conversationId: string): Promise<boolean> {
  const grant = await resolveAccess(userId, conversationId);
  return !!grant && atLeast(grant.role, "editor");
}

export function chatWsHandler(app: FastifyInstance) {
  app.get("/ws/chat", { websocket: true }, async (socket: WsConnection, request) => {
    // Pause the socket immediately: auth below is async, and a client that
    // sends its first message right after `open` can otherwise have that
    // frame parsed and emitted (to zero listeners) before we've attached
    // ours further down — silently dropping it. Resumed once we're ready.
    socket.pause();

    const url = new URL(request.url, `http://${request.headers.host ?? ""}`);
    const token = url.searchParams.get("token");
    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }

    const session = await resolveSessionFromToken(token);
    if (!session) {
      socket.close(4001, "Invalid session");
      return;
    }
    let userId = session.user.id;

    const safeSend = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const delivery = createDelivery(userId, safeSend, () => socket.bufferedAmount);
    socket.on("close", () => { delivery.close(); });

    const handleMessage = async (raw: Buffer): Promise<void> => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        safeSend({ type: "error", error: "Invalid JSON" });
        return;
      }

      // Re-validate the session on every command, not just at connect — a
      // socket can live far longer than a token's lifetime. A revoked or
      // expired session then loses the connection at the next command
      // instead of staying authenticated for as long as the socket happens
      // to stay open.
      const fresh = await resolveSessionFromToken(token);
      if (!fresh) {
        socket.close(4001, "Session expired");
        return;
      }
      userId = fresh.user.id;

      try {
        if (msg.type === "chat.send") {
          const sendError = validateSendAttachments(msg.content, msg.attachments);
          if (sendError) {
            safeSend({ type: "error", error: sendError });
            return;
          }
          const result = await startChatRun({
            userId,
            content: msg.content,
            model: msg.model ?? "default",
            conversationId: msg.conversation_id,
            parentId: msg.parent_id,
            attachments: msg.attachments ?? [],
          });
          safeSend({
            type: "turn.started",
            stream_id: result.streamId,
            conversation_id: result.conversationId,
            user_message_id: result.userMessageId,
          });
          await delivery.autoSubscribe(result.streamId, result.conversationId);
        } else if (msg.type === "command.run") {
          // The registry is the authority — the same list the client's
          // palette renders. `compact` is the only entry today; the palette
          // never offers anything else, so an unknown name here is a bug or
          // a hand-rolled client, and an explicit error beats silence.
          const cmd = findCommand(msg.command);
          if (cmd?.name !== "compact") {
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
            model: msg.model ?? "default",
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
          });
          await delivery.autoSubscribe(result.streamId, result.conversationId);
        } else if (msg.type === "stream.subscribe") {
          await delivery.handleSubscribe(msg.conversation_id, msg.cursors);
        } else if (msg.type === "stream.stop") {
          // Silently no-op for an unknown/foreign/already-finished stream —
          // matches "no existence oracle": a wrong-owner stop must look
          // identical to a stop for a stream that never existed.
          const run = getRun(msg.stream_id);
          if (run && (await mayActOnRun(userId, run.conversationId))) run.abort.abort();
        } else if (msg.type === "agent.approve" || msg.type === "agent.deny") {
          // Chat is tool-capable, so approvals resolve here too. Run-scoped
          // (registry), so any of the user's sockets — either surface, any
          // device — can answer.
          const run = findRunByApprovalCallId(msg.call_id);
          const resolve = run?.approvals.get(msg.call_id);
          if (run && resolve && (await mayActOnRun(userId, run.conversationId))) {
            run.approvals.delete(msg.call_id);
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
    };

    socket.on("message", (raw: Buffer) => { void handleMessage(raw); });

    socket.resume();
  });
}
