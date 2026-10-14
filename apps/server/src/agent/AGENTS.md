# apps/server/src/agent

The agent's server-side pieces: builtin tool execution (`executor.ts`), the per-conversation sandbox manager, file checkpoints, workspace prompts, and the project's own instructions file (`instructions.ts`, `instruction-imports.ts`, `instruction-updates.ts`). Rules here cover sandbox lifetime, untrusted repository content, and keeping the prompt prefix stable.

## Sandbox manager

- Sandboxes are per conversation, created lazily on first tool use, and survive socket close (`sandbox-manager.ts`). A mode switch makes old rows unusable; never reattach a row to another provider kind.
- Only two things destroy a sandbox: deleting the conversation (`destroyConversationSandboxes`) and `reapAbandonedSandboxes` after `reapAfterMs` (plus an explicit `DELETE /v1/sandboxes/:id`). The idle timer, settings changes and boot sweep only stop.
- `last_used_at` is flushed on the reaper tick, not per tool call. Tick order is flush, idle-stop, abandoned-reap; `reapAbandonedSandboxes` skips anything in the in-memory `active` map.
- Rows still marked `running` are reap-eligible (a crash leaves them that way).
- The per-user cap counts running sandboxes only. Resuming a paused one reserves against the cap in both `createEntry` and `attachRunningSandbox`; `attachRunningSandbox` must register the woken sandbox in `active`.
- A row records the network it was created with (`limits.network` via `networkFor(kind)`); anything describing a workspace's network reads the row, not the current setting.
- `reap_at` is derived on read (`sandboxReapAt()`), never stored.
- `stopAllSandboxes` also sweeps every `running` row in the database; never call it from test cleanup. Use `destroyConversationSandboxes(id)`, and pass `ownerId`/`kind` to `reapAbandonedSandboxes` in tests.
- An entry in `active` is a claim; tests of sweep behaviour must evict it with `__forgetActiveSandboxForTest`.
- `createConfigFor` names the conversation owner as the sandbox `ownerId` and egress identity, never the sender.

## Builtin tools (executor.ts)

- `web_fetch` always runs on the server behind the SSRF guard (DNS-resolve, reject private/loopback/link-local, re-check every redirect hop), never in a sandbox.
- `web_fetch` strips markup before truncating: `WEB_FETCH_MAX_RAW_BYTES` bounds wire bytes (streamed), `WEB_FETCH_MAX_BYTES` bounds extracted text. htmlToText must drop a trailing unterminated script/style. Keep `extractFetchText` pure and exported.
- `fs_read` pages with `offset`/`limit` in one `awk` pass inside the sandbox (range to stdout, line count to stderr); never read whole and slice in JS, since exec output is capped at 256 KB.
- `resolvePath` is lexical and POSIX: it is not a symlink boundary, and Windows executors are unsupported.

## Checkpoints (checkpoints.ts)

- A turn's first `fs_write`/`fs_edit` of a path records its pre-turn state keyed by the turn's user message; later writes in the turn change nothing. A sub-agent's edits go under the spawning turn.
- Only the file tools are tracked: not `bash`, the terminal or outside edits; symlinks are not followed; files over 10 MiB get no copy.
- Copy with `cp -p` through `exec` inside the workspace, never through `readFile` or the wire. Server workspaces keep copies under `<root>/.loxaic/checkpoints/<conv>/<turn>/`; direct local folders under `~/.loxaic/checkpoints` on that machine, never inside the user's folder, and with no new executor verb.
- **Insert a record as `unknown` until its copy reports back, never as `missing`: a restore deletes `missing` files.** A restore skips `unknown` and names it.
- Restore takes each path's oldest record from that turn on, deletes paths that did not exist, and skips destinations that became a symlink or directory.
- Checkpoint access never creates a workspace; a restore may wake a paused one; dropping copies never wakes anything.
- A restore runs under the conversation claim, stops on its signal, is bounded by `REWIND_RESTORE_TIMEOUT_MS` (read at call time), and reports unreached files as skipped.
- Deleting a conversation calls `dropConversationCopies` first (from `destroyConversationSandboxes`). No executor-side sweep: several servers can share one `~/.loxaic`.
- Keep the newest 100 turns per conversation. A conversation rewind drops removed turns' checkpoints; "files only" and retry keep them.

## Workspace prompt (workspace.ts)

