# Why the agent cannot reach GitHub, and what it would cost to change

An investigation, not an implementation. Nothing in this document changes
behaviour; it records what the code does today, why, and which routes forward
are actually open.

## The question

The agent is working in a clone of a GitHub repository, so it seems natural that
it should be able to `git push`, open a pull request, or read an issue. It
cannot do any of those, and the expectation behind the question is that the
personal access token is handed to the sandbox and something is broken.

The token is not handed to the sandbox. That is deliberate, and it is the single
most carefully defended property in `apps/server/src/sandbox/git.ts`.

## The short answer

Three independent conditions each block GitHub access on their own. Removing any
one of them changes nothing.

1. **No credential survives the clone.** The token exists in exactly one exec's
   environment, for the duration of the clone, and nowhere else.
2. **The checkout carries no credential helper.** A later `git push` run by the
   model finds nothing in `.git/config` and has nothing in its environment to
   read.
3. **By default there is no egress at all.** Sandbox containers run with
   `NetworkMode: "none"`.

The system prompt additionally tells the model not to try.

## The evidence

### The token rides one exec and is then gone

`gitEnv(undefined)` is exactly `{ GIT_TERMINAL_PROMPT: "0" }`. `cloneInto` makes
that the default for every step and only the clone itself overrides it, so the
`checkout -b` and the two `git config` steps that follow run with no credential.
The environment is per-exec rather than per-container: the container is created
with no `Env` at all from the server path, and the model's own `bash` tool passes
none. A repository-wide search finds only two places that set an exec
environment, the MCP server row and the server-driven push.

Nothing lands on disk either. `sandbox/__tests__/git.test.ts` clones with a token
and then greps the entire `.git` directory for it, asserting no match.

### What the model would actually see

Two different failures, depending on configuration.

With networking off, it never reaches authentication. The container cannot
resolve `github.com`.

With networking on, it fails at authentication without a prompt. The credential
helper is passed with `-c` for one command only and is never written into the
checkout, so a model-run `git push` consults the checkout's config, finds no
helper, and has no token in its environment to read even if it reconstructed the
helper text itself.

This matters more than it first appears: **a GitHub workspace requires
networking to be on**, because the clone happens inside the sandbox. So in
exactly the conversations where a repository is checked out, egress does exist,
and the missing credential is the only thing standing between the model and the
network.

### The image

The sandbox image installs `git`, `curl`, `build-essential`, `ca-certificates`,
`poppler-utils`, Node 22, Python and a set of document-parsing libraries. The
`gh` CLI is **not** installed anywhere in the image. `curl` is, so
`curl https://api.github.com/...` exists as a binary, with no credential to send.

The container also drops all capabilities, sets `no-new-privileges`, and runs as
a non-root user.

### What the prompt says

The GitHub workspace prompt ends: "Commit your work with clear messages as you
go. Do not push, create other branches, or open pull requests — the user does
that from the interface."

Worth noting that this is normative, not descriptive. It tells the model what not
to do; it does not tell it that pushing is impossible. A model that tries anyway
gets an opaque git failure rather than an explanation.

## What the current design is defending against

The reasoning is recorded in `sandbox/git.ts` and is worth restating, because any
proposal has to answer it:

- **A model that can read the checkout.** A token in the remote URL is written
  into `.git/config`, where the model can `cat` it and exfiltrate it through
  `web_fetch`, which runs server-side and therefore has network even when the
  sandbox does not.
- **A model that rewrites `origin`.** `git remote set-url origin
  https://attacker/...` is one tool call. The credential helper answers only for
  the host the token was issued for, and the push route separately refuses unless
  `origin` still matches the workspace's clone URL.
- **Code in the checkout running beside the credential.** Hooks, fsmonitor and
  proxies are disabled for the credentialed command, because `git push` would
  otherwise run `.git/hooks/pre-push` from a model-writable checkout with the
  token in its environment.
- **Egress as an exfiltration path**, which is why networking is off by default.

And what it explicitly does **not** close: a model that actively controls the
container at the moment of the push, through a shim `git` earlier on `PATH`, for
instance, shares a uid with the exec and can still reach the token. That residual
is the entire motivation for the first option below.

## What already works

Authenticated GitHub access is concentrated in owner-only server routes, none of
which run in the sandbox: status, commit, push and pull request creation. Each
requires owner role on the conversation and refuses with a 409 while a run is
active, so a click cannot race the agent's own tool calls. Pull requests are
created from the server process over the REST API, never from the sandbox.

The model can also reach **public** GitHub data through `web_fetch`, which runs
server-side behind an SSRF guard and never attaches an authorization header.
That covers public repositories at the server's shared rate limit, and nothing
private.

## The options, and what each costs

### 1. Push from the server against a bundle (recommended)

Already named as the intended follow-up in `sandbox/git.ts`. The sandbox never
receives a token at all: the server asks the sandbox for a bundle of the branch,
reads it out, and pushes from its own process.

- **Closes** the one gap the current design admits, since there is no credential
  in the container to race for.
- **Costs** a bundle round trip, and `origin` inside the checkout becomes
  decorative.
- Does not by itself give the agent autonomous pushes; it makes the existing
  owner-driven push safer.

### 2. Server-mediated GitHub tools

Give the tool loop a small set of authenticated GitHub actions: open a pull
request, read an issue, comment, read CI status. The server holds the token and
performs the call; the model names an action and sees a result.

- **The token never enters the sandbox**, so the whole threat model above is
  untouched.
- The model gains genuine capability, including the CI-iteration loop that
  currently requires a human round trip.
- **Costs** an approval story. These are write actions against someone's
  repository, so they belong behind the existing approval machinery rather than
  running free in auto mode.

### 3. A GitHub MCP server

Already possible today with no new code: a user can add one through the MCP
settings. Credentials live in the server process, encrypted at rest, injected
per call, and redacted from every error path. The model can invoke authenticated
operations by name but never sees the token.

- **Costs** the untrusted-output problem that MCP results already carry, and MCP
  tools ask for approval in every mode until allowlisted.
- Overlaps heavily with option 2, but as configuration rather than a feature.

### 4. Put the token in the sandbox

Mechanically possible. This is precisely what the current design refuses, for the
reasons listed above. Recorded here so the trade is explicit, not because it is
recommended.

## Recommendation

The capability is worth having and can be added securely, but not by passing the
PAT into the sandbox. The two shapes that keep the token in the server process
are options 1 and 2, and they are complementary: the bundle push hardens what
exists, and server-mediated tools are what actually let the agent work with
GitHub rather than only in a checkout of it.

If only one is done, option 2 delivers the capability the question was really
asking for.

## Open questions

- Which GitHub actions are worth exposing, and which must always stay a human's
  click. Opening a pull request is arguably the user's decision by definition,
  which is why it lives in the Inspector today.
- Whether server-mediated tools should be builtins or an MCP server, given
  option 3 already exists as configuration.
- Whether the prompt should say that pushing is impossible rather than merely
  forbidden, so a model that tries gets an explanation instead of an opaque git
  failure.
