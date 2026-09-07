/**
 * What the executor actually does with a `call` — the half of the executor
 * that has no socket in it, so it can be tested as a function.
 *
 * The one job here besides forwarding to the host provider is *refusing*.
 * The server on the other end of the socket may be someone else's machine,
 * and it can name any path it likes in any call; the only thing that stops a
 * hostile host from asking this machine for `~/.ssh/id_ed25519` is the check
 * in `approvedDir` below. So:
 *
 * - `create` is the only way a directory becomes a sandbox, and it is
 *   accepted only when the directory resolves — through symlinks, via
 *   `realpath` — to somewhere inside a root the user chose in their own
 *   native folder dialog. A symlink from an approved folder out to `/` is a
 *   real thing a repository can contain, which is why the lexical check the
 *   server does in agent/executor.ts is not enough here.
 * - Every later call re-runs the same check on its `ref`, against the roots
 *   *as they are now*: removing a folder in the desktop revokes it at once,
 *   not when the conversation happens to end.
 * - Every path *within* a call resolves under its ref the same way, with the
 *   nearest existing ancestor realpath'd so a file that does not exist yet
 *   (the usual case for a write) is judged by where it would actually land.
 *
 * Never imports the database, settings, or the server entry — see
 * __tests__/isolation.test.ts. This runs on a user's laptop with no Postgres.
 */
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { attachDirectory } from "../sandbox/host-provider.ts";
import { attachLocalContainer, ContainerRefError, createLocalContainer, isContainerRef } from "./container.ts";
import type { ExecOptions, SandboxHandle } from "../sandbox/provider.ts";
import type {
  CreateParams,
  ExecParams,
  ExecutorMethod,
  FileTreeParams,
  ReadFileParams,
  WriteFileBinaryParams,
  WriteFileParams,
} from "./protocol.ts";

export class RootViolationError extends Error {
  constructor(candidate: string) {
    super(`${candidate} is not inside a folder you have chosen for Loxaic`);
    this.name = "RootViolationError";
  }
}

export class ExecutorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorRequestError";
  }
}

export interface ExecutorServiceOptions {
  /** The approved roots, read on every call — never captured once. */
  roots: () => string[];
  /** This machine's id, so a container can be labelled as ours and refused
   * when a server names one that is not. */
  executorId: string;
}

export interface ExecutorService {
  handle(method: ExecutorMethod, params: unknown): Promise<unknown>;
}

/**
 * A ref turned into something to act on, with the caller's right to it
 * checked first. Shared with the parts of the executor that are not
 * request/response — terminals need exactly this and nothing else — so that
 * "may the server have this?" is answered in one place for both.
 *
 * `confined` says whether paths still have to be resolved against the ref on
 * *this* filesystem. For a container they do not: the container is the
 * boundary, and the paths in a call are inside it rather than here.
 */
export interface ResolvedRef {
  handle: SandboxHandle;
  ref: string;
  confined: boolean;
}

export interface RefResolver {
  resolve(ref: string, executorId: string): Promise<ResolvedRef>;
}

export function createRefResolver(opts: ExecutorServiceOptions): RefResolver {
  const isApproved = async (dir: string) =>
    approvedDirIn(opts.roots(), dir).then(() => true, () => false);
  return {
    async resolve(ref) {
      if (isContainerRef(ref)) {
        return { handle: await attachLocalContainer(ref, opts.executorId, isApproved), ref, confined: false };
      }
      const dir = await approvedDirIn(opts.roots(), ref);
      return { handle: attachDirectory(dir), ref: dir, confined: true };
    },
  };
}

function isInsideAny(roots: string[], candidateReal: string): boolean {
  for (const root of roots) {
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      continue;
    }
    if (isInside(rootReal, candidateReal)) return true;
  }
  return false;
}

/**
 * The real path of `candidate` iff it is an existing directory inside one of
 * `roots`. Roots that no longer exist are skipped — a user who deleted a
 * folder they had approved has not thereby approved anything else.
 */
async function approvedDirIn(roots: string[], candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate)) throw new RootViolationError(candidate);
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
    if (!(await stat(candidateReal)).isDirectory()) throw new RootViolationError(candidate);
  } catch (err) {
    if (err instanceof RootViolationError) throw err;
    throw new RootViolationError(candidate);
  }
  if (!isInsideAny(roots, candidateReal)) throw new RootViolationError(candidate);
  return candidateReal;
}

function isInside(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function requireObject(params: unknown, method: string): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ExecutorRequestError(`${method}: params must be an object`);
  }
  return params as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string, method: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw new ExecutorRequestError(`${method}: ${key} must be a non-empty string`);
  return v;
}

