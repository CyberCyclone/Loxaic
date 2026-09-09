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
 *
 * Three things bound *who receives* the token and *what runs beside it*,
 * because the checkout it is used in is one the model writes to freely:
 *
 * - The helper list is **reset** first (`credential.helper=`): `-c` appends
 *   rather than replaces, and a `credential.helper = store` in the account's
 *   own gitconfig — host mode runs as that account — would otherwise be
 *   handed the token by git's post-auth `approve` and write it, plaintext,
 *   to `~/.git-credentials`. `file://` clones never consult a helper, which
 *   is why the tests never saw it.
 * - The helper answers **only for the expected host** (`$LOXAIC_GIT_HOST`,
 *   from the clone URL): it reads the `host=` line git writes to its stdin
 *   and stays silent for any other. A `git remote set-url origin
 *   https://attacker/…` is one bash tool call, and a helper that ignores its
 *   stdin would POST the owner's token wherever origin now points. (Note
 *   `credential.useHttpPath` does *not* scope a custom helper — it only adds
 *   the path to the lookup key for storage helpers.)
 * - Hooks, fsmonitor and proxies are **off** for the command: `git push`
 *   runs `.git/hooks/pre-push` from the checkout with the token in its
 *   environment, and `core.fsmonitor` / `http.proxy` / `http.sslVerify` in a
 *   model-writable `.git/config` are command execution and interception
 *   respectively. Command-line config outranks the repo's.
 *
 * What this does **not** close: a model that actively controls the container
 * at the moment of the push — a shim `git` earlier on PATH, a process editing
 * config between check and use — shares a uid with the exec and can still
 * reach the token. The sturdier shape is to never hand git the token inside
 * the sandbox at all, pushing from the server against a bundle of the branch;
 * that is a follow-up, and until then the push remains a deliberate action
 * the owner takes from the Inspector, with these bounds on the passive cases.
 */
import type { CreateSandboxConfig, ExecOptions, ExecResult, SandboxHandle } from "./provider.ts";

const TOKEN_ENV = "LOXAIC_GIT_TOKEN";
const HOST_ENV = "LOXAIC_GIT_HOST";

/** The helper, as a shell function: reads what git asks about, answers only
 * for the expected host. Exported for the test that feeds it stdin. */
export const CREDENTIAL_HELPER =
  `!f() { h=""; while IFS= read -r l; do case "$l" in host=*) h="\${l#host=}";; esac; done; ` +
  `if [ -n "$${HOST_ENV}" ] && [ "$h" != "$${HOST_ENV}" ]; then exit 0; fi; ` +
  `echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;

/** `git -c …` arguments that make git ask the environment for credentials,
 * and nothing in the checkout for anything else. */
export function gitCredentialArgs(): string[] {
  return [
    // An empty value resets the helper list; only helpers after it apply.
    "-c", "credential.helper=",
    "-c", `credential.helper=${CREDENTIAL_HELPER}`,
    "-c", "credential.useHttpPath=true",
    // Nothing from the checkout runs alongside the token.
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    // Nothing from the checkout sits between git and the host.
    "-c", "http.proxy=",
    "-c", "http.sslVerify=true",
  ];
}

/** The per-command environment that carries the token. `GIT_TERMINAL_PROMPT=0`
 * so a missing or rejected credential fails immediately instead of hanging a
 * non-interactive exec on a prompt nobody can answer. `remoteUrl` is what the
 * helper will answer for; with no token there is nothing to scope. */
export function gitEnv(token: string | undefined, remoteUrl?: string): Record<string, string> {
  const host = remoteUrl ? hostOf(remoteUrl) : null;
  return {
    GIT_TERMINAL_PROMPT: "0",
    ...(token ? { [TOKEN_ENV]: token } : {}),
    ...(token && host ? { [HOST_ENV]: host } : {}),
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
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
  const env = gitEnv(token, config.repoUrl);
  // Named explicitly rather than inferred from argv: the first non-option
  // argument of the clone is the credential-helper *value*, which would make
  // the error read "git credential.helper=!f() { … } failed".
  //
  // The token rides on the clone alone (it passes `env` itself). The checkout
  // and config steps after it run with the remote's content already on disk
  // and need no credential, so they get none.
  const run = async (step: string, command: string[], options?: ExecOptions): Promise<ExecResult> => {
    const result = await handle.exec(command, { env: gitEnv(undefined), ...options });
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
    { timeoutMs: CLONE_TIMEOUT_MS, env },
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
