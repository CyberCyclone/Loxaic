export const DEBUG_SKILL = `---
name: debug
description: Find and fix a bug's root cause: reproduce it, test one hypothesis at a time, prove the fix with a test. Use for crashes, errors, wrong output or failing tests.
argument-hint: "[the symptom]"
---
# Debug

Find out why before changing anything. A fix for a cause you have not found is
a guess.

## 1. Reproduce

- Get the exact symptom: the full error message and stack trace, the input,
  the expected and the actual result.
- Reproduce it yourself, with the smallest command or test you can. If it is
  intermittent, find what makes it more likely (load, ordering, timing) and
  how often it happens.
- If you cannot reproduce it, say so and gather more evidence before touching
  code.

## 2. Read the evidence

- Read the whole error and the stack trace from the bottom of your own code
  upwards. Open each frame.
- Check what changed recently: \`git log -p\` on the files involved;
  \`git bisect\` when it used to work and you know a good commit.
- Read the logs around the failure, and the configuration and environment it
  ran with.

## 3. Hypothesise and test, one at a time

- Write down the most likely cause and what you would observe if it were true.
- Test that prediction directly: a log line, a breakpoint, a smaller input, a
  unit test of one function. Change one thing at a time.
- When a hypothesis is wrong, discard it; do not stack fixes for causes you
  have not confirmed.
- Keep narrowing until you can point at the line that is wrong and explain
  exactly why it produces the symptom.

## 4. Fix the cause

- Make the smallest change that corrects the cause. If the same mistake exists
  elsewhere, fix it there too or say where it is.
- Do not suppress the symptom (catching and ignoring an error, adding a retry,
  a sleep, or a special case for one input) unless that genuinely is the right
  behaviour, and say so if it is.

## 5. Prove it

- Add a test that reproduces the bug. Run it against the code before the fix
  and see it fail; run it after and see it pass.
- Run the surrounding tests to check nothing else broke.
- Remove any temporary logging or debugging code.

## 6. Report

State the root cause in a sentence or two, the fix, how you proved it, and
anything you noticed but did not change.
`;
