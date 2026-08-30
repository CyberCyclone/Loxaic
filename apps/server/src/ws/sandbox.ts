import type { FastifyInstance } from "fastify";
import { and, eq } from "@shannon/db";
import { db } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { resolveSessionFromToken } from "../auth/middleware";
import { getProviderByKind } from "../sandbox/provider.ts";

/** Minimal shape of the underlying `ws` socket we actually touch. `ws` ships
 * no type declarations of its own (and none are installed here), so without
 * this, everything @fastify/websocket hands us as `socket` resolves to `any`. */
interface WsConnection {
  pause(): void;
  resume(): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
}

interface TerminalInputMessage {
  type: string;
  data: string;
}

export function sandboxTerminalWs(app: FastifyInstance) {
  app.get("/ws/sandbox/:id", { websocket: true }, async (socket: WsConnection, request) => {
    // See ws/chat.ts for why this must happen before the async auth check.
    socket.pause();

    const url = new URL(request.url, `http://${request.headers.host ?? ""}`);
    const token = url.searchParams.get("token");
    const { id } = request.params as { id: string };
    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }

    const session = await resolveSessionFromToken(token);
    if (!session) {
      socket.close(4001, "Invalid session");
      return;
    }

    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, id), eq(sandboxes.ownerId, session.user.id)),
    });
    if (!sandbox) {
      socket.close(4004, "Not found");
      return;
    }

    const provider = await getProviderByKind(sandbox.provider as "container" | "host");
    const handle = await provider.attach(sandbox.containerId);
    if (!handle.openTerminal) {
      socket.close(4400, "Terminal not supported for this sandbox");
      return;
    }
    const terminal = await handle.openTerminal();

    terminal.onData((data) => {
      socket.send(JSON.stringify({ type: "terminal.output", data }));
    });
    terminal.onClose(() => {
      socket.close();
    });

    socket.on("message", (raw: Buffer) => {
      let msg: TerminalInputMessage;
      try {
        msg = JSON.parse(raw.toString()) as TerminalInputMessage;
      } catch {
        return;
      }
      if (msg.type === "terminal.input") {
        terminal.write(msg.data + "\n");
      }
    });

    socket.on("close", () => {
      terminal.close();
    });

    socket.resume();
  });
}
