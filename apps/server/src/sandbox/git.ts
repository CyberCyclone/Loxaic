/**
 * The git commands Loxaic itself runs in a sandbox: the clone that fills a
 * GitHub workspace, and the Inspector's push (routes/git.ts).
 *
 * **No GitHub credential is ever handed to git here.** Both go through the
 * egress proxy (egress/env.ts, egress/proxy.ts), which adds the owner's token
 * on the way out and applies its rules. It used to be a credential helper
 * reading the token from one exec's environment — which kept it out of
 * `.git/config` but still put it inside the sandbox, where a shim `git` on
 * PATH or a process watching the exec could read it.
 *
 * What remains is keeping the checkout's own config from running anything
 * beside these commands: hooks and fsmonitor are off (`git push` would run
 * `.git/hooks/pre-push`, and `core.fsmonitor` is a command), and
 * command-line config outranks the repository's.
 */
import type { CreateSandboxConfig, ExecOptions, ExecResult, SandboxHandle } from "./provider.ts";
import { egressEnv } from "../egress/env.ts";

/** `git -c …` arguments that keep the checkout's config from running
 * anything alongside the command. */
export function gitSafeArgs(): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
}

/** `GIT_TERMINAL_PROMPT=0`, so a refused or missing credential fails at once
 * instead of hanging a non-interactive exec on a prompt nobody can answer. */
export const GIT_NO_PROMPT: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

/** Clone timeout. A full clone of a real repository over a real network is
 * not a 60-second operation, and the default exec timeout would turn every
 * mid-sized repo into a spurious failure. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * Clones `config.repoUrl` into `dest` and prepares it for an agent to work
 * in: checks out `newBranch` from `branch`, and sets the commit identity.
 *
 * A **full** clone, deliberately. `--depth=1` makes `git log`, `git blame`
 * and `git diff <base>` — the first three things a model reaches for when
 * asked why something is the way it is — either empty or wrong. The size cost
 * is paid once per conversation and the checkout is kept (Stage 1's
 * stop-and-resume), so it is not paid again.
 *
 * Throws with the failing step's stderr, **redacted**, on any non-zero exit.
 */
export async function cloneInto(
  handle: SandboxHandle,
  config: CreateSandboxConfig,
  dest: string,
): Promise<void> {
  if (!config.repoUrl) return;
  // Through the egress proxy, which adds the owner's token: the clone is the
  // only step that talks to GitHub. Empty for a sandbox it does not serve.
  const egress = config.git?.egress ? await egressEnv(handle, config.git.egress) : {};
  const run = async (step: string, command: string[], options?: ExecOptions): Promise<ExecResult> => {
    const result = await handle.exec(command, { ...options, env: { ...GIT_NO_PROMPT, ...options?.env } });
    if (result.exitCode !== 0) {
      throw new Error(`git ${step} failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`);
    }
    return result;
  };

  await run(
    "clone",
    [
      "git",
      ...gitSafeArgs(),
      "clone",
      ...(config.branch ? [`--branch=${config.branch}`] : []),
      "--",
      config.repoUrl,
      dest,
    ],
    { timeoutMs: CLONE_TIMEOUT_MS, env: egress },
  );

  if (config.newBranch) {
    await run("checkout", ["git", "-C", dest, "checkout", "-b", config.newBranch], { workdir: dest });
  }

  const identity = config.git?.identity;
  if (identity) {
    // Repo-local, not `--global`: this checkout is the only thing in the
    // sandbox that should ever commit as this person.
    await run("config", ["git", "-C", dest, "config", "user.name", identity.name], { workdir: dest });
    await run("config", ["git", "-C", dest, "config", "user.email", identity.email], { workdir: dest });
  }
}
