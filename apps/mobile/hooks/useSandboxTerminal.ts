import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createSandboxTerminalSocket,
  getSandboxes,
  sendTerminalInput,
  sendTerminalResize,
  type TerminalServerEvent,
} from '@loxaic/api-client';

export type TerminalStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** How much output is kept for a panel that is closed and reopened, or for a
 * renderer that mounts after the first bytes have already arrived. Bounded
 * because a runaway command can produce megabytes and this lives in memory;
 * the oldest bytes go first, which is what a terminal scrollback does anyway. */
const BACKLOG_LIMIT = 256 * 1024;

export interface SandboxTerminal {
  status: TerminalStatus;
  /** True only for a real PTY — see TerminalReadyEvent. Null until ready. */
  tty: boolean | null;
  workdir: string | null;
  /** Why it is not open, when that is worth saying. */
  error: string | null;
  /** Whether this conversation has a workspace to open a terminal in at all. */
  hasSandbox: boolean;
  /**
   * Streams output to `listener`, replaying what has already arrived first,
   * so a panel that mounts late is not looking at a blank window. Returns an
   * unsubscribe.
   *
   * A callback rather than state on purpose: terminal output arrives in many
   * small chunks, and re-rendering React for each one would be both slow and
   * pointless — xterm and the native view both append directly.
   */
  subscribe: (listener: (data: string) => void) => () => void;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** Opens a fresh session, replacing any current one. */
  reconnect: () => void;
}

/**
 * The terminal behind the agent screen's panel.
 *
 * Finds the conversation's workspace itself (`GET /v1/sandboxes?conversation_id=`
 * — agent sandboxes are created lazily by the tool loop, so their id is never
 * otherwise surfaced), then opens `/ws/sandbox/:id`. A *paused* workspace is
 * resumed by the server on connect, which is what someone opening a terminal
 * after lunch expects; a conversation that has never run a tool has no
 * workspace yet, and the panel says so rather than creating one — opening a
 * terminal is not a reason to spin up a container.
 *
 * Only connects while `enabled` (the panel is open): a socket held by a
 * collapsed panel keeps a sandbox marked in-use and, for a local workspace,
 * a bash process alive on someone's laptop.
 */
export function useSandboxTerminal(
  conversationId: string | null,
  token: string | null,
  enabled: boolean,
): SandboxTerminal {
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [tty, setTty] = useState<boolean | null>(null);
  const [workdir, setWorkdir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSandbox, setHasSandbox] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const backlogRef = useRef('');
  const listenersRef = useRef(new Set<(data: string) => void>());

  const emit = useCallback((data: string) => {
    backlogRef.current = (backlogRef.current + data).slice(-BACKLOG_LIMIT);
    for (const listener of listenersRef.current) listener(data);
  }, []);

  const subscribe = useCallback((listener: (data: string) => void) => {
    listenersRef.current.add(listener);
    if (backlogRef.current) listener(backlogRef.current);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !conversationId || !token) {
      setStatus('idle');
      return;
    }
    let cancelled = false;
    // Read through a call, never the variable: the type checker narrows
    // `cancelled` to false after the assignment above and cannot see that an
    // await lets the cleanup run in between — the same trap the run
    // scheduler's `signal.aborted` check documents (AGENTS.md).
    const isCancelled = () => cancelled;
    let socket: WebSocket | null = null;

    setStatus('connecting');
    setError(null);
    setTty(null);
    setWorkdir(null);

    void (async () => {
      let sandboxId: string | null = null;
      try {
        const rows = await getSandboxes(conversationId);
        sandboxId = rows.find((r) => r.status !== 'destroyed')?.id ?? null;
      } catch {
        sandboxId = null;
      }
      if (isCancelled()) return;
      setHasSandbox(sandboxId !== null);
      if (!sandboxId) {
        setStatus('idle');
        return;
      }

      socket = createSandboxTerminalSocket(sandboxId, token, (event: TerminalServerEvent) => {
        if (isCancelled()) return;
        switch (event.type) {
          case 'terminal.ready':
            setTty(event.tty);
            setWorkdir(event.workdir);
            setStatus('open');
            break;
          case 'terminal.output':
            emit(event.data);
            break;
          case 'terminal.error':
            setError(event.message);
            setStatus('error');
            break;
          case 'terminal.exit':
            setStatus('closed');
            break;
        }
      });
      socketRef.current = socket;
      socket.onclose = () => {
        if (isCancelled()) return;
        socketRef.current = null;
        // `error` and `closed` are both already-explained endings; only an
        // unannounced drop needs to become one here.
        setStatus((current) => (current === 'error' || current === 'closed' ? current : 'closed'));
      };
      socket.onerror = () => {
        if (isCancelled()) return;
        setStatus((current) => (current === 'error' ? current : 'error'));
      };
    })();

    return () => {
      cancelled = true;
      socketRef.current = null;
      socket?.close();
    };
  }, [conversationId, token, enabled, attempt, emit]);

  const send = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket) sendTerminalInput(socket, data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const socket = socketRef.current;
    if (socket) sendTerminalResize(socket, cols, rows);
  }, []);

  const reconnect = useCallback(() => {
    backlogRef.current = '';
    // Clear screen + home, so the renderer showing the old session's output
    // does not present it as the new one's.
    for (const listener of listenersRef.current) listener('\u001b[2J\u001b[H');
    setAttempt((n) => n + 1);
  }, []);

  return { status, tty, workdir, error, hasSandbox, subscribe, send, resize, reconnect };
}
