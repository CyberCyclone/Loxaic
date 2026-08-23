import type { FastifyInstance } from "fastify";
import { and, eq } from "@shannon/db";
import { db } from "@shannon/db";
import { sandboxes } from "@shannon/db/schema";
import { auth } from "../auth";
import { getContainer } from "../sandbox/orchestrator";

export function sandboxTerminalWs(app: FastifyInstance) {
  app.get("/ws/sandbox/:id", { websocket: true }, async (socket, request) => {
    // See ws/chat.ts for why this must happen before the async auth check.
    socket.pause();

    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    const { id } = request.params as { id: string };
    if (!token) return socket.close(4001, "Missing token");

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    if (!session) return socket.close(4001, "Invalid session");

    const sandbox = await db.query.sandboxes.findFirst({
      where: and(eq(sandboxes.id, id), eq(sandboxes.ownerId, session.user.id)),
    });
    if (!sandbox) return socket.close(4004, "Not found");

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
      let msg: { type: string; [key: string]: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "terminal.input" && stream) {
        stream.write(Buffer.from(msg.data + "\n"));
      }
    });

    socket.on("close", () => {
      stream?.end();
    });

    socket.resume();
  });
}
