export const COMMIT_SKILL = `---
name: commit
description: Commit work with git, following the repository's message and sign-off conventions. Use when asked to commit or write a commit message.
argument-hint: "[anything the message should mention]"
---
# Commit

## 1. See what is about to be committed

- \`git status\` and \`git diff\`, then \`git diff --staged\`.
- Stage only what belongs to this change. If the working tree holds unrelated
  edits, leave them unstaged (\`git add <paths>\`, or \`git add -p\`) and say so.
- Never commit secrets, credentials, \`.env\` files, large generated files or
  build output. If one is staged, unstage it and tell the person.
- If the repository has a quick check (formatter, linter, type check, tests)
  that its contributors run before committing, run it.

## 2. Follow the repository's conventions

- Read recent history: \`git log --oneline -20\` and a few full messages with
  \`git log -5\`. Match their form: plain sentences or a prefix such as
  \`feat:\`/\`fix:\`, capitalisation, issue references.
- Check \`CONTRIBUTING.md\` and any instructions file (AGENTS.md, CLAUDE.md)
  for commit rules.
- If commits carry \`Signed-off-by:\` lines (a DCO), commit with \`git commit -s\`.

## 3. Write the message

- **Subject:** one line, at most about 72 characters, in the imperative ("Fix
  the retry loop", not "Fixed" or "Fixes"), saying what the commit does.
- **Body**, after a blank line, when the subject is not enough: why the change
  was needed and anything a reviewer would not see from the diff — the cause of
  a bug, a trade-off, what was deliberately left out. Wrap at about 72
  characters.
- One logical change per commit. If the staged work is several unrelated
  changes, suggest splitting it.

## 4. Commit

- Commit with the message. Do not use \`--no-verify\` to skip hooks; if a hook
  fails, fix the cause or report it.
- Do not amend or rewrite commits that have already been pushed, and do not
  push, unless you were asked to.
- Show the resulting \`git log -1 --stat\`.
`;
