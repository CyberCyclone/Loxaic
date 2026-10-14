# apps/server/src/skills

Skills in the Agent Skills format (`SKILL.md`): built-ins, a person's own, and a workspace's own, merged into a per-conversation catalog offered through the `skill` tool and `/name` messages. Rules here cover parsing untrusted skill files, keeping the prompt prefix fixed, and what a repository may do.

## Parsing (format.ts)

- Every skill goes through `format.ts`. Retry an unquoted value containing a colon as quoted; load a rule-breaking but typeable name with a warning; refuse a missing description or unreadable frontmatter.
- Refuse YAML aliases (`maxAliasCount: 0`) and cap the frontmatter before parsing; a workspace skill is a stranger's file.
- Built-ins are strings in `builtin/*.ts`, never loose `.md` files: the desktop ships only the server's `dist/`. Keep each built-in description to one sentence; the list rides every request and must fit the 4K-window prefix test.
- `model_invocable` is the inverse of the format's `disable-model-invocation`.

## Resolution

- A skill set is always the conversation owner's, never the sender's; two editors' catalogs would announce each other's skills every turn.
- A name defined twice resolves workspace, then the person's own, then built-in (`mergeSkillLayers`).
- `/compact` is a built-in, `disable-model-invocation` skill whose action is harness compaction; it rides `command.run`. A workspace may never define a reserved name (`isReservedSkillName`); only a person may override `/compact`.
- A sub-agent uses its parent owner's live list and its parent's last scan, and stores nothing.

## Output to the model

- Wrap skill content in `<skill-content name source>` with closing tags neutralised. Never echo the model's `name` unless `isUsableSkillName` (`answerSkillCall`); it is replayed every turn and a lone surrogate breaks the jsonb insert.
- Every run offered the skill tool gets `SKILL_SYSTEM_ADDENDUM`, keyed on the tool so the system prompt stays fixed.
- Prefix workspace skill content with `WORKSPACE_SKILL_NOTE`.

## Frozen catalog (session.ts)

- On a `/name` message, `prepareRunSkills` appends a `{kind: "skill"}` block with the instructions as at send time to the user row, before the toolset is built. A retry answers the same row and must not add it twice.
- The catalog is frozen per conversation (`conversations.skill_catalog.base`, taken on the first run). A change becomes a `skills_update` notice on the next user row, with `latest` recording what was told; never re-render the tool list.
- `base` takes the live list only when `historyFront` moves. A rewind that removes a notice drops `latest`. A frozen empty list later told of a skill gets the tool added.
- **Write a notice and `latest` in one transaction.** On failure return the list the conversation already had, so the prompt's front does not move.

## Workspace skills (workspace.ts)

- Found at the workspace root in `.agents/skills`, `.claude/skills`, `.opencode/skills`, `.opencode/skill`, in that order; the first definition wins. Only for agent conversations with a github or local workspace.
- Store only the catalog (`conversations.repo_skills`: name, description, directory, file hash); read the instructions from the workspace on each use.
- Scan the way project instructions are read: the executor for a direct folder, a live container or checkout only (`workspaceExec`), the contents API before a clone. Never start anything just to scan.
- Using a skill is explicit, so it may start the sandbox (clone, resume), as `fs_read` does.
- Confine every exec read by real path (`REAL_ROOT`); pass over a skill directory linked outside the repository.
- Rescan when the one-exec `cksum` listing differs; announce only description or file-hash changes. A failed scan backs off and keeps the earlier scan.
- One scan gets 30 s in all (`SKILL_SCAN_BUDGET_MS`); what it did not read goes in `problems` and is not rescanned until something changes. Preserve `problems` through `coerceScan`.
- Cap descriptions at 8 KB total (`MAX_REPO_SKILL_LIST_BYTES`) as well as the 100-skill cap.
- List a skill's other files NUL-separated from its resolved directory, at most `MAX_LISTED_FILES`. Exclude its own SKILL.md by string comparison (`find -path` reads brackets as a pattern) and count in our code (`head -z` is absent on macOS).
