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
- Mutate run state only through the registry mutators (`setRunApproval`/`clearRunApproval`, `setRunCheckin`/`takeRunCheckin`/`clearRunCheckin`, `setRunQueuePosition`/`clearRunQueuePosition`, `registerRun`/`unregisterRun`), never directly (e.g. `run.approvals.set`): they announce activity changes to watchers.
- `runActivityOf` owns the activity vocabulary and precedence: check-in → approval → queued → running.
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

- `stream.stop` only aborts the run's signal. Every part of a run that can block (approval and check-in waits, the per-call loop, exec, fetch, queue waits) must honour it.
- An abort listener added to an already-aborted signal never fires: re-check `signal.aborted` after every await that precedes adding the listener.
- Treat a failure as a stop when `err.name === "AbortError" || signal.aborted` — a mid-stream Stop surfaces as `TypeError: terminated`. Never key on the name alone.
- Always handle `runToolLoop`'s promise: `engine.ts` rethrows anything but `RunSlotAbortedError`, and there is no `unhandledRejection` handler (the stream would stay "active" forever).

## Runs (`runs/`)

### Starters

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

### Waits: approvals and check-ins

- A standing grant comes only from `always: true` and only from the run's sender (`always && answeredBy === userId`); an editor's "always" approves once.
- `approval.request` carries the run's `mode` and `granter_user_id`; clients must not infer either.
- Read a run's mode live (`liveMode()` / `ctx.mode()`), never a value captured at start; change it only through `setRunMode`, which moves only between manual and auto (`liveModeAfter`) and re-gates every waiting approval. Prompt, tools and the planning nudge use the start mode.

### Planning handover

- Never park a run on plan review; each decision is a new message.

### Tools inside the loop

- Run read-only bash with `READ_ONLY_BASH_ENV` (fsmonitor off, `cat` pager).

### Sub-agents

- Offer `subagent` on the agent surface and in routines only; never in chat or to a child.
- A child is its own conversation row (`kind: "subagent"`), never rows in the parent's. It shares only, via `role`: the parent's sandbox (`workspaceConvId`), the parent's MCP state, the parent run's sender as `userId`, and the parent's abort signal.
- A child: no plan tools or nudge (`subagentSystemPrompt`, never `planningSystemPrompt`), no step check-in (answers now), no request shape, no after-turn compaction, never extends a context stage.

### Tests

- Stop-batch tests are Docker-gated, wait on the sandbox row (not a sleep), and assert nothing ran behind the stop rather than an exact skip count.
