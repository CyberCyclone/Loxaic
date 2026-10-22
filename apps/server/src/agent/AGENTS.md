# apps/server/src/agent

The agent's server-side pieces: builtin tool execution (`executor.ts`), the per-conversation sandbox manager, file checkpoints, workspace prompts, and the project's own instructions file (`instructions.ts`, `instruction-imports.ts`, `instruction-updates.ts`). Rules here cover sandbox lifetime, untrusted repository content, and keeping the prompt prefix stable.

## Sandbox manager

- Only two things destroy a sandbox: deleting the conversation (`destroyConversationSandboxes`) and `reapAbandonedSandboxes` after `reapAfterMs` (plus an explicit `DELETE /v1/sandboxes/:id`). The idle timer, settings changes and boot sweep only stop.
- A row records the network it was created with (`limits.network` via `networkFor(kind)`); anything describing a workspace's network reads the row, not the current setting.
- `stopAllSandboxes` also sweeps every `running` row in the database; never call it from test cleanup. Use `destroyConversationSandboxes(id)`, and pass `ownerId`/`kind` to `reapAbandonedSandboxes` in tests.
- An entry in `active` is a claim; tests of sweep behaviour must evict it with `__forgetActiveSandboxForTest`.
- Every path that makes a sandbox running (create, resume, image switch, `POST /v1/sandboxes`) reserves its real limits with `reserveSandbox` and releases after the row says `running`; wake a paused sandbox only through `wake()`. Never pause a sandbox to make room (#254), and never pause one whose conversation, or a sub-agent working in it, has a run.
- `createConfigFor` names the conversation owner as the sandbox `ownerId` and egress identity, never the sender, and resolves a workspace's custom image against that owner too.

## Builtin tools (executor.ts)

- `web_fetch` always runs on the server behind the SSRF guard (DNS-resolve, reject private/loopback/link-local, re-check every redirect hop), never in a sandbox.
- `resolvePath` is lexical and POSIX: it is not a symlink boundary, and Windows executors are unsupported.

## Checkpoints (checkpoints.ts)

- Restore takes each path's oldest record from that turn on, deletes paths that did not exist, and skips destinations that became a symlink or directory.
- Deleting a conversation calls `dropConversationCopies` first (from `destroyConversationSandboxes`). No executor-side sweep: several servers can share one `~/.loxaic`.

## Workspace prompt (workspace.ts)

- `local` ignores the server's sandbox mode. Take `executorName` from the live executor at creation, never the client.
- Any run offered the `subagent` tool gets `SUBAGENT_SYSTEM_ADDENDUM` through `assembleSystemPrompt`; every untrusted-content wrapper needs its addendum.
- `parseWorkspaceInput` looks the repo up with the owner's token and takes `clone_url` and the default branch from GitHub's answer; ignore any client-sent `cloneUrl` or `pr` — a client-named URL could point the checkout anywhere.
- `REPO_RE` alone admits `..`: refuse traversal segments, and require the lookup's answer to describe a repository.

## Project instructions: reading

- **Never read a container-isolated workspace through the host folder ref (a symlink would read host files such as SSH keys), and never start a container just to read instructions.**
- Every exec read (root, nested, imports, `cksum`) confines by real path against `REAL_ROOT`, re-checked per chunk in `readChunked`; a candidate leading outside is passed over.
- Escape every path written into a block (NUL-separated lookup output, control characters replaced in the scope line).
- Neutralise the closing tag (zero-width space) in the file and everything between the tags, truncation note included.
- Repository files are hostile: code over them must be linear and must not throw (`parseHeadings` walks backwards once; never spread headings into `Math.min(...)`).

## Project instructions: rendering

- The import resolver refuses absolute, `~` and climbing paths lexically; on GitHub a JSON answer (directory, symlink) is not a file.
- Nested dedupe reads the messages being sent (no stored set) and counts only blocks this module appended: an `fs_read` result with the marker at a line start, keyed with its `cksum`.

## Project instructions: updates (instruction-updates.ts)

- A change after the snapshot reaches the model as an `instructions_update` block on the run's own user row (never a new row, never a system-prompt rewrite); `loadHistory` renders it first.
- Use checksums the workspace reported, never computed server-side.
