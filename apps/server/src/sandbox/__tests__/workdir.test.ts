import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getContainerProvider } from "../container-provider.ts";
import { getHostProvider } from "../host-provider.ts";
import type { SandboxHandle, TerminalSession } from "../provider.ts";
import { sandboxImageReady } from "./docker-available.ts";

/**
 * #62: `handle.workdir` is the default working directory — for every
 * provider, for `exec` and for `openTerminal` alike.
 *
 * It was documented as that and was not: the container provider ran execs in
 * the *root* while the host provider used the workdir, so the same REST call
 * or terminal landed somewhere different depending on the deployment's
 * sandbox mode. It had already cost a real debugging session (a build command
 * hard-coded to `cd /home/loxaic/repo` failed under host mode and was
 * reported as a failing build), which is why the fix is a contract test
 * rather than a comment.
 *
 * `pwd` is asked of the sandbox rather than derived: what is being checked is
 * where the command actually ran, and only the sandbox can say. It answers
 * with the *physical* path, so the host cases compare against a realpath —
 * macOS's temp directory lives under a `/var` → `/private/var` symlink, and
 * without this the test would be asserting on that rather than on #62.
 */
const dockerReady = await sandboxImageReady();

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-workdir-"));
  process.env.SANDBOX_HOST_ROOT = root;
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "SANDBOX_HOST_ROOT");
  rmSync(root, { recursive: true, force: true });
});

/** Reads a terminal until `match` shows up, or gives up. Terminal output
 * arrives in whatever chunks the engine feels like sending, so a single
 * "first chunk" assertion would be flaky by construction. */
async function readUntil(session: TerminalSession, match: string, timeoutMs = 20_000): Promise<string> {
  let seen = "";
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`terminal never produced ${JSON.stringify(match)}; saw ${JSON.stringify(seen)}`));
    }, timeoutMs);
    session.onData((data) => {
      seen += data;
      if (seen.includes(match)) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
  });
}

/** Every provider under test here has a terminal; asked as a member call so
 * the handle stays its receiver, and guarded so a provider that ever loses
 * one fails with a sentence rather than a TypeError. */
async function openTerminalOf(handle: SandboxHandle): Promise<TerminalSession> {
  if (!handle.openTerminal) throw new Error(`${handle.provider} provider has no terminal support`);
  return handle.openTerminal();
}

describe("host provider", () => {
  let handle: SandboxHandle;

  beforeEach(async () => {
    handle = await getHostProvider().create("workdir-test", {});
  });

  afterEach(async () => {
    await handle.destroy();
  });

  it("runs an exec with no workdir in handle.workdir", async () => {
    const { stdout } = await handle.exec(["pwd"]);
    expect(stdout.trim()).toBe(realpathSync(handle.workdir));
  });

  it("still honours an explicit workdir", async () => {
    const { stdout } = await handle.exec(["pwd"], { workdir: handle.root });
    expect(stdout.trim()).toBe(realpathSync(handle.root));
  });

  it("opens a terminal in handle.workdir, and reports it has no TTY", async () => {
    const session = await openTerminalOf(handle);
    try {
      expect(session.tty).toBe(false);
      // No PTY, so nothing to resize — and the client is told, rather than
      // left to render a window that behaves nothing like a terminal.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting the capability is absent, not calling it.
      expect(session.resize).toBeUndefined();
      const output = readUntil(session, realpathSync(handle.workdir));
      session.write("pwd\n");
      expect(await output).toContain(realpathSync(handle.workdir));
    } finally {
      session.close();
    }
  });
});

describe.skipIf(!dockerReady)("container provider", () => {
  let handle: SandboxHandle;

  // One container for the three cases: none of them mutates it, a create is
  // the expensive part, and `beforeEach` paired with `afterAll` destroyed
  // only the last one — leaking two containers per run that no row claims
  // and the boot sweep only ever pauses.
  beforeAll(async () => {
    handle = await getContainerProvider().create("workdir-test", {});
  }, 120_000);

  afterAll(async () => {
    await handle.destroy().catch(() => undefined);
  });

  it("runs an exec with no workdir in handle.workdir, not the home directory above it", async () => {
    const { stdout } = await handle.exec(["pwd"]);
    expect(stdout.trim()).toBe(handle.workdir);
    expect(handle.workdir).not.toBe(handle.root);
  });

  it("still honours an explicit workdir", async () => {
    const { stdout } = await handle.exec(["pwd"], { workdir: handle.root });
    expect(stdout.trim()).toBe(handle.root);
  });

  it("opens a terminal in handle.workdir, with a real TTY", async () => {
    const session = await openTerminalOf(handle);
    try {
      expect(session.tty).toBe(true);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- as above: presence, not invocation.
      expect(session.resize).toBeInstanceOf(Function);
      const output = readUntil(session, handle.workdir);
      session.write("pwd\n");
      expect(await output).toContain(handle.workdir);
      // A PTY has a window size worth setting; nothing here should throw.
      session.resize?.(100, 30);
    } finally {
      session.close();
    }
  }, 30_000);
});
