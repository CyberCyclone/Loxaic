/**
 * The sandbox provider for `local` workspaces: a directory on the user's own
 * machine, reached through that machine's connected executor
 * (executor/registry.ts). Same `SandboxHandle` shape as the other two, so
 * the tool loop, the manager, and the routes never know the difference —
 * every method is one `callExecutor` round trip.
 *
 * Never selected by SANDBOX_MODE or an admin setting, only by a
 * conversation's workspace (agent/sandbox-manager.ts). It ignores the
 * server's own sandbox posture entirely — `allowNetwork`, host mode,
 * `hostingBlockedReason()` — because nothing here executes on the server.
 *
 * A persisted ref is `<executorId>:<ref>`: the id names the socket, and the
 * rest is what that machine calls the sandbox — the directory's real path for
 * a direct workspace, or `container:<id>` for a container-isolated one. Split
 * on the first colon, which ws/executor.ts forbids in an id and a Windows
 * drive letter puts second.
 */
import {
  callExecutor,
  ExecutorOfflineError,
  executorName,
  getExecutor,
  openExecutorTerminal,
} from "../executor/registry.ts";
import {
  CREATE_TIMEOUT_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_MARGIN_MS,
  LOCAL_CONTAINER_PREFIX,
  type CreateResult,
  type ExecCallResult,
  type FileTreeResult,
} from "../executor/protocol.ts";
import { CONTAINER_ROOT, CONTAINER_WORKDIR } from "./container-engine.ts";
import type { CreateSandboxConfig, SandboxHandle, SandboxProvider, TerminalSession } from "./provider.ts";

export function encodeExecutorRef(executorId: string, ref: string): string {
  return `${executorId}:${ref}`;
}

export function decodeExecutorRef(persisted: string): { executorId: string; ref: string } {
  const i = persisted.indexOf(":");
  if (i <= 0 || i === persisted.length - 1) throw new Error(`malformed executor sandbox ref: ${persisted}`);
  return { executorId: persisted.slice(0, i), ref: persisted.slice(i + 1) };
}

function isOnline(executorId: string): boolean {
  return getExecutor(executorId) !== null;
}

/**
 * Where the sandbox's files sit, from the ref alone. A direct workspace *is*
 * the folder; a container-isolated one has the image's layout with that
 * folder mounted at the workdir. Derived here rather than asked for, so an
 * attach stays a local operation — the executor would otherwise have to be
 * round-tripped before the handle could say anything about itself.
 */
function layoutOf(ref: string): { root: string; workdir: string } {
  if (isContainerRef(ref)) return { root: CONTAINER_ROOT, workdir: CONTAINER_WORKDIR };
  return { root: ref, workdir: ref };
}

/** Whether a shell on this ref will be a real terminal. Derived rather than
 * asked, for the same reason the layout is: `openTerminal` returns before the
 * far side has answered anything, and the client is told at that moment. A
 * container's terminal is a PTY (Docker allocates one inside it); a
 * directory's is bash over pipes. */
function isContainerRef(ref: string): boolean {
  return ref.startsWith(LOCAL_CONTAINER_PREFIX);
}

