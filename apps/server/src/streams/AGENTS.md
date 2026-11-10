# apps/server/src/streams

The stream log, run registry and conversation authorization shared by every run (chat, agent, compaction, context stage, sub-agent). Rules here also apply to `runs/`.

## Stream log

- Every run writes to a sequenced log (`broker.ts` over a `StreamLogDriver`); clients read it via `stream.subscribe` → one `stream.sync` snapshot per run, then live `stream.event`s. Wire types live in `packages/types/src/stream-protocol.ts`.
- `producer.end` writes no record, so `foldSnapshot` cannot see a terminal status; anything that depends on it is decided in `ws/delivery.ts`.

## Snapshot folds

- Any event other than `run.queued` clears the queue position in `foldSnapshot` (and both client hooks); `subagent.*` and `run.mode` events never clear it.
- `stream.end.error_code` rides only the live event and is deliberately never replayed from a snapshot.

## Run registry

- Every starter claims the conversation before writing (`claimConversation`: busy check + `registerRun`, synchronously, no await between). A rewind holds a `rewind-<uuid>` claim. Both refuse with `ConversationBusyError` (409 `conversation_busy`).
- Mutate run state only through the registry mutators (`setRunApproval`/`clearRunApproval`, `setRunQueuePosition`/`clearRunQueuePosition`, `seedRunLimits`/`setRunLimits`, `registerRun`/`unregisterRun`), never directly (e.g. `run.approvals.set`): they announce activity changes to watchers.
- `runActivityOf` owns the activity vocabulary and precedence: approval → queued → running.
- A sub-agent counts as another conversation using a model only while running, under its parent's thread, never as the asking thread's own (`runsUsingModel`, `RunHandle.parentConversationId`; `recentUses`/`usesByThread` in `llama/`). Compare parent ids in SQL with `IS DISTINCT FROM`, never `<>` (null drops every row).

## Access (authz.ts)

- Roles are ordered `viewer < editor < owner`. `resolveAccess` resolves owner → explicit share → admin. `assertConversationAccess(userId, convId, minimum)` is the WS chokepoint; REST uses `hasRole`.
- Ownership lives only on `conversations.ownerId`, never in `conversation_shares`; "owner" is not grantable — a share asking for it degrades to viewer.
- Admin resolves to `viewer` with `viaAdmin: true`, never higher; a real share beats the admin fallback. Never loosen `resolveAccess` for admins on retained (deleted) conversations — the admin transcript route is the separate read-only door.
- Not found, not shared and role too low all throw the same `NotFoundError`; never branch on which (route tests assert identical bytes).
- A non-uuid conversation id is "not found", never a database error.
- Nobody gets more than `viewer` on a `kind: "subagent"` conversation; stop/approve on a child are authorized by the caller's role on the parent (`actingRole`).
- Authorize a batch of ids with `filterAccessible` (two queries), filtering non-uuid ids first.
- Validate client-supplied attachment refs only through `assertAttachmentsOwned`, before any conversation or message write. Use the mime and filename from the row it returns, never the client's; it de-duplicates refs and reports unknown and not-yours as the same `NotFoundError`. Omit `name` (never `""`) for a row with no filename.

## Prompt prefix

- Backends cache only a prompt prefix: each request in a conversation must be an element-wise extension of the previous one. `runs/__tests__/prompt-prefix.test.ts` is the only test that sees this class of bug; any change to what a request carries (system prompt, tools, replayed rows, serialization of args or text) must keep it green.
- A positional read of `messages` (`.at(-1)`, "the last assistant row") needs `orderBy(lamport, created_at)`. Never use `Date.now()` alone as the lamport of a row a run writes (see `monotonicLamport`).
- `loadHistory` replays rows in `(lamport, created_at)` order and ignores `parent_id`/`active_leaf_id`. Anything that creates a real in-thread branch must first make it walk parent links from `active_leaf_id`.

## Stopping

- `stream.stop` only aborts the run's signal. Every part of a run that can block (approval waits, a paused progress review, the per-call loop, exec, fetch, queue waits) must honour it.
- An abort listener added to an already-aborted signal never fires: re-check `signal.aborted` after every await that precedes adding the listener.
- Treat a failure as a stop when `err.name === "AbortError" || signal.aborted` — a mid-stream Stop surfaces as `TypeError: terminated`. Never key on the name alone.
- Always handle `runToolLoop`'s promise: `engine.ts` rethrows anything but a stop (`RunSlotAbortedError`, or any throw once the run's signal is aborted), and there is no `unhandledRejection` handler (the stream would stay "active" forever).

## Runs (`runs/`)

### Tool failures

- A tool call's failure is a failed result on its card, never a failed run: the calls after it run and the model answers without it. Only a stop or a fault outside the calls ends a run, and a fault leaves an error row in the thread (`recordFailure`), answering the newest stored reply and keeping what a streaming one had. A stop adds no error row.
- "Stopped before this tool call ran" is `RunSlotAbortedError`'s alone; any other throw after a stop came while the call ran and says so.
- `runSubagentGroup` never throws: a fault fails only the calls it reached.
- Everything bound for a `jsonb` block or the prompt goes through `jsonbSafe`, in both places, so the replay matches: Postgres refuses NUL and lone surrogates.

