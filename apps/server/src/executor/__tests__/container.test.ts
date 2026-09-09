import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Docker from "dockerode";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxImageReady } from "../../sandbox/__tests__/docker-available.ts";
import { ContainerRefError } from "../container.ts";
import { createExecutorService } from "../service.ts";

/**
 * Container isolation for a local workspace, against a real engine.
 *
 * Two claims are being made to the user when they pick this over Direct, and
 * only a real container can settle either: their folder is genuinely writable
 * from inside, and the *rest of their machine* is genuinely not visible. Both
 * are asserted from outside the container — on the real filesystem, and by
 * asking the container what it can see.
 *
 * The third claim is about what happens afterwards: destroying the sandbox
 * removes the container and leaves the folder exactly as it was. That one has
 * bitten this codebase before in the other direction (a stop that deleted a
 * host directory), which is why it is a test rather than a comment.
 */
const dockerReady = await sandboxImageReady();

const EXECUTOR_ID = "test-container-executor";

let base: string;
let root: string;
let roots: string[];
/** Container refs this file made, so a failure cannot leak containers. */
const made: string[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loxaic-local-container-")));
  root = path.join(base, "project");
  mkdirSync(root);
  roots = [root];
});

afterEach(async () => {
  if (dockerReady) {
    const docker = new Docker();
    for (const ref of made.splice(0)) {
      const container = docker.getContainer(ref.replace("container:", ""));
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
  rmSync(base, { recursive: true, force: true });
});

function service() {
  return createExecutorService({ roots: () => roots, executorId: EXECUTOR_ID });
}

async function createContainerSandbox(): Promise<{ ref: string; svc: ReturnType<typeof service> }> {
  const svc = service();
  const { ref } = (await svc.handle("create", { path: root, isolation: "container" })) as { ref: string };
  made.push(ref);
  return { ref, svc };
}

describe.skipIf(!dockerReady)("container isolation on a local workspace", () => {
  it("mounts the chosen folder, and writes through it land on the real filesystem", async () => {
    const { ref, svc } = await createContainerSandbox();
    expect(ref.startsWith("container:")).toBe(true);

    // The agent's view: an ordinary workspace at the usual working directory.
    const attached = (await svc.handle("attach", { ref })) as { root: string; workdir: string };
    expect(attached).toMatchObject({ root: "/home/loxaic", workdir: "/home/loxaic/repo" });
    const pwd = (await svc.handle("exec", { ref, command: ["pwd"] })) as { stdout: string };
    expect(pwd.stdout.trim()).toBe("/home/loxaic/repo");

    // The user's view: a real file, in their real folder.
    await svc.handle("writeFile", { ref, path: "/home/loxaic/repo/notes.txt", content: "from the container\n" });
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("from the container\n");

    // And the other direction — what they put there is what it reads.
    writeFileSync(path.join(root, "theirs.txt"), "written on the host\n");
    expect(await svc.handle("readFile", { ref, path: "/home/loxaic/repo/theirs.txt" })).toBe("written on the host\n");
  }, 180_000);

  it("shows the container the folder and nothing else of the machine", async () => {
    // A file the user has *not* shared, next to the one they have.
    const secret = path.join(base, "secret.txt");
    writeFileSync(secret, "not for the agent");
    const { ref, svc } = await createContainerSandbox();

    const seen = (await svc.handle("exec", { ref, command: ["cat", secret] })) as { exitCode: number; stderr: string };
    expect(seen.exitCode).not.toBe(0);
    expect(seen.stderr).toMatch(/No such file/i);

    // The user's home directory is not there to be walked either — this is
    // the whole difference from direct mode, where it plainly is.
    const home = (await svc.handle("exec", { ref, command: ["ls", os.homedir()] })) as { exitCode: number };
    expect(home.exitCode).not.toBe(0);
  }, 180_000);

  it("refuses a container it did not create, however the server names it", async () => {
    // A container on this machine that is nothing to do with Loxaic: exactly
    // what a hostile server would try to reach by guessing an id.
    const docker = new Docker();
    const theirs = await docker.createContainer({ Image: "alpine", Cmd: ["sleep", "60"] }).catch(() => null);
    if (!theirs) return; // no alpine locally; the label check is covered below too
    try {
      const svc = service();
      await expect(svc.handle("exec", { ref: `container:${theirs.id}`, command: ["id"] })).rejects.toBeInstanceOf(
        ContainerRefError,
      );
      await expect(svc.handle("exec", { ref: `container:${theirs.id}`, command: ["id"] })).rejects.toThrow(
        /not created by Loxaic/,
      );
    } finally {
      await theirs.remove({ force: true }).catch(() => undefined);
    }
  }, 120_000);

  it("refuses a container of its own once the folder is no longer approved", async () => {
    const { ref, svc } = await createContainerSandbox();
    roots = [];
    await expect(svc.handle("exec", { ref, command: ["pwd"] })).rejects.toThrow(/folder you have chosen/);
    // exists/isRunning answer rather than throw, which is what tells the
    // server to stop trusting the row instead of failing the whole run.
    expect(await svc.handle("exists", { ref })).toBe(false);
  }, 180_000);

  it("stops and destroys the container without touching the folder", async () => {
    const { ref, svc } = await createContainerSandbox();
    writeFileSync(path.join(root, "keep.txt"), "important");

    await svc.handle("stop", { ref });
    expect(await svc.handle("isRunning", { ref })).toBe(false);
    // Paused, not gone: everything in it survives, as for any other sandbox.
    expect(await svc.handle("exists", { ref })).toBe(true);
    await svc.handle("start", { ref });
    expect(await svc.handle("isRunning", { ref })).toBe(true);

    await svc.handle("destroy", { ref });
    expect(await svc.handle("exists", { ref })).toBe(false);
    // The folder is the user's, and predates us.
    expect(readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("important");
  }, 180_000);
});
