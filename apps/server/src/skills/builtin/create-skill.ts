export const CREATE_SKILL_SKILL = `---
name: create-skill
description: Help write a new skill: a SKILL.md with a name, a description and instructions. Use when someone wants to create or improve a skill.
argument-hint: "[what the skill should do]"
---
# Create a skill

A skill is a \`SKILL.md\` file: YAML frontmatter, then markdown instructions. The
model is shown only the name and description until it decides the skill fits a
task, so those two lines decide whether the skill is ever used.

## 1. Understand the task

Ask, unless you already know:

- What task should the skill help with, and what does a good result look like?
- When should it be used? What would someone say or ask that should trigger it?
- What does it need to know that a capable model would not: house conventions,
  commands, file locations, pitfalls, a required output format?

## 2. Name it

Lowercase letters, digits and single hyphens, at most 64 characters, not
starting or ending with a hyphen: \`release-notes\`, \`db-migration\`. Prefer a
short verb or noun phrase someone would type after a slash.

## 3. Write the description

At most 1024 characters, on one line. Say both **what it does** and **when to
use it**, with the words someone would actually use:

- Good: "Writes release notes from merged pull requests since the last tag,
  grouped by area. Use when preparing a release or asked for a changelog."
- Poor: "Helps with releases."

## 4. Write the instructions

- Numbered steps or short sections, in the order the work happens.
- Exact commands, paths and formats where they matter; examples of input and
  output when the format is the point.
- The edge cases and mistakes to avoid.
- What to report at the end.
- Keep it under about 500 lines. Leave out what any capable model already
  knows; every line is read each time the skill is used.

Optional frontmatter fields: \`argument-hint\` (shown after the name when
typing it, e.g. \`"[version]"\`) and \`disable-model-invocation: true\` (only a
person can run it, by typing its name; the model is not offered it).

## 5. Deliver

Produce the complete \`SKILL.md\` in one code block:

\`\`\`markdown
---
name: example-skill
description: What it does. Use when ….
---
# Example skill

1. …
\`\`\`

Then suggest two or three requests the person could try to check that the
skill is picked up and followed.
`;
