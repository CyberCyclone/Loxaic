/**
 * `/ws/sandbox/:id` — the interactive terminal behind the agent screen's
 * terminal panel.
 *
 * Owner-only, like every other sandbox route: a terminal is arbitrary code
 * execution in someone's workspace, not participation in a chat, so a shared
 * editor never reaches it.
 *
 * The protocol carries **raw keystrokes**, in both directions. It used to
 * append a newline to every `terminal.input`, which made sense when the only
 * client was a line-oriented debug page and makes none now: xterm sends `\r`
 * for Enter, arrow keys as escape sequences, and Ctrl-C as `\x03` — appending
 * to any of those corrupts them. What the client must know to render any of
 * this correctly is whether it got a real PTY, which is what `terminal.ready`
 * answers (see provider.ts's TerminalSession: containers yes, host and
 * executor no).
 */
import type { FastifyInstance } from "fastify";
import type { TerminalSession } from "../sandbox/provider.ts";
import { and, eq, ne } from "@loxaic/db";
import { db } from "@loxaic/db";
import { sandboxes } from "@loxaic/db/schema";
import { resolveSessionFromToken } from "../auth/middleware";
import { attachRunningSandbox } from "../agent/sandbox-manager.ts";
import { decodeExecutorRef } from "../sandbox/executor-provider.ts";
import { executorName, ExecutorOfflineError, getExecutor } from "../executor/registry.ts";
import { executorOfflineMessage } from "../executor/protocol.ts";

/** Minimal shape of the underlying `ws` socket we actually touch. `ws` ships
 * no type declarations of its own (and none are installed here), so without
 * this, everything @fastify/websocket hands us as `socket` resolves to `any`. */
/**
 * Two bounds on what one owner's terminals can cost the server. Neither is a
 * cross-user concern — a terminal is owner-only and the shell already runs
 * arbitrary commands — but the rest of the sandbox layer caps what one user
 * can consume (the running cap, PidsLimit, MAX_OUTPUT_BYTES), and this
 * endpoint capped nothing. The executor's own shells carry the same limit
 * (executor/terminal.ts), so the server now imposes on itself what it
 * imposes on a laptop.
 */
const MAX_TERMINALS_PER_USER = 8;
/** Output past this much unsent socket buffer is dropped, not queued: a
 * `yes` or a `cat` of a big file outruns a phone on mobile data indefinitely,
 * and `ws` would hold the difference in server memory without limit. A
 * terminal is a live view, so losing backlog is the right answer where a file
 * transfer's would not be. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const openTerminalsByUser = new Map<string, number>();
/**
 * The session is re-checked after connect, because a terminal is the one
 * socket whose whole content is arbitrary execution and the one most likely
 * to sit open for hours. A password reset deletes every session and a ban
 * revokes them all, and each of those promises the account is signed out
 * everywhere — which was not true of a shell opened beforehand.
 *
 * Not per frame, as ws/chat.ts does: a keystroke is a frame here, and a
 * session lookup is a database query. Instead: on input, at most once every
 * INPUT_RECHECK_MS, so a revoked session loses the shell on the next thing it
 * types; and on a timer for an idle one, as ws/executor.ts does.
 */
const INPUT_RECHECK_MS = 5_000;
const IDLE_RECHECK_MS = 60_000;

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

interface ClientMessage {
  type: string;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
}

/**
 * A window size a terminal could plausibly have. Bounded because these
 * numbers are handed to the container engine's resize call, and because a
 * client is free to send anything: NaN, 0, or a million columns are all
 * either meaningless or a way to make something else unhappy.
 */
function windowSize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return null;
  return { cols, rows };
}

/** Why a sandbox could not be attached, in words the panel can show. Null
 * when the ordinary "gone" answer is the right one. */
function offlineReason(row: { provider: string; containerId: string }): string | null {
  if (row.provider !== "executor") return null;
  try {
    const { executorId } = decodeExecutorRef(row.containerId);
    // Online but unattachable means the directory is gone or no longer
    // approved, which is a different fact and gets the ordinary 404.
    if (getExecutor(executorId)) return null;
    return executorOfflineMessage(executorName(executorId));
  } catch {
    return null;
  }
}

