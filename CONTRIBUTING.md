# Contributing to Loxaic

Thanks for taking the time. Bug reports, fixes and features are all welcome.

## Before you start

- **Read [`AGENTS.md`](AGENTS.md).** It is the source of truth for architecture, conventions
  and gotchas, and most of what would otherwise come up in review is already written there.
- **For anything larger than a bug fix, open an issue first**, so we can agree on the shape
  before you spend time on it.
- **Security problems are never reported in a public issue.** See [`SECURITY.md`](SECURITY.md).

## Workflow

1. Fork the repository and branch from **`dev`** — the trunk. Every pull request targets `dev`;
   `master` and `beta` are release pointers that only move when a release is cut.
2. Make the change. Keep it minimal and match the style of the surrounding code.
3. Run the checks:

   ```bash
   pnpm install
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

   A single package or test: `pnpm --filter @loxaic/server test -- <pattern>`. The server
   tests need Postgres and Redis — `docker compose up db redis` provides both.
4. **User-visible changes need end-to-end coverage** — a spec in `apps/e2e/src/specs/`, and
   screenshots of the behaviour in the pull request description. See "End-to-end tests" in
   `AGENTS.md` and [`apps/e2e/README.md`](apps/e2e/README.md). If a change is not
   user-visible, say so in the pull request instead.
5. Open the pull request against `dev` and fill in the template. CI (lint, typecheck, the Go
   sidecar build and the test suite) has to pass before it can merge.

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/) — that you wrote the
change, or otherwise have the right to submit it under this project's licence:

```bash
git commit -s -m "Describe the change"
```

A check on each pull request enforces this. To sign off commits you have already made:
`git rebase --signoff dev`, then force-push your branch.

## Licence

Loxaic is licensed under the [Apache License 2.0](LICENSE). By contributing you agree that
your contributions are licensed under the same terms.

## For maintainers

- A pull request description ends with a **"What you need to do"** section: the actions only
  the repository owner can take, in order. Contributors can leave it as "Nothing".
- The `dev` ruleset requires a pull request with **zero** approvals, because a sole
  maintainer cannot approve their own pull request. That is safe only while nobody else has
  write access: merging requires write access, so a fork's author can never merge their own
  pull request. **Before granting anyone write access, raise the ruleset to one approval and
  turn on "Require review from Code Owners" and "Require approval of the most recent
  reviewable push"** — otherwise they could merge their own work unreviewed.