export function createExecutorService(opts: ExecutorServiceOptions): ExecutorService {
  const approvedDir = (candidate: string) => approvedDirIn(opts.roots(), candidate);

  /**
   * `p` resolved against an approved `refReal`, required to land inside it.
   * Judged by the nearest ancestor that exists, realpath'd, so a not-yet-
   * written file under a symlinked directory is checked where the bytes
   * would actually go rather than where the name suggests.
   */
  async function resolveInside(refReal: string, p: string): Promise<string> {
    const abs = path.resolve(refReal, p);
    let existing = abs;
    for (;;) {
      try {
        await stat(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    const existingReal = await realpath(existing);
    const resolved = path.join(existingReal, path.relative(existing, abs));
    if (!isInside(refReal, resolved)) throw new RootViolationError(abs);
    return resolved;
  }

  const resolver = createRefResolver(opts);

  async function handleFor(params: unknown, method: string): Promise<ResolvedRef> {
    const obj = requireObject(params, method);
    return resolver.resolve(requireString(obj, "ref", method), opts.executorId);
  }

  /** A path as the far side should see it: resolved and bounded against the
   * ref for a directory on this machine, taken as given inside a container. */
  const pathIn = async (ref: string, confined: boolean, p: string) => (confined ? resolveInside(ref, p) : p);

  return {
    async handle(method, params) {
      switch (method) {
        case "ping":
          return { ok: true, at: Date.now() };

        case "create": {
          const obj = requireObject(params, method) as Partial<CreateParams>;
          const dir = await approvedDir(requireString(obj, "path", method));
          if (obj.isolation === "container") {
            const { ref } = await createLocalContainer(dir, opts.executorId);
            return { ref };
          }
          if (obj.isolation !== "direct") {
            throw new ExecutorRequestError("isolation must be direct or container");
          }
          return { ref: dir };
        }

        case "attach": {
          const { handle, ref } = await handleFor(params, method);
          return { ref, root: handle.root, workdir: handle.workdir };
        }

        case "exec": {
          const { handle, ref, confined } = await handleFor(params, method);
          const obj = params as ExecParams;
          if (!Array.isArray(obj.command) || obj.command.some((c) => typeof c !== "string")) {
            throw new ExecutorRequestError("exec: command must be a string array");
          }
          const options: ExecOptions = {};
          if (obj.options?.workdir !== undefined) options.workdir = await pathIn(ref, confined, obj.options.workdir);
          if (typeof obj.options?.timeoutMs === "number") options.timeoutMs = obj.options.timeoutMs;
          if (obj.options?.env && typeof obj.options.env === "object") options.env = obj.options.env;
          return handle.exec(obj.command, options);
        }

        case "readFile": {
          const { handle, ref, confined } = await handleFor(params, method);
          const obj = params as ReadFileParams;
          return handle.readFile(await pathIn(ref, confined, requireString(obj as unknown as Record<string, unknown>, "path", method)));
        }

        case "writeFile": {
          const { handle, ref, confined } = await handleFor(params, method);
          const obj = params as WriteFileParams;
          if (typeof obj.content !== "string") throw new ExecutorRequestError("writeFile: content must be a string");
          await handle.writeFile(await pathIn(ref, confined, requireString(obj as unknown as Record<string, unknown>, "path", method)), obj.content);
          return { ok: true };
        }

        case "writeFileBinary": {
          const { handle, ref, confined } = await handleFor(params, method);
          const obj = params as WriteFileBinaryParams;
          if (typeof obj.dataBase64 !== "string") throw new ExecutorRequestError("writeFileBinary: dataBase64 must be a string");
          await handle.writeFileBinary(
            await pathIn(ref, confined, requireString(obj as unknown as Record<string, unknown>, "path", method)),
            Buffer.from(obj.dataBase64, "base64"),
          );
          return { ok: true };
        }

        case "fileTree": {
          const { handle, ref, confined } = await handleFor(params, method);
          const obj = params as FileTreeParams;
          const target = obj.path === undefined ? handle.root : await pathIn(ref, confined, obj.path);
          return handle.fileTree(target);
        }

        case "isRunning":
        case "exists": {
          // A directory the user has un-approved is, to the server, gone:
          // false here makes the manager record the row as destroyed and
          // re-validate the path on the next use instead of trusting it. A
          // container answers for itself — it can be paused, or removed.
          try {
            const { handle } = await handleFor(params, method);
            // Awaited inside the try, not returned unresolved: a container
            // whose folder is no longer approved rejects, and the catch below
            // is what turns that into the `false` the server expects.
            return await (method === "exists" ? handle.exists() : handle.isRunning());
          } catch (err) {
            if (err instanceof RootViolationError || err instanceof ContainerRefError) return false;
            throw err;
          }
        }

        case "start": {
          // "Resumable" for a plain directory means "still there and still
          // approved" — the throw is how the manager tells paused from gone.
          // A container is genuinely started again.
          const { handle } = await handleFor(params, method);
          await handle.start();
          return { ok: true };
        }

        case "stop": {
          // A container is paused, keeping everything in it. A directory has
          // nothing to pause: it is the user's own, not something this
          // process created, so the row on the server is simply forgotten.
          const { handle, confined } = await handleFor(params, method);
          if (!confined) await handle.stop();
          return { ok: true };
        }

        case "destroy": {
          // Removes the *container*, never the folder that was mounted into
          // it — that belongs to the user and predates us.
          const { handle, confined } = await handleFor(params, method);
          if (!confined) await handle.destroy();
          return { ok: true };
        }

        default: {
          const unknown: never = method;
          throw new ExecutorRequestError(`unknown method ${String(unknown)}`);
        }
      }
    },
  };
}
