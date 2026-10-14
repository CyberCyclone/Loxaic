# apps/server/src/streams

The stream log, run registry and conversation authorization shared by every run (chat, agent, compaction, context stage, sub-agent). Rules here also apply to `runs/`.

## Stream log

- Every run writes to a sequenced log (`broker.ts` over a `StreamLogDriver`); clients read it via `stream.subscribe` → one `stream.sync` snapshot per run, then live `stream.event`s. Wire types live in `packages/types/src/stream-protocol.ts`.
- `STREAM_BACKEND=redis` with Redis unreachable must fail boot; never fall back to memory silently.
- Redis stores, it does not deliver: live fan-out is an in-process EventEmitter (single-process assumption). The desktop always runs `memory`.
- Append a record to storage before sending it live. `seq` is our own contiguous counter in the record, never a Redis entry id.
- Coalesce only `text.delta`/`thinking.delta` (`STREAM_COALESCE_MS`, default 25); any other event flushes the buffer first.
- Retention is `STREAM_TTL_SECONDS` (default 86400). Real cleanup is `recovery.ts`: rows still `streaming` after a restart are finished as `error`.
- `producer.end` writes no record, so `foldSnapshot` cannot see a terminal status; anything that depends on it is decided in `ws/delivery.ts`.
- `watchers.ts` announces new runs per conversation; a newly announced run always gets a snapshot (`forceSync`), even at seq 0.
- Keep emitting the `todos` event and snapshot `todos` for older app builds until they are gone.

## Snapshot folds

- Any event other than `run.queued` clears the queue position in `foldSnapshot` (and both client hooks); `subagent.*` events never clear it.
- Fold `prompt.stats` into the snapshot only until the message's first output; it is emit-only and changes no prompt bytes.
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
