/**
 * GitHub permission refusals, turned into words that name the permission to fix.
 *
 * Every layer of this integration said the wrong thing about the same token. A
 * fine-grained PAT holding only `Metadata: read` answers `GET /user` (so the
 * connect screen says "Connected"), answers `GET /user/repos` and
 * `GET /repos/{owner}/{repo}` (so the repository is listed, selectable, and a
 * workspace is created against it), and fails first *inside a container*, on
 * the clone — where the only thing that ever reached the user was the model
 * narrating git's stderr.
 *
 * That stderr names the wrong permission. GitHub answers a **read-only** clone
 * it will not serve with `remote: Write access to repository not granted`, so
 * the single message a person did see pointed at write access when what was
 * missing was `Contents: read`. Anyone acting on it would grant the wrong
 * thing and still be stuck.
 *
 * **Zero imports, deliberately.** `sandbox/host-provider.ts` imports
 * `cloneInto` from `sandbox/git.ts`, and `executor/__tests__/isolation.test.ts`
 * walks the executor's module graph through it, forbidding `@loxaic/db`.
 * `github/connection.ts` imports the database, so a translator that dragged
 * this module toward the sandbox layer would fail that test outright. Keeping
 * this file dependency-free is what lets every consumer translate in place —
 * the connect route, the workspace pre-flight, the tool loop, and the git
 * routes — without any of them inheriting an import the others cannot have.
 */

/** Which operation was refused. The caller knows this; the error text does
 * not, and cannot be trusted to (see the read-only clone above). */
export type GithubNeed = "contents-read" | "contents-write" | "pull-requests";

/** The shapes GitHub uses to say "this token may not do that". The text branch
 * is load-bearing rather than a belt-and-braces extra: a failed clone arrives
 * as git's stderr with no HTTP status attached anywhere, so matching on the
 * message is the *only* way that case is ever recognised.
 *
 * Deliberately stops at "resource not accessible by" rather than requiring the
 * noun that follows. Every message reaching this module has already been
 * through a redaction pass that replaces the token string wherever it appears
 * — and `client.ts`'s pass has no minimum length — so a short token turns
 * GitHub's "personal access token" into "personal access [redacted]en" and a
 * matcher anchored on that noun stops recognising the very case it exists for.
 * Matching the part GitHub's wording owns, and redaction cannot reach, is the
 * property worth having. */
const PERMISSION_TEXT = /not granted|resource not accessible by|must have admin rights/i;

/**
 * A 403 that is not about permissions at all.
 *
 * GitHub spends 403 on rate limiting as well as on refusals, so keying purely
 * on the status would tell someone to go edit their token's scopes when what
 * actually happened is that they made too many requests — advice that is both
 * wrong and unfollowable. Checked before the status, never after.
 */
const NOT_A_PERMISSION_PROBLEM = /rate limit|secondary rate|abuse detection|has been blocked/i;

/** What GitHub itself said, with our own `GitHub API <status>: ` prefix
 * stripped, so "did it explain itself?" is a question about GitHub's words
 * rather than about ours. */
function githubSaid(message: string): string {
  return message.replace(/^GitHub API \d+:\s*/, "").trim();
}

export function isGithubPermissionFailure(status: number | undefined, message: string): boolean {
  if (NOT_A_PERMISSION_PROBLEM.test(message)) return false;
  if (PERMISSION_TEXT.test(message)) return true;
  // A bare `status === 403` used to be enough, and it was too broad. GitHub
  // spends 403 on refusals that name their own fix and have nothing to do with
  // a token's permissions: an archived repository ("Repository was archived so
  // is read-only"), SAML enforcement ("You must grant your Personal Access
  // token access to this organization"), a push-protection or ruleset block
  // naming the offending commit. Translating those threw away the one sentence
  // that would have helped and substituted a permission the user had already
  // granted — the same wrong-permission failure this module exists to prevent,
  // arrived at from the other direction.
  //
  // So a 403 only counts on its own when GitHub said nothing at all, where
  // there is no wording of its to preserve.
  return status === 403 && githubSaid(message).length === 0;
}

/** What to grant, per operation. Split out so the three sentences below stay
 * readable and so the fine-grained and classic answers are given together —
 * a user holding the wrong *kind* of token is the other half of this bug. */
const FIX: Record<GithubNeed, (repo: string) => string> = {
  "contents-read": (repo) =>
    `Your GitHub token cannot read the contents of ${repo}. ` +
    "A fine-grained token needs Contents: Read on that repository; a classic token needs the repo scope. " +
    'GitHub\'s own message here says "Write access ... not granted" even for a read-only clone, ' +
    "so the permission to add is Contents, not anything about writing.",
  "contents-write": (repo) =>
    `Your GitHub token cannot write to ${repo}. ` +
    "A fine-grained token needs Contents: Read and write on that repository; a classic token needs the repo scope.",
  "pull-requests": (repo) =>
    `Your GitHub token cannot open pull requests on ${repo}. ` +
    "A fine-grained token needs Pull requests: Read and write on that repository; " +
    "a classic token needs the repo scope.",
};

const HOW_TO_FIX =
  " Update the token at github.com → Settings → Developer settings, then reconnect GitHub in Settings.";

/**
 * The sentence to show a person, or **null when this failure is something
 * else** — a rate limit, an outage, a 404, a timeout.
 *
 * Null rather than a best guess on purpose: every caller already has a message
 * of its own, and mislabelling an outage as a missing scope sends someone to
 * edit a token that was fine. Translating only what we can actually recognise
 * is the whole point of the module.
 */
export function describeGithubPermissionFailure(input: {
  status?: number;
  message: string;
  repo?: string;
  need: GithubNeed;
}): string | null {
  if (!isGithubPermissionFailure(input.status, input.message)) return null;
  // A repo name is not always in hand (the connect screen has no repository in
  // mind at all), and "that repository" reads better there than an empty gap.
  return FIX[input.need](input.repo ?? "that repository") + HOW_TO_FIX;
}
