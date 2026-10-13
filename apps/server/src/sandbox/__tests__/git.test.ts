import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHostProvider } from "../host-provider.ts";
import { gitSafeArgs } from "../git.ts";

/**
 * The clone that fills a GitHub workspace (sandbox/git.ts), through the host
 * provider against a local bare repository — no network, no Docker. No token
 * is involved any more: GitHub sees one only through the egress proxy
 * (egress/__tests__/proxy.test.ts covers that path with real git), so what
 * is held here is that the checkout is right, and that Loxaic's own git
 * commands run nothing from it.
 */
let root: string;
let origin: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "loxaic-git-"));
  process.env.SANDBOX_HOST_ROOT = path.join(root, "sandboxes");
  // A bare origin with one commit on `main` and a second branch.
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(path.join(work, "README.md"), "hello\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  execFileSync("git", ["-C", work, "add", "."], { env });
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "init"], { env });
  execFileSync("git", ["-C", work, "branch", "dev"], { env });
  origin = path.join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", work, origin]);
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "SANDBOX_HOST_ROOT");
  rmSync(root, { recursive: true, force: true });
});

describe("cloning a workspace", () => {
  it("writes no credential configuration into the checkout", async () => {
    const handle = await getHostProvider().create("u", {
      repoUrl: `file://${origin}`,
      branch: "main",
      newBranch: "loxaic/abc",
      git: { identity: { name: "Octo Cat", email: "octo@example.test" } },
    });
    const config = readFileSync(path.join(handle.workdir, ".git", "config"), "utf8");
    expect(config).not.toMatch(/credential|helper|x-access-token|extraheader/i);
    const remote = await handle.exec(["git", "config", "--get", "remote.origin.url"], { workdir: handle.workdir });
    expect(remote.stdout.trim()).toBe(`file://${origin}`);
    await handle.destroy();
  });

  it("checks out the working branch from the base and sets the identity", async () => {
    const handle = await getHostProvider().create("u", {
      repoUrl: `file://${origin}`,
      branch: "dev",
      newBranch: "loxaic/abc",
      git: { identity: { name: "Octo Cat", email: "octo@example.test" } },
    });
    const branch = await handle.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { workdir: handle.workdir });
    expect(branch.stdout.trim()).toBe("loxaic/abc");
    // Cut from `dev`: the two point at the same commit.
    const dev = await handle.exec(["git", "rev-parse", "dev"], { workdir: handle.workdir });
    const head = await handle.exec(["git", "rev-parse", "HEAD"], { workdir: handle.workdir });
    expect(head.stdout.trim()).toBe(dev.stdout.trim());
    const name = await handle.exec(["git", "config", "user.name"], { workdir: handle.workdir });
    expect(name.stdout.trim()).toBe("Octo Cat");
    // Repo-local: the setting lives in this checkout's config, not the host's.
    const local = readFileSync(path.join(handle.workdir, ".git", "config"), "utf8");
    expect(local).toContain("Octo Cat");
    await handle.destroy();
  });

  it("is a full clone, so history is available to the agent", async () => {
    const handle = await getHostProvider().create("u", { repoUrl: `file://${origin}`, branch: "main" });
    const shallow = await handle.exec(["git", "rev-parse", "--is-shallow-repository"], { workdir: handle.workdir });
    expect(shallow.stdout.trim()).toBe("false");
    await handle.destroy();
  });

  it("fails the create rather than returning an empty checkout", async () => {
    await expect(getHostProvider().create("u", { repoUrl: `file://${root}/does-not-exist.git` })).rejects.toThrow(/git clone failed/);
  });
});

describe("Loxaic's own git commands", () => {
  it("run no hook and no fsmonitor from the checkout", async () => {
    const handle = await getHostProvider().create("u", { repoUrl: `file://${origin}`, branch: "main", newBranch: "loxaic/abc" });
    // A hook the model planted, which a push of Loxaic's must not run.
    const marker = path.join(root, "hook-ran");
    writeFileSync(path.join(handle.workdir, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await handle.exec(["git", "config", "core.fsmonitor", `touch ${marker}-fsmonitor`], { workdir: handle.workdir });
    const push = await handle.exec(["git", ...gitSafeArgs(), "push", "-q", "origin", "loxaic/abc"], { workdir: handle.workdir });
    expect(push.exitCode, push.stderr).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
    expect(() => readFileSync(`${marker}-fsmonitor`)).toThrow();
    await handle.destroy();
  });
});
