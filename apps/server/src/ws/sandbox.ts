import type { FastifyInstance } from "fastify";
import { auth } from "../auth";
import { getContainer } from "../sandbox/orchestrator";

export function sandboxTerminalWs(app: FastifyInstance) {
  app.get("/ws/sandbox/:id", { websocket: true }, async (connection, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    const { id } = request.params as { id: string };
    if (!token) return connection.socket.close(4001, "Missing token");

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
    });
    if (!session) return connection.socket.close(4001, "Invalid session");

    const container = getContainer(id);

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
      connection.socket.send(JSON.stringify({ type: "terminal.output", data: str }));
    });

    connection.socket.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "terminal.input" && stream) {
        stream.write(Buffer.from(msg.data + "\n"));
      }
    });

    connection.socket.on("close", () => {
      stream?.end();
    });
  });
}