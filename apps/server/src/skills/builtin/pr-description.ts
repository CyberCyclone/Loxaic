export const PR_DESCRIPTION_SKILL = `---
name: pr-description
description: Write a pull request description: what changed and why, what was verified, and what the owner must do. Use when opening or updating a pull request.
argument-hint: "[base branch, or anything to emphasise]"
---
# Pull request description

A description is read once, by someone deciding whether and how to merge. Lead
with what they need; keep the reasoning short.

## 1. Gather the facts

- The base branch: the one named, else the repository's default
  (\`gh repo view --json defaultBranchRef\`, or \`git remote show origin\`).
- What the branch contains: \`git log --oneline <base>..HEAD\` and
  \`git diff <base>...HEAD --stat\`, then the diff itself.
- Why: the linked issue (\`gh issue view <n>\`), commit messages, and the
  conversation so far.
- What was verified: the tests and checks that were actually run, and their
  results. Do not claim a check you did not see pass.
- A pull request template, if the repository has one
  (\`.github/pull_request_template.md\` or \`.github/PULL_REQUEST_TEMPLATE/\`):
  follow it, filling its sections with the content below.

## 2. Write it

- **Title:** what the change does, in the imperative, under about 70
  characters, following the repository's conventions.
- **Summary:** a few sentences or bullets on what changed and why. Link the
  issue it closes (\`Closes #123\`).
- **Verified:** the tests added or changed, the commands run and their results,
  screenshots for anything visible.
- **Not verified:** anything that could not be checked, why, and how it was
  checked instead. Never leave this out silently.
- **Risks** worth a reviewer's attention, if any: migrations, behaviour changes
  for existing users, anything hard to roll back.
- **What you need to do:** a numbered checklist of the actions only the owner
  or reviewer can take, in order. Each item gives the exact command or click,
  what should happen when it works, and why it is needed — and what fails if it
  is skipped, when that failure would be silent. If there is nothing, write
  "Nothing. Merge when CI is green."

## 3. Publish only if asked

Opening or editing a pull request is visible to others. If you were asked to,
use \`gh pr create --base <base> --title … --body-file <file>\` (or
\`gh pr edit\`) and report the URL. Otherwise, show the description for the
person to use.
`;
