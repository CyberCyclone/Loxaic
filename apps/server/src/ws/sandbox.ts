import type { FastifyInstance } from "fastify";
import { and, eq } from "@shannon/db";
import { db } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { auth } from "../auth";
import { getContainer } from "../sandbox/orchestrator";

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

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
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

    const container = getContainer(sandbox.containerId);

    const exec = await container.exec({
      Cmd: ["bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    const stream = await exec.start({ hijack: true, stdin: true });

    stream.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      socket.send(JSON.stringify({ type: "terminal.output", data: str }));
    });

    socket.on("message", (raw: Buffer) => {
      let msg: TerminalInputMessage;
      try {
        msg = JSON.parse(raw.toString()) as TerminalInputMessage;
      } catch {
        return;
      }
      if (msg.type === "terminal.input") {
        stream.write(Buffer.from(msg.data + "\n"));
      }
    });

    socket.on("close", () => {
      stream.end();
    });

    socket.resume();
  });
}
