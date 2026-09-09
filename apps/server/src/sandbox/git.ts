/**
 * The one place a GitHub token meets git.
 *
 * The invariant: **the token exists only in one exec's environment.** It is
 * never in argv (visible in `ps` and in the container's own process list),
 * never in the remote URL (which `git clone` writes into `.git/config`, where
 * the model can `cat` it and `web_fetch` it out), never in a file, and never
 * in a log line. Every git command that needs credentials is built here so
 * that property has exactly one place to be true.
 *
 * Mechanism: a `credential.helper` passed with `-c` that echoes the token out
 * of `$LOXAIC_GIT_TOKEN`. The helper text itself contains no secret, so it is
 * safe in argv; the value rides in `ExecOptions.env` for that command alone.
 * `credential.useHttpPath` keeps the helper scoped to the URL asked for.
 */
import type { CreateSandboxConfig, ExecOptions, ExecResult, SandboxHandle } from "./provider.ts";

const TOKEN_ENV = "LOXAIC_GIT_TOKEN";

/** `git -c …` arguments that make git ask the environment for credentials. */
export function gitCredentialArgs(): string[] {
  return [
    "-c",
    `credential.helper=!f() { echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`,
    "-c",
    "credential.useHttpPath=true",
  ];
}

/** The per-command environment that carries the token. `GIT_TERMINAL_PROMPT=0`
 * so a missing or rejected credential fails immediately instead of hanging a
 * non-interactive exec on a prompt nobody can answer. */
export function gitEnv(token: string | undefined): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    ...(token ? { [TOKEN_ENV]: token } : {}),
  };
}

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
  const token = config.git?.token;
  const env = gitEnv(token);
  // Named explicitly rather than inferred from argv: the first non-option
  // argument of the clone is the credential-helper *value*, which would make
  // the error read "git credential.helper=!f() { … } failed".
  const run = async (step: string, command: string[], options?: ExecOptions): Promise<ExecResult> => {
    const result = await handle.exec(command, { ...options, env });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${step} failed (exit ${String(result.exitCode)}): ${redact(result.stderr.trim(), token)}`,
      );
    }
    return result;
  };

  await run(
    "clone",
    [
      "git",
      ...gitCredentialArgs(),
      "clone",
      ...(config.branch ? [`--branch=${config.branch}`] : []),
      "--",
      config.repoUrl,
      dest,
    ],
    { timeoutMs: CLONE_TIMEOUT_MS },
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

/** Scrubs the token out of text that may echo it back. Kept local rather than
 * importing github/connection.ts's redactToken: this module is also used by
 * the plain `POST /v1/sandboxes` path, which has no GitHub connection. */
function redact(text: string, token: string | undefined): string {
  if (!token || token.length < 4) return text;
  return text.split(token).join("[redacted]");
}