- The system prompt is a pure function of the workspace and the sandbox mode (`describeWorkspace`); never put live state (PR opened, sandbox paused) in it. It is the front of every request's prefix.
- `local` ignores the server's sandbox mode. Take `executorName` from the live executor at creation, never the client.
- Quote the container repo path literally; describe the host path, don't name it. Scratch must not claim a repository is checked out.
- Any run offered the `subagent` tool gets `SUBAGENT_SYSTEM_ADDENDUM` through `assembleSystemPrompt`; every untrusted-content wrapper needs its addendum.
- `parseWorkspaceInput` looks the repo up with the owner's token and takes `clone_url` and the default branch from GitHub's answer; ignore any client-sent `cloneUrl` or `pr` — a client-named URL could point the checkout anywhere.
- `REPO_RE` alone admits `..`: refuse traversal segments, and require the lookup's answer to describe a repository.

## Project instructions: reading

- Only github and local agent workspaces get them. One file per directory, the first that exists, never merged: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` (root only). Don't read `.cursorrules` or `.cursor/rules`.
- No summarising model call, deliberately.
- Snapshot the root file once before the first request into `conversations.instructions` (store "none" when absent). It goes in the system prompt, not history.
- Where to read: github via the contents API at `baseBranch` (`getFileText`); a direct local folder via the executor with the folder as ref; a container-isolated folder only inside its live container (`workspaceExec`).
- **Never read a container-isolated workspace through the host folder ref (a symlink would read host files such as SSH keys), and never start a container just to read instructions.**
- Every exec read (root, nested, imports, `cksum`) confines by real path against `REAL_ROOT`, re-checked per chunk in `readChunked`; a candidate leading outside is passed over.
- On GitHub, fetch root candidates with `allSettled`; a failure matters only above the first hit, and an unknown higher-priority file is not "absent".
- A failed lookup is stored `unavailable` with a reason and `retryAfter` (1 min doubling to 1 h). A found file replaces it, nothing replaces a found file, and an aborted lookup records nothing.
- Each step has its own 10 s deadline; executor calls carry an inner `timeoutMs` 2 s under the transport's so the remote command is killed.
- Read files in base64 chunks. The exit code is `base64`'s: an empty chunk before `wc -c`'s size is a failure, never an empty file.
- Escape every path written into a block (NUL-separated lookup output, control characters replaced in the scope line).
- Neutralise the closing tag (zero-width space) in the file and everything between the tags, truncation note included.
- Repository files are hostile: code over them must be linear and must not throw (`parseHeadings` walks backwards once; never spread headings into `Math.min(...)`).

## Project instructions: rendering

- Whole file when it is at most `max(1024, 15%)` of the window (`AGENT_INSTRUCTIONS_WINDOW_SHARE`), else opening plus `#`–`###` outline with line ranges; an unknown window uses 16 KiB.
- The whole-or-outline `decision` is frozen per model. Re-decide only for a new model or when a whole file exceeds half the current window. Render with the decision's window, never the live one.
- `agentSystemPrompt` renders only a decision the database kept, falls back to the base prompt if rendering throws, and after a failed `saveDecision` renders the stored decision or nothing.
- Read the snapshot once per run: build from what `prepareInstructions` stored, never a draft; on prepare failure read the column.
- `@path` imports only in `CLAUDE.md`/`GEMINI.md` (`instruction-imports.ts`): at line start or after whitespace, outside code, relative to the importer, only if the file exists. Limits: depth 4, 20 files, one 1 MB budget shared with the root, each file once.
- The import resolver refuses absolute, `~` and climbing paths lexically; on GitHub a JSON answer (directory, symlink) is not a file.
- Imported files stay separate documents (`<imported-file path imported-by>`); never inline them, or every line range after the mention breaks. Decide whole-or-outline on `combinedText`.
- Nested files ride on the first `fs_read` below them, appended before persisting: nearest first, root excluded, at most three per read, 5% share. They carry the root's boundary sentence.
- Nested dedupe reads the messages being sent (no stored set) and counts only blocks this module appended: an `fs_read` result with the marker at a line start, keyed with its `cksum`.

## Project instructions: updates (instruction-updates.ts)

- A change after the snapshot reaches the model as an `instructions_update` block on the run's own user row (never a new row, never a system-prompt rewrite); `loadHistory` renders it first.
- Check once per run in the tool loop's `prepare` hook, before `loadHistory`, with one `cksum` exec; read files only on a mismatch, and compare words so a touch stores new checksums silently.
- Use checksums the workspace reported, never computed server-side.
- Check a GitHub workspace only in its live checkout (`attachActiveSandbox`), a container only while live; never wake a paused container for it.
- One budget for the whole notice; under 256 tokens left, the notice is the outline alone. Size it for the run's live window, then the decision's.
- A partly read file says so (`truncatedNote`); a section missing from it is "no longer in the part that was read", never "removed". A file vanishing between lookup and read is news only if the prompt had one.
- Compare each change against `latest ?? base`, so it is announced once.
- Fold `latest` into the system prompt only when `historyFront` moves, recording `frontKey`; a snapshot without `frontKey` means the front has not moved.
