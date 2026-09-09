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
 * A persisted ref is `<executorId>:<path>`: the id names the socket, the
 * path is the directory's real path on that machine. Split on the first
 * colon, which ws/executor.ts forbids in an id and a Windows drive letter
 * puts second.
 */
import {
  callExecutor,
  ExecutorOfflineError,
  executorName,
  getExecutor,
} from "../executor/registry.ts";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  EXEC_TIMEOUT_MARGIN_MS,
  type CreateResult,
  type ExecCallResult,
  type FileTreeResult,
} from "../executor/protocol.ts";
import type { CreateSandboxConfig, SandboxHandle, SandboxProvider } from "./provider.ts";

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

function makeHandle(executorId: string, ref: string): SandboxHandle {
  const call = <T>(method: Parameters<typeof callExecutor>[1], params: object, timeoutMs?: number) =>
    callExecutor<T>(executorId, method, { ref, ...params }, timeoutMs === undefined ? {} : { timeoutMs });

  return {
    provider: "executor",
    ref: encodeExecutorRef(executorId, ref),
    root: ref,
    workdir: ref,

    exec: (command, options) =>
      call<ExecCallResult>(
        "exec",
        { command, ...(options ? { options } : {}) },
        (options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + EXEC_TIMEOUT_MARGIN_MS,
      ),

    readFile: (filePath) => call<string>("readFile", { path: filePath }),

    async writeFile(filePath, content) {
      await call("writeFile", { path: filePath, content });
    },

    async writeFileBinary(filePath, data) {
      await call("writeFileBinary", { path: filePath, dataBase64: data.toString("base64") });
    },

    fileTree: (treePath) => call<FileTreeResult>("fileTree", treePath === undefined ? {} : { path: treePath }),

    // No openTerminal yet: the terminal panel (a later stage) streams over
    // the executor socket rather than wrapping a request/response call.

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

    // Neither ever deletes anything on the user's machine (executor/
    // service.ts returns without touching the directory), so an idle stop or
    // a reap of an *offline* executor's row has nothing to reach it for:
    // forgetting the row is the whole operation.
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
      const { ref } = await callExecutor<CreateResult>(local.executorId, "create", {
        path: local.path,
        isolation: local.isolation,
      });
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