export function sandboxTerminalWs(app: FastifyInstance) {
  app.get("/ws/sandbox/:id", { websocket: true }, async (socket: WsConnection, request) => {
    // See ws/chat.ts for why this must happen before the async auth check.
    socket.pause();

    // A close on a paused socket never completes its handshake — nothing is
    // reading the peer's answering frame — so the client waits out its own
    // timeout instead of learning why. Resume first on every refusal.
    const send = (message: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const refuse = (code: number, reason: string, message?: string) => {
      socket.resume();
      // The full explanation rides as a message: a WebSocket close reason is
      // capped at 123 bytes and a machine's name can be 64 of them.
      if (message) send({ type: "terminal.error", message });
      socket.close(code, reason);
    };

    const url = new URL(request.url, `http://${request.headers.host ?? ""}`);
    const token = url.searchParams.get("token");
    const { id } = request.params as { id: string };
    if (!token) {
      refuse(4001, "Missing token");
      return;
    }

    const session = await resolveSessionFromToken(token);
    if (!session) {
      refuse(4001, "Invalid session");
      return;
    }

    const sandbox = await db.query.sandboxes.findFirst({
      // Destroyed rows are excluded because attaching now *resumes*: a
      // container that outlived a swallowed destroy() failure must not be
      // brought back to life by opening a terminal into it.
      where: and(eq(sandboxes.id, id), eq(sandboxes.ownerId, session.user.id), ne(sandboxes.status, "destroyed")),
    });
    if (!sandbox) {
      refuse(4004, "Not found", "That workspace no longer exists.");
      return;
    }

    // Resumes a paused sandbox rather than failing on it: a workspace stopped
    // by the idle timer is intact and is exactly what someone opening a
    // terminal wants to get back into. Null means genuinely gone, which gets
    // the same 4004 a missing row does — unless the machine it lives on is
    // merely offline, which is a different thing to be told.
    const handle = await attachRunningSandbox(sandbox);
    if (!handle) {
      const offline = offlineReason(sandbox);
      if (offline) refuse(4503, "Machine offline", offline);
      else refuse(4004, "Not found", "That workspace could not be opened.");
      return;
    }
    if (!handle.openTerminal) {
      refuse(4400, "No terminal", "This workspace does not support a terminal.");
      return;
    }
    const held = openTerminalsByUser.get(session.user.id) ?? 0;
    if (held >= MAX_TERMINALS_PER_USER) {
      refuse(4429, "Too many terminals", `You already have ${String(MAX_TERMINALS_PER_USER)} terminals open — close one first.`);
      return;
    }
    // Reserved *before* the await below, or N opens racing through it would
    // all see the same count (the executor's cap had exactly that gap).
    openTerminalsByUser.set(session.user.id, held + 1);
    const releaseSlot = () => {
      const now = openTerminalsByUser.get(session.user.id) ?? 1;
      if (now <= 1) openTerminalsByUser.delete(session.user.id);
      else openTerminalsByUser.set(session.user.id, now - 1);
    };

    // The one await in this handler that used to be unguarded, while the
    // socket was still paused: an executor dropping between the attach and
    // this call (ExecutorOfflineError — the case the 4503 exists for), or a
    // Docker exec failure, escaped past every refuse() and left the client
    // on a paused socket waiting out its own timeout for a bare 1006.
    let terminal: TerminalSession;
    try {
      terminal = await handle.openTerminal();
    } catch (err) {
      releaseSlot();
      const offline = err instanceof ExecutorOfflineError;
      refuse(
        offline ? 4503 : 4500,
        offline ? "Machine offline" : "Terminal failed",
        err instanceof Error ? err.message : "That workspace could not open a terminal.",
      );
      return;
    }

    terminal.onData((data) => {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      send({ type: "terminal.output", data });
    });
    terminal.onClose(() => {
      // Said before the socket goes, so the panel can show "session ended"
      // rather than an indistinguishable "connection lost".
      send({ type: "terminal.exit" });
      socket.close();
    });

    // True while the session that opened this shell still resolves to the
    // same user. Failing to *ask* is not evidence that it does not — a database
    // blip keeps the shell, and the next check asks again.
    let lastCheckedAt = Date.now();
    let checking: Promise<boolean> | null = null;
    const sessionStillValid = (): Promise<boolean> => {
      checking ??= resolveSessionFromToken(token)
        .then((fresh) => fresh?.user.id === session.user.id)
        .catch(() => true)
        .finally(() => {
          checking = null;
          lastCheckedAt = Date.now();
        });
      return checking;
    };
    const dropIfRevoked = async (): Promise<boolean> => {
      if (await sessionStillValid()) return false;
      if (socket.readyState !== socket.OPEN) return true;
      send({ type: "terminal.error", message: "Your session has ended. Sign in again to open a terminal." });
      socket.close(4001, "Session expired");
      return true;
    };
    const idleRecheck = setInterval(() => { void dropIfRevoked(); }, IDLE_RECHECK_MS);

    socket.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "terminal.input") {
        if (typeof msg.data !== "string") return;
        const data = msg.data;
        // Raw: no newline appended. See the module comment.
        if (Date.now() - lastCheckedAt < INPUT_RECHECK_MS) {
          terminal.write(data);
          return;
        }
        void dropIfRevoked().then((dropped) => {
          if (!dropped) terminal.write(data);
        });
        return;
      }
      if (msg.type === "terminal.resize") {
        const size = windowSize(msg.cols, msg.rows);
        if (size) terminal.resize?.(size.cols, size.rows);
      }
    });

    socket.on("close", () => {
      clearInterval(idleRecheck);
      releaseSlot();
      terminal.close();
    });

    // Everything the client needs to decide how to render: whether this is a
    // real terminal, and where it opened (#62 — the same directory the agent's
    // own commands land in, whichever provider this is).
    send({ type: "terminal.ready", tty: terminal.tty, workdir: handle.workdir });
    socket.resume();
  });
}
