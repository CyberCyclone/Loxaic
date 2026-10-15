# apps/server/src/skills

Skills in the Agent Skills format (`SKILL.md`): built-ins, a person's own, and a workspace's own, merged into a per-conversation catalog offered through the `skill` tool and `/name` messages. Rules here cover parsing untrusted skill files, keeping the prompt prefix fixed, and what a repository may do.

## Parsing (format.ts)

- Every skill goes through `format.ts`. Retry an unquoted value containing a colon as quoted; load a rule-breaking but typeable name with a warning; refuse a missing description or unreadable frontmatter.
- Refuse YAML aliases (`maxAliasCount: 0`) and cap the frontmatter before parsing; a workspace skill is a stranger's file.
- Built-ins are strings in `builtin/*.ts`, never loose `.md` files: the desktop ships only the server's `dist/`. Keep each built-in description to one sentence; the list rides every request and must fit the 4K-window prefix test.

## Resolution

- A skill set is always the conversation owner's, never the sender's; two editors' catalogs would announce each other's skills every turn.
- `/compact` is a built-in, `disable-model-invocation` skill whose action is harness compaction; it rides `command.run`. A workspace may never define a reserved name (`isReservedSkillName`); only a person may override `/compact`.

## Output to the model

- Wrap skill content in `<skill-content name source>` with closing tags neutralised. Never echo the model's `name` unless `isUsableSkillName` (`answerSkillCall`); it is replayed every turn and a lone surrogate breaks the jsonb insert.
- Every run offered the skill tool gets `SKILL_SYSTEM_ADDENDUM`, keyed on the tool so the system prompt stays fixed.
- Prefix workspace skill content with `WORKSPACE_SKILL_NOTE`.

## Frozen catalog (session.ts)

- `base` takes the live list only when `historyFront` moves. A rewind that removes a notice drops `latest`. A frozen empty list later told of a skill gets the tool added.

## Workspace skills (workspace.ts)

- Scan the way project instructions are read: the executor for a direct folder, a live container or checkout only (`workspaceExec`), the contents API before a clone. Never start anything just to scan.
- Confine every exec read by real path (`REAL_ROOT`); pass over a skill directory linked outside the repository.
- One scan gets 30 s in all (`SKILL_SCAN_BUDGET_MS`); what it did not read goes in `problems` and is not rescanned until something changes. Preserve `problems` through `coerceScan`.
- Cap descriptions at 8 KB total (`MAX_REPO_SKILL_LIST_BYTES`) as well as the 100-skill cap.
