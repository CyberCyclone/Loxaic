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
}

export interface ExecutorService {
  handle(method: ExecutorMethod, params: unknown): Promise<unknown>;
}

/**
 * The root check on its own, for the parts of the executor that are not
 * request/response. Terminals need exactly this and nothing else from the
 * service: a shell may only be opened in a directory the user approved, and
 * "approved" has to be re-read at open time rather than captured once.
 */
export interface RootGuard {
  approvedDir(candidate: string): Promise<string>;
}

export function createRootGuard(opts: ExecutorServiceOptions): RootGuard {
  return { approvedDir: (candidate) => approvedDirIn(opts.roots(), candidate) };
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

  async function handleFor(params: unknown, method: string): Promise<{ handle: SandboxHandle; ref: string }> {
    const obj = requireObject(params, method);
    const ref = await approvedDir(requireString(obj, "ref", method));
    return { handle: attachDirectory(ref), ref };
  }

  return {
    async handle(method, params) {
      switch (method) {
        case "ping":
          return { ok: true, at: Date.now() };

        case "create": {
          const obj = requireObject(params, method) as Partial<CreateParams>;
          if (obj.isolation !== "direct") {
            throw new ExecutorRequestError("Container isolation on a local workspace is not available yet");
          }
          const ref = await approvedDir(requireString(obj, "path", method));
          return { ref };
        }

        case "attach": {
          const { ref } = await handleFor(params, method);
          return { ref, root: ref, workdir: ref };
        }

        case "exec": {
          const { handle, ref } = await handleFor(params, method);
          const obj = params as ExecParams;
          if (!Array.isArray(obj.command) || obj.command.some((c) => typeof c !== "string")) {
            throw new ExecutorRequestError("exec: command must be a string array");
          }
          const options: ExecOptions = {};
          if (obj.options?.workdir !== undefined) options.workdir = await resolveInside(ref, obj.options.workdir);
          if (typeof obj.options?.timeoutMs === "number") options.timeoutMs = obj.options.timeoutMs;
          if (obj.options?.env && typeof obj.options.env === "object") options.env = obj.options.env;
          return handle.exec(obj.command, options);
        }

        case "readFile": {
          const { handle, ref } = await handleFor(params, method);
          const obj = params as ReadFileParams;
          return handle.readFile(await resolveInside(ref, requireString(obj as unknown as Record<string, unknown>, "path", method)));
        }

        case "writeFile": {
          const { handle, ref } = await handleFor(params, method);
          const obj = params as WriteFileParams;
          if (typeof obj.content !== "string") throw new ExecutorRequestError("writeFile: content must be a string");
          await handle.writeFile(await resolveInside(ref, requireString(obj as unknown as Record<string, unknown>, "path", method)), obj.content);
          return { ok: true };
        }

        case "writeFileBinary": {
          const { handle, ref } = await handleFor(params, method);
          const obj = params as WriteFileBinaryParams;
          if (typeof obj.dataBase64 !== "string") throw new ExecutorRequestError("writeFileBinary: dataBase64 must be a string");
          await handle.writeFileBinary(
            await resolveInside(ref, requireString(obj as unknown as Record<string, unknown>, "path", method)),
            Buffer.from(obj.dataBase64, "base64"),
          );
          return { ok: true };
        }

        case "fileTree": {
          const { handle, ref } = await handleFor(params, method);
          const obj = params as FileTreeParams;
          const target = obj.path === undefined ? ref : await resolveInside(ref, obj.path);
          return handle.fileTree(target);
        }

        case "isRunning":
        case "exists": {
          // A directory the user has un-approved is, to the server, gone:
          // false here makes the manager record the row as destroyed and
          // re-validate the path on the next use instead of trusting it.
          try {
            const obj = requireObject(params, method);
            await approvedDir(requireString(obj, "ref", method));
            return true;
          } catch (err) {
            if (err instanceof RootViolationError) return false;
            throw err;
          }
        }

        case "start": {
          // "Resumable" for a plain directory means "still there and still
          // approved" — the throw is how the manager tells paused from gone.
          await handleFor(params, method);
          return { ok: true };
        }

        case "stop":
        case "destroy":
          // Never touches the directory: it is the user's own, not something
          // this process created. The row on the server is forgotten; the
          // folder stays exactly as it was.
          return { ok: true };

        default: {
          const unknown: never = method;
          throw new ExecutorRequestError(`unknown method ${String(unknown)}`);
        }
      }
    },
  };
}