### Starters

- A run reads its progress-review switch (`RunHandle.limits`) each time a review is due, never from a value captured earlier. Only chat and agent threads can turn it off (`loadRunLimits` checks the kind): a routine's run and every sub-agent are always reviewed. Turning it off reaches only the sender's live run; turning it on reaches any.
- Chat and Agent share `runToolLoop`; `chatRun.ts`/`agentRun.ts` differ only in setup and system prompt. Chat always has manual-mode approval semantics. Chat, agent and retry all start through `startRunOnRow`.
- Call `assertModelUsable` in every starter beside `assertAttachmentsOwned`, before any row is written — it makes the provider allowlist a spending limit.
- `recordModelUse` only on a send, keyed to the sender; never for compaction or the literal `"default"`. One SQL statement, awaited, skipped when unchanged.

### History and prefix

- Never change an older part of the prompt (an attachment verdict, a replayed row's bytes) — it breaks the cache like a trim.
- On replay strip partner-less tool calls (`resolvedCallIds`) and partner-less results (`presentCallIds`). A skipped or stopped call still persists a `tool_result`; never leave a `tool_call` unpartnered.
- The thinking level is fixed per run in `RequestShape` and recorded on `conversations.thinking_level`; send it unchanged in compaction and context-stage warm-up.

### Usage

- One `usage_records` row per completion, written through `usageRecordValues` (rounds fractional llama.cpp timings for integer columns). Inserts are best-effort and never fail a turn or a summary.
- `cached_tokens` null means "backend doesn't report"; never write `?? 0` on that path.

### Progress review (`runs/progress-review.ts`)

- Nothing but the review bounds a run a person started: there is no step limit and no check-in, and a review never asks a person. A sub-agent and a routine are reviewed whatever `user_prefs.progress_review` says, and stop at `unattendedRunLimitMs()` of working time; never make either a user setting.
- A review's verdict enters the run only as a persisted user row (`progressNoteText`, null author), pushed live and replayed byte for byte; never interpolate anything into it the replay cannot reproduce.
- A review request never carries `conversationId` (it must not restore or overwrite the conversation's saved KV cache) and is shown a bounded digest, never the run's prompt.
- Take a spare slot only through `tryAcquireRunSlot`, which never queues; without one, review in the run's own slot at a step boundary.
- A review that interrupts a reply aborts only that request (its own controller beside `abort`): the partial row ends `cancelled`, which no replay sends.
- Count working time as wall clock less `RunSlot.parkedMs()`.
- Wrap every model request in `reviewer.watchRequest`: the time cadence and the ceiling must not wait for a reply to end.
- Tell a progress note from a typed message with `isServerNote(text, authorUserId)` wherever the row is at hand; its text alone is anyone's to type.
- Record a review's completion as `usage_records` with `purpose: "progress_review"` and a null `message_id`.
- Ask for a verdict under `VERDICT_SCHEMA` (`jsonSchema`), falling back to words alone only when the backend refuses it; keep `parseVerdict` able to read a reply in prose or cut short.
- Change `DEFAULT_REVIEW_PROMPT`, `REVIEW_OUTPUT_CONTRACT` or the digest only with a replay of real runs through a real model; the mock answers from keywords and proves nothing about a verdict.

### Waits: approvals

- A standing grant comes only from `always: true` and only from the run's sender (`always && answeredBy === userId`); an editor's "always" approves once.
- `approval.request` carries the run's `mode` and `granter_user_id`; clients must not infer either.
- Read a run's mode live (`liveMode()` / `ctx.mode()`, a child's from `getRun(parent.streamId)` as it registers), never a value captured earlier; change it only through `setRunMode`, which moves only between manual and auto (`liveModeAfter`) and re-gates every waiting approval. Prompt, tools and the planning nudge use the start mode. Whatever opens a run's producer calls `startModeLog`.

### Planning handover

- Never park a run on plan review; each decision is a new message.

### Tools inside the loop

- Run read-only bash with `READ_ONLY_BASH_ENV` (fsmonitor off, `cat` pager).

### Sub-agents

- Offer `subagent` on the agent surface and in routines only; never in chat or to a child.
- A child is its own conversation row (`kind: "subagent"`), never rows in the parent's. It shares only, via `role`: the parent's sandbox (`workspaceConvId`), the parent's MCP state, the parent run's sender as `userId`, and the parent's abort signal.
- A child: no plan tools or nudge (`subagentSystemPrompt`, never `planningSystemPrompt`), told to answer on any progress review but `progressing`, no request shape, no after-turn compaction, never extends a context stage.

### Tests

- Stop-batch tests are Docker-gated, wait on the sandbox row (not a sleep), and assert nothing ran behind the stop rather than an exact skip count.
