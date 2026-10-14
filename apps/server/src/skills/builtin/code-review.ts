export const CODE_REVIEW_SKILL = `---
name: code-review
description: Review code changes for correctness bugs, reporting only verified defects with file:line and a failing scenario. Use when asked to review a diff, branch or pull request.
argument-hint: "[what to review, e.g. a PR number or branch]"
---
# Code review

Find the defects in a change that would make it behave wrongly. A short list of
real bugs is worth more than a long list of possibilities.

## 1. Establish what changed

- If you were told what to review (a pull request, a branch, a commit range, a
  file), review exactly that.
- Otherwise review the work in progress: \`git status\`, then \`git diff\` and
  \`git diff --staged\`. If those are empty, compare the branch with its base:
  \`git merge-base HEAD origin/main\` (or the repository's default branch), then
  \`git diff <base>...HEAD\`.
- For a GitHub pull request: \`gh pr diff <number>\` and \`gh pr view <number>\`.
- Read the description, linked issue, or commit messages to learn what the
  change is *meant* to do. A bug is a difference between intent and behaviour.

## 2. Read beyond the diff

A diff hides most bugs. For every changed function, read:

- its whole body, not just the changed lines;
- its callers, to see what they pass and what they rely on;
- what it calls, when the change depends on that behaviour;
- the tests that cover it, if any.

## 3. Hunt

Walk the changed code path by path. Look for:

- **Logic:** inverted conditions, off-by-one, wrong operator, a branch that can
  never run, an early return that skips cleanup.
- **Edge cases:** empty, null or undefined, zero, negative, very large, unicode,
  duplicate, out-of-order input.
- **Errors:** an exception swallowed, an error path that leaves state half
  written, a promise not awaited, a failure reported as success.
- **State and concurrency:** two requests at once, a retry, a restart halfway
  through, a stale cache, a check followed by a separate use.
- **Contracts:** a changed signature or return shape whose callers were not
  updated, an API that now behaves differently for existing clients.
- **Resources:** files, sockets, timers or listeners that are never released.
- **Security:** untrusted input reaching a query, a shell, a path, a URL or
  HTML; a check that can be skipped. (For a full security pass, use the
  \`security-review\` skill.)

## 4. Verify every finding

Before reporting something, convince yourself it is real:

- Trace concrete input through the code to the wrong output or crash.
- Check that nothing upstream already prevents it.
- Where you can, prove it: run the code, or write a small failing test.

Drop anything you cannot turn into a concrete scenario. Do not report style,
naming, or formatting unless asked.

## 5. Report

Most severe first. For each finding:

- **Where:** \`path/to/file.ts:123\`
- **What:** one sentence stating the defect.
- **Scenario:** the input or sequence of events, and what goes wrong.
- **Fix:** the change that would correct it, briefly.

Say how sure you are when you could not prove it. If you found nothing, say so
plainly, and name what you checked.
`;
