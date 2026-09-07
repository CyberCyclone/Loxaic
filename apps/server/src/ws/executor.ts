/**
 * `/ws/executor?token=` — where a desktop app's local executor connects so
 * its user's `local` workspaces can run on that machine.
 *
 * Authenticated exactly like the other sockets (auth/middleware.ts's
 * `resolveSessionFromToken`, ban check included), and then *re-checked on a
 * timer*: an executor holds a long-lived socket that runs commands, and a
 * user banned mid-session must lose it rather than keep it until the token
 * expires. The first frame must be a `hello`; anything else, or nothing
 * within a few seconds, closes the socket. After that the executor sends
 * `result`s and `roots` updates, and the server sends `call`s through the
 * registry — this handler never interprets a call itself.
 */
import type { FastifyInstance } from "fastify";
import { resolveSessionFromToken } from "../auth/middleware";
import {
  handleExecutorResult,
  handleExecutorTerminalMessage,
  registerExecutor,
  updateExecutorRoots,
} from "../executor/registry.ts";
import { EXECUTOR_PROTOCOL_VERSION, type ExecutorToServer, type HelloMessage } from "../executor/protocol.ts";

/** Minimal shape of the underlying `ws` socket we actually touch — see
 * ws/agent.ts for why this is declared here. */
interface WsConnection {
  readonly readyState: number;
  readonly OPEN: number;
  pause(): void;
  resume(): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
}

const HELLO_DEADLINE_MS = 10_000;
const SESSION_RECHECK_MS = 60_000;
const MAX_ROOTS = 200;
const MAX_ROOT_LENGTH = 4096;

/** An executor id is the desktop's instanceId (a UUID) — but it is also the
 * prefix of every executor sandbox's persisted ref, split on the first ':',
 * so a colon is the one character it must never contain. */
const EXECUTOR_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

// eslint-disable-next-line no-control-regex -- stripping them is the point.
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(CONTROL_RE, "").trim().slice(0, 64);
  return name.length > 0 ? name : null;
}

/** Roots are advisory on the server (the executor is the authority), but a
 * malformed list is still a protocol error, and the length caps keep a
 * misbehaving client from filling memory with a single frame. */
export function validateRoots(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ROOTS) return null;
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || r.length === 0 || r.length > MAX_ROOT_LENGTH) return null;
    if (CONTROL_RE.test(r)) return null;
    CONTROL_RE.lastIndex = 0;
    out.push(r);
  }
  return out;
}

function validateHello(raw: ExecutorToServer): HelloMessage | null {
  if (raw.type !== "hello") return null;
  if (raw.version !== EXECUTOR_PROTOCOL_VERSION) return null;
  if (typeof raw.executorId !== "string" || !EXECUTOR_ID_RE.test(raw.executorId)) return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  if (typeof raw.platform !== "string" || raw.platform.length === 0 || raw.platform.length > 32) return null;
  const caps = raw.capabilities as Partial<HelloMessage["capabilities"]> | undefined;
  if (!caps || typeof caps.direct !== "boolean" || typeof caps.container !== "boolean") return null;
  const roots = validateRoots(raw.roots);
  if (!roots) return null;
  return {
    type: "hello",
    version: raw.version,
    executorId: raw.executorId,
    name,
    platform: raw.platform,
    capabilities: { direct: caps.direct, container: caps.container },
    roots,
  };
}

export function executorWsHandler(app: FastifyInstance) {
  app.get("/ws/executor", { websocket: true }, async (socket: WsConnection, request) => {
    // See ws/chat.ts for why this must happen before the async auth check.
    socket.pause();

    // A close on a *paused* socket never finishes: the close handshake needs
    // the peer's answering frame read, and nothing is reading. The client
    // then sits in CLOSING until its own timeout (30s in `ws`), which is
    // exactly how the executor would behave on a bad token — so resume first.
    const reject = (code: number, reason: string) => {
      socket.resume();
      socket.close(code, reason);
    };

    const url = new URL(request.url, `http://${request.headers.host ?? ""}`);
    const token = url.searchParams.get("token");
    if (!token) {
      reject(4001, "Missing token");
      return;
    }
    const session = await resolveSessionFromToken(token);
    if (!session) {
      reject(4001, "Invalid session");
      return;
    }
    const userId = session.user.id;

    let unregister: (() => void) | null = null;
    let executorId: string | null = null;

    const helloTimer = setTimeout(() => {
      if (!unregister) socket.close(4002, "Expected hello");
    }, HELLO_DEADLINE_MS);

    // The token was valid at connect time; keep it that way. A session that
    // has since been revoked or banned drops the executor within a minute,
    // and its in-flight calls fail rather than complete on a dead session.
    const recheck = setInterval(() => {
      void resolveSessionFromToken(token).then((fresh) => {
        if (fresh?.user.id !== userId) socket.close(4001, "Session expired");
      });
    }, SESSION_RECHECK_MS);

    socket.on("message", (raw: Buffer) => {
      let msg: ExecutorToServer;
      try {
        msg = JSON.parse(raw.toString()) as ExecutorToServer;
      } catch {
        socket.close(4002, "Invalid JSON");
        return;
      }

      if (!unregister) {
        const hello = validateHello(msg);
        if (!hello) {
          socket.close(4002, "Expected a valid hello");
          return;
        }
        clearTimeout(helloTimer);
        executorId = hello.executorId;
        unregister = registerExecutor({
          executorId: hello.executorId,
          userId,
          name: hello.name,
          platform: hello.platform,
          capabilities: hello.capabilities,
          roots: hello.roots,
          send: (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
          },
          close: (code, reason) => { socket.close(code, reason); },
        });
        socket.send(JSON.stringify({ type: "welcome" }));
        return;
      }

      if (msg.type === "roots") {
        const roots = validateRoots(msg.roots);
        if (roots && executorId) updateExecutorRoots(executorId, roots);
      } else if (msg.type === "result") {
        if (executorId && typeof msg.id === "string") handleExecutorResult(executorId, msg);
      } else if (msg.type === "terminal.data" || msg.type === "terminal.exit") {
        if (executorId && typeof msg.terminalId === "string") handleExecutorTerminalMessage(executorId, msg);
      }
      // A second hello, or an unknown type, is ignored rather than fatal.
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(recheck);
      unregister?.();
    });

    socket.resume();
  });
}
