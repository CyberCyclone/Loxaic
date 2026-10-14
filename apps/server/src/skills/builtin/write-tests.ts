export const WRITE_TESTS_SKILL = `---
name: write-tests
description: Write tests that pin behaviour and edge cases in the project's own framework, and prove each can fail. Use when asked to add or improve tests.
argument-hint: "[what to test]"
---
# Write tests

A test is worth having only if it would fail when the behaviour it describes
breaks. Write tests that would.

## 1. Learn the project's conventions

- Find the framework and how tests are run: \`package.json\` scripts,
  \`pytest.ini\`/\`pyproject.toml\`, \`go test\`, \`Cargo.toml\`, a \`Makefile\`, the CI
  configuration.
- Find where existing tests live and copy their style: file names, folder
  layout, helpers, fixtures, how they set up and clean up data.
- Run the existing suite for the area first, so you know what passing looks
  like and whether anything was already failing.

## 2. Decide what to pin

Read the code under test and list the decisions it makes. For each one, plan a
case:

- the ordinary case;
- each branch and early return;
- edge inputs: empty, missing, zero, negative, very large, duplicated, unicode,
  out of order;
- failures: what happens when a dependency throws, times out, or returns
  something unexpected;
- for a bug fix, the exact input that triggered the bug.

If the logic is hard to reach, prefer extracting it into a pure function that
can be tested directly over elaborate mocking.

## 3. Write them

- One behaviour per test, named for that behaviour ("rejects an empty name").
- Assert on outcomes a caller can observe, not on implementation details.
- Keep tests deterministic: no real clocks, random seeds, network or ordering
  assumptions you do not control. Never \`sleep\` to wait for something; wait
  for the condition itself.
- Clean up what a test creates, scoped to what it created, so tests can run in
  parallel.

## 4. Prove each test can fail

Run the new tests and see them pass. Then break the behaviour — revert the fix,
flip a condition, return early — run them again and see them fail for the
right reason. Put the code back. A test that passes either way covers nothing;
rewrite it.

## 5. Report

List the tests added, what each pins, the command that runs them, and the
result. Say what you could not test and why. Do not change the code under test
to make a test pass unless you were asked to fix it; report the failure.
`;
