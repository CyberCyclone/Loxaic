/**
 * Interactive shells on the user's own machine, for the terminal panel.
 *
 * Streaming rather than request/response, so these live beside the service
 * (executor/service.ts) rather than inside it: the server sends
 * `terminal.open` and then a stream of input, and each shell sends its output
 * back keyed by the same `terminalId`.
 *
 * What is gated, and what is not, deliberately: **opening** a shell requires
 * the ref to be one the user approved — a directory still inside a root, or a
 * container this executor made for one — re-checked at open time like every
 * other call, through the same resolver the request/response side uses.
 *
 * Where a *direct* shell goes afterwards is not bounded, and cannot be: it is
 * an ordinary bash running as the user, and `cd ..` is a shell's whole job.
 * That is not a hole in the root check — `exec` already runs arbitrary
 * commands on this machine, which is what "Direct — commands run as you, with
 * no sandbox" says in the chooser. A shell in a *container* is bounded by the
 * container, like every other command in one.
 *
 * Which also decides the terminal: a direct shell is pipe mode with no PTY
 * (see host-provider.ts's `openPipeTerminal` for why a native module is not
 * an option), while a container's is a real one, because Docker allocates it
 * inside the container.
 */
import type { TerminalSession } from "../sandbox/provider.ts";
import type { ExecutorToServer } from "./protocol.ts";
import type { RefResolver } from "./service.ts";

/** Ceiling on shells one executor will hold open at once. A terminal is a
 * person typing, so this is far above any real use; it exists so a server
 * that opened them in a loop could not spawn processes without bound. */
const MAX_TERMINALS = 8;

export interface ExecutorTerminals {
  open(terminalId: string, ref: string): Promise<void>;
  input(terminalId: string, data: string): void;
  /** Only a real PTY has a window size; a pipe session ignores this. */
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  /** Every shell this executor holds — for a lost server connection, which
   * must not leave bash processes running on someone's laptop. */
  closeAll(): void;
}

export function createExecutorTerminals(opts: {
  resolver: RefResolver;
  executorId: string;
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
      let session: TerminalSession;
      try {
        const { handle } = await opts.resolver.resolve(ref, opts.executorId);
        if (!handle.openTerminal) throw new Error("this workspace has no terminal");
        session = await handle.openTerminal();
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

    resize(terminalId, cols, rows) {
      sessions.get(terminalId)?.resize?.(cols, rows);
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
