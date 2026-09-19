import type { FastifyInstance } from "fastify";
import { resolveSessionFromToken } from "../auth/middleware";
import { findCommand, validateSendAttachments, type ClientMessage, type ServerMessage } from "@loxaic/types";
import { startAgentRun } from "../streams/runs/agentRun.ts";
import { startCompactRun } from "../streams/runs/compactRun.ts";
import { createDelivery } from "./delivery.ts";
import { NotFoundError, atLeast, resolveAccess } from "../streams/authz.ts";
import { findRunsByApprovalCallId, isStepsDecision, getRun } from "../streams/registry.ts";

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

export function agentWsHandler(app: FastifyInstance) {
  app.get("/ws/agent", { websocket: true }, async (socket: WsConnection, request) => {
    // See ws/chat.ts for why this must happen before the async auth check.
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

      // See ws/chat.ts — re-validated per command, not just at connect.
      const fresh = await resolveSessionFromToken(token);
      if (!fresh) {
        socket.close(4001, "Session expired");
        return;
      }
      userId = fresh.user.id;

      try {
        if (msg.type === "agent.send") {
          // Incognito was removed in #74, but a native build installed before
          // that still has the toggle. Refuse rather than silently persist: a
          // user who turned Incognito on and got a Postgres row for it has been
          // told the opposite of what happened. Checked as `=== true`, not
          // `"incognito" in msg` — every pre-#74 client sends the key with
          // `false` on ordinary sends, so a presence check would reject all of
          // them.
          if ((msg as { incognito?: unknown }).incognito === true) {
            safeSend({
              type: "error",
              error: "Incognito chat is no longer available — please update your app.",
            });
            return;
          }
          const sendError = validateSendAttachments(msg.content, msg.attachments);
          if (sendError) {
            safeSend({ type: "error", error: sendError });
            return;
          }
          const result = await startAgentRun({
            userId,
            content: msg.content,
            model: msg.model ?? "default",
            mode: (msg.mode ?? "manual"),
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
          // See ws/chat.ts — same dispatch, agent surface: the compact run
          // reads history through the agent's own loader.
          const cmd = findCommand(msg.command);
          if (cmd?.name !== "compact") {
            safeSend({ type: "error", error: `Unknown command: ${msg.command}` });
            return;
          }
          if (!msg.conversation_id) {
            safeSend({ type: "error", error: "Nothing to compact — start a run first" });
            return;
          }
          const result = await startCompactRun({
            userId,
            conversationId: msg.conversation_id,
            model: msg.model ?? "default",
            args: msg.args,
            surface: "agent",
          });
          safeSend({
            type: "turn.started",
            stream_id: result.streamId,
            conversation_id: result.conversationId,
            user_message_id: result.summaryMessageId,
          });
          await delivery.autoSubscribe(result.streamId, result.conversationId);
        } else if (msg.type === "stream.subscribe") {
          await delivery.handleSubscribe(msg.conversation_id, msg.cursors);
        } else if (msg.type === "stream.stop") {
          const run = getRun(msg.stream_id);
          if (run && (await mayActOnRun(userId, run.conversationId))) run.abort.abort();
        } else if (msg.type === "agent.mode") {
          // Modes are carried explicitly on every agent.send; this is just a
          // UI-preference echo, not durable server state.
          safeSend({ type: "agent.mode_changed", mode: msg.mode });
        } else if (msg.type === "agent.approve" || msg.type === "agent.deny") {
          // Several runs can hold the same model-supplied call_id (see the
          // registry). Answer the first one this user is allowed to act on,
          // not the first one found.
          for (const run of findRunsByApprovalCallId(msg.call_id)) {
            if (!(await mayActOnRun(userId, run.conversationId))) continue;
            const resolve = run.approvals.get(msg.call_id);
            if (resolve) {
              run.approvals.delete(msg.call_id);
              resolve(msg.type === "agent.approve");
            }
            break;
          }
          // Silently no-op otherwise — unknown/foreign/already-resolved
          // call_id, same "no existence oracle" rule as stream.stop.
        } else if (msg.type === "agent.steps") {
          // Answering a step check-in. Keyed by stream_id rather than a
          // model-supplied id, so unlike approve/deny there is exactly one run
          // it could mean and no plural lookup is needed.
          const run = getRun(msg.stream_id);
          const resolve = run?.stepsDecision;
          if (
            run &&
            resolve &&
            isStepsDecision(msg.decision) &&
            (await mayActOnRun(userId, run.conversationId))
          ) {
            run.stepsDecision = undefined;
            resolve(msg.decision, userId);
          }
          // Silently no-op otherwise — a run that is not parked, not theirs,
          // or already answered, same "no existence oracle" rule as
          // stream.stop. `decision` is a claim off a socket, so it is checked
          // here rather than trusted from the type.
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
