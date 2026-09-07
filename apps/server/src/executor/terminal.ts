/**
 * Interactive shells on the user's own machine, for the terminal panel.
 *
 * Streaming rather than request/response, so these live beside the service
 * (executor/service.ts) rather than inside it: the server sends
 * `terminal.open` and then a stream of input, and each shell sends its output
 * back keyed by the same `terminalId`.
 *
 * What is gated, and what is not, deliberately: **opening** a shell requires
 * the directory to be one the user approved, re-checked at open time like
 * every other call. Where the shell goes afterwards is not bounded, and
 * cannot be — it is an ordinary bash running as the user, and `cd ..` is a
 * shell's whole job. That is not a hole in the root check: `exec` already
 * runs arbitrary commands on this machine, which is what "Direct — commands
 * run as you, with no sandbox" says in the chooser. The roots decide *where
 * work happens*, not what a shell the owner is typing into may reach.
 *
 * Pipe mode, no PTY — see host-provider.ts's `openPipeTerminal` for why a
 * native module is not an option here.
 */
import { openPipeTerminal } from "../sandbox/host-provider.ts";
import type { TerminalSession } from "../sandbox/provider.ts";
import type { ExecutorToServer } from "./protocol.ts";
import type { RootGuard } from "./service.ts";

/** Ceiling on shells one executor will hold open at once. A terminal is a
 * person typing, so this is far above any real use; it exists so a server
 * that opened them in a loop could not spawn processes without bound. */
const MAX_TERMINALS = 8;

export interface ExecutorTerminals {
  open(terminalId: string, ref: string): Promise<void>;
  input(terminalId: string, data: string): void;
  close(terminalId: string): void;
  /** Every shell this executor holds — for a lost server connection, which
   * must not leave bash processes running on someone's laptop. */
  closeAll(): void;
}

export function createExecutorTerminals(opts: {
  guard: RootGuard;
  send: (message: ExecutorToServer) => void;
}): ExecutorTerminals {
  const sessions = new Map<string, TerminalSession>();

  const exit = (terminalId: string, error?: string) => {
    sessions.delete(terminalId);
    opts.send({ type: "terminal.exit", terminalId, ...(error ? { error } : {}) });
  };

  return {
    async open(terminalId, ref) {
      if (sessions.has(terminalId)) return;
      if (sessions.size >= MAX_TERMINALS) {
        exit(terminalId, `too many terminals open on this machine (${String(MAX_TERMINALS)})`);
        return;
      }
      let dir: string;
      try {
        dir = await opts.guard.approvedDir(ref);
      } catch (err) {
        exit(terminalId, err instanceof Error ? err.message : String(err));
        return;
      }
      let session: TerminalSession;
      try {
        session = openPipeTerminal(dir);
      } catch (err) {
        exit(terminalId, err instanceof Error ? err.message : String(err));
        return;
      }
      // Registered before any listener fires, so output can never arrive for
      // a terminal the map does not know about.
      sessions.set(terminalId, session);
      session.onData((data) => { opts.send({ type: "terminal.data", terminalId, data }); });
      session.onClose(() => { exit(terminalId); });
    },

    input(terminalId, data) {
      sessions.get(terminalId)?.write(data);
    },

    close(terminalId) {
      const session = sessions.get(terminalId);
      if (!session) return;
      sessions.delete(terminalId);
      session.close();
    },

    closeAll() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}