function makeHandle(executorId: string, ref: string): SandboxHandle {
  const layout = layoutOf(ref);
  const call = <T>(method: Parameters<typeof callExecutor>[1], params: object, timeoutMs?: number) =>
    callExecutor<T>(executorId, method, { ref, ...params }, timeoutMs === undefined ? {} : { timeoutMs });

  return {
    provider: "executor",
    ref: encodeExecutorRef(executorId, ref),
    root: layout.root,
    workdir: layout.workdir,

    exec: (command, options) => {
      // The signal never goes *on* the wire — an AbortSignal serialises to
      // `{}` — it rides beside the call, and aborting sends `exec.cancel`
      // naming this call's id. The executor then kills the command's process
      // group on its own machine and answers the original call normally, so
      // partial output survives (#119).
      const { signal, ...wireOptions } = options ?? {};
      // Nothing is sent for a signal that is already aborted — after a Stop
      // every remaining call in a batch arrives so — matching the container
      // and host providers, which do not start the command either.
      if (signal?.aborted) {
        return Promise.resolve({ stdout: "", stderr: "… [stopped by the user]", exitCode: 130, truncated: false, timedOut: false });
      }
      return callExecutor<ExecCallResult>(
        executorId,
        "exec",
        { ref, command, ...(Object.keys(wireOptions).length > 0 ? { options: wireOptions } : {}) },
        {
          timeoutMs: (options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + EXEC_TIMEOUT_MARGIN_MS,
          ...(signal ? { signal } : {}),
        },
      );
    },

    readFile: (filePath) => call<string>("readFile", { path: filePath }),

    async writeFile(filePath, content) {
      await call("writeFile", { path: filePath, content });
    },

    async writeFileBinary(filePath, data) {
      await call("writeFileBinary", { path: filePath, dataBase64: data.toString("base64") });
    },

    fileTree: (treePath) => call<FileTreeResult>("fileTree", treePath === undefined ? {} : { path: treePath }),

    // Streamed over the executor's own socket rather than wrapped in a
    // request/response call — a shell is a conversation, not a question.
    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; opening is a send, with nothing to await.
    async openTerminal(): Promise<TerminalSession> {
      const dataListeners: ((data: string) => void)[] = [];
      const closeListeners: (() => void)[] = [];
      const terminal = openExecutorTerminal(executorId, ref, {
        onData: (data) => { for (const l of dataListeners) l(data); },
        onExit: (error) => {
          // A refusal from the far side (an un-approved directory, a machine
          // that went away mid-session) is the only explanation the user will
          // get, so it goes into the stream they are looking at rather than
          // into a log they are not.
          if (error) for (const l of dataListeners) l(`\r\n[${error}]\r\n`);
          for (const l of closeListeners) l();
        },
      });
      return {
        // A container on that machine gives a real PTY; a plain directory is
        // bash over pipes, like the host provider it runs.
        tty: isContainerRef(ref),
        write: (data) => { terminal.write(data); },
        resize: (cols, rows) => { terminal.resize(cols, rows); },
        onData: (listener) => { dataListeners.push(listener); },
        onClose: (listener) => { closeListeners.push(listener); },
        close: () => { terminal.close(); },
      };
    },

    async isRunning() {
      if (!isOnline(executorId)) return false;
      return call<boolean>("isRunning", {});
    },

    // Throws when offline rather than answering false: "cannot ask" must
    // never be recorded as "destroyed" (see markDeadRowsDestroyed), and the
    // directory is almost certainly still there on a machine that is merely
    // not connected right now.
    async exists() {
      if (!isOnline(executorId)) throw new ExecutorOfflineError(executorName(executorId));
      return call<boolean>("exists", {});
    },

    async start() {
      // Offline throws ExecutorOfflineError through callExecutor, which is
      // what makes resume() report "not resumable" and the manager fall
      // through to a clear tool error rather than creating a second row.
      await call("start", {});
    },

    // Neither ever touches the user's *folder* — it is theirs and predates
    // us. For a direct workspace there is nothing else to act on, so
    // forgetting the row is the whole operation; a container-isolated one has
    // a container to pause and, for destroy, to remove. Either way an offline
    // machine has nothing reachable, and skipping is right: the container is
    // still there when it comes back.
    async stop() {
      if (!isOnline(executorId)) return;
      await call("stop", {}).catch(() => undefined);
    },

    async destroy() {
      if (!isOnline(executorId)) return;
      await call("destroy", {}).catch(() => undefined);
    },
  };
}

let provider: SandboxProvider | null = null;

export function getExecutorProvider(): SandboxProvider {
  provider ??= {
    kind: "executor",

    // The provider is always "available" in the sense the status endpoint
    // asks about — it is a per-machine question, answered per call.
    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async.
    async available() {
      return { ok: true };
    },

    async create(_userId: string, config: CreateSandboxConfig) {
      const local = config.local;
      if (!local) throw new Error("an executor sandbox needs a local workspace to say which machine and directory");
      const executor = getExecutor(local.executorId);
      if (!executor) throw new ExecutorOfflineError(executorName(local.executorId));
      // The machine must be the conversation owner's. A shared editor may
      // trigger the first tool call, and by sharing the owner agreed to
      // that — but nobody's workspace may name a machine registered by
      // someone else.
      if (executor.userId !== local.ownerId) {
        throw new Error("This workspace's machine is registered to a different user");
      }
      const { ref } = await callExecutor<CreateResult>(
        local.executorId,
        "create",
        { path: local.path, isolation: local.isolation },
        // The first container-isolated workspace on a machine builds the
        // sandbox image, which is minutes rather than seconds. A direct one
        // is a realpath and a stat, and gets the ordinary deadline: the run
        // holds its inference slot through this call, so a connected-but-
        // wedged laptop must not be able to stall the queue for ten minutes
        // over a check that takes milliseconds.
        local.isolation === "container" ? { timeoutMs: CREATE_TIMEOUT_MS } : {},
      );
      return makeHandle(local.executorId, ref);
    },

    // Does not verify — the interface says so — but does refuse an offline
    // machine outright, so the manager's "existing row" path fails with the
    // offline message instead of recording the directory as destroyed.
    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async.
    async attach(persisted: string) {
      const { executorId, ref } = decodeExecutorRef(persisted);
      if (!isOnline(executorId)) throw new ExecutorOfflineError(executorName(executorId));
      return makeHandle(executorId, ref);
    },
  };
  return provider;
}
