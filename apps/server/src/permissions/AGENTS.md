# apps/server/src/permissions

Per-command `bash` permissions (`bash/`), command rules, isolation, and the model permission check for auto mode outside isolation. The command string is the model's, so every parser here takes hostile input.

## Parsing (`bash/parse.ts`)

- Judge `bash` per simple command: split across `&& || ; | &`, newlines, `( )`, `$( )` and backticks, in a single pass with the 16 KB and nesting caps.
- Anything not understood for certain (loops, `eval`, process substitution, a computed command name) is unparseable, and an unparseable command asks.

## Decision order (`bash/policy.ts`, `decideBash`)

- A command is only as allowed as its least allowed part. Per part: the person's deny rules, ask rules, allow rules, then built-in always-ask (`git push`, gh writes, non-GET `gh api`, `sudo`), then the built-in read-only set (`bash/readonly.ts`), then the mode: manual asks; auto runs it in an isolated sandbox, else goes to the permission check; planning refuses.
- In planning, user allow rules do not count, and planning's refusal is judged before ask rules (an ask rule must not turn a refusal into an approvable prompt).

## Read-only set (`bash/readonly.ts`)

- Read-only decides who is asked; it is not containment. Never add `curl`, `wget`, `git ls-remote <url>`, `awk`, `xargs`, `tee` or an interpreter.
- A part qualifies only with: no write redirect (except `/dev/null`), nothing under `/dev/tcp`, a bare command name, only cosmetic env prefixes (never `PAGER`/`GIT_PAGER`/`GH_PAGER`), and none of `sed -i` or a `w`/`e` flag, `find -exec`, `sort -o`, `git -c`, `git diff --output`, `rg --pre`/`--pre-glob`/`--hostname-bin`, `gh api` with fields.
- **`ghApiIsReadOnly` is a flag allowlist**: every method given, in every form (`-X GET`, `-XDELETE`, `-X=DELETE`, combined shorthands, repeated `-X` where the last wins) must be GET; refuse method-override headers; any flag not on the list makes it not read-only.
- In auto mode outside isolation, `fs_write`/`fs_edit` into `.git`, outside the workspace, or under `~` goes to the permission check (`isSensitiveWrite` in `isolation.ts`).
- Known residual risk: git textconv and filter drivers in a model-written `.git/config` still run under read-only commands.

## Command rules (`bash/rules.ts`, `store.ts`)

- A rule is plain words with an optional trailing `*`, matched word by word against the unquoted argv.
- Allow rules match strictly: no unusual env prefix, no redirect outside the working directory or into `.git`. Deny and ask rules match loosely (basename, ignoring both) — erring there only asks more.
- The validator refuses `*` alone, shell syntax, and a wildcard on an interpreter or wrapper (`python *` allows every program).
- "Allow always" records only what the server proposed (`rules` on `approval.request`), never a client-named rule: command plus subcommand levels, or the exact command for `rm`/`curl`/interpreters. Offer nothing if any part needing approval lacks an exact rule.
- Rules are one row each in `command_rules`, read once per run; "Allow always" also adds to the run's in-memory list. Record only the run sender's "always".

## Isolation (`isolation.ts`)

- Isolated means a server container with no network: the sandbox row's `limits.network`, else the setting. GitHub workspaces, host mode, networked containers and local workspaces are never isolated.

## Permission check (`check.ts`)

- The check extends the run's own request (prefix reuse): the messages sent plus the tool-call message, a placeholder result for every unanswered call in the batch, the instruction as the last user turn, the run's tools and thinking fields, `tool_choice: "none"`. Persist nothing.
- Only an exact `VERDICT: ALLOW` in the reply text allows; the last `VERDICT:` line wins and reasoning is never read. A refusal, tool call, missing verdict, timeout or error asks the person, with `check` on the approval saying why. A stop records the call as stopped.
- It runs under the run's slot; its usage row has `purpose = 'permission_check'` and no `message_id`.
- An admin-set `permissionCheckModel` gets a short standalone prompt instead. `PERMISSION_CHECK_TIMEOUT_MS` pins the timeout, read at call time, reported in `envOverrides`; the API answers 409 for a pinned field.
