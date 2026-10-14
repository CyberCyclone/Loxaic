/**
 * `/compact`: summarise the conversation and carry on from the summary.
 *
 * The one built-in whose "instructions" are an action the harness performs
 * (`action: "compact"` in ./index.ts), so the body below is what the Skills
 * screen shows a person, never something a model is given. And only a person
 * runs it: `disable-model-invocation` keeps it out of the model's catalog, as
 * Claude Code, Codex and OpenCode all do — automatic compaction already acts
 * on a full window, and a model compacting on its own would throw away
 * history nobody chose to lose and pay a full re-read of the prompt for it.
 */
export const COMPACT_SKILL = `---
name: compact
description: Summarize the conversation and continue from the summary. Add guidance after the name to say what the summary must keep, e.g. "/compact keep the plan fully intact".
argument-hint: "[guidance]"
disable-model-invocation: true
---
Compacting replaces everything sent to the model so far with a summary of it.
The conversation stays on screen as it was; what changes is what the model is
sent from here on, which frees room in its context window.

Anything typed after \`/compact\` is guidance for the summary: what to keep in
full, or what to focus on.

Loxaic also compacts by itself when a conversation nears the model's window,
whether or not this skill is used.
`;
