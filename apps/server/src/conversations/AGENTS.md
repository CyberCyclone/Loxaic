# apps/server/src/conversations

Deleting, rewinding, paging and reaping conversations (`delete.ts`, `rewind.ts`, `history-page.ts`, `latest-todos.ts`, `reaper.ts`). These rules cover the data-loss and leak guards that are easy to break.

## Reading messages

- `history-page.ts` serves the newest page and `?before=` the page older than it, cut in replay order `(lamport, created_at, id)`; never `created_at` alone.
- A page starts on a user message (the limit is a floor) so a `tool_call` and its `tool` rows stay on one page. A turn past `PAGE_CEILING` is cut there and moved forward past `tool` rows at the edge.
- The page cursor is a row id resolved in SQL, never a timestamp (Postgres µs vs JS ms). A cursor from another conversation, or not a uuid, is a 400.
- `latest-todos.ts` skips refused calls and rewound rows, selects by containment, and expands only the newest twenty rows.

## Deleting a conversation

- `delete.ts` is the only code that writes `conversations.deletedAt`. Delete is owner-only and answers the identical `200 {ok:true}` to everyone else, admins included.
- A deployment setting decides erase (default) or keep-for-audit.
- **`purgeConversation` order is load-bearing**: delete the conversation row first, in the same transaction as its messages (so `resolveAccess` refuses everything at once), then abort the run, then a second erase pass after `waitForRunEnd` for rows it wrote meanwhile.
- A timed-out unwind wait gets a second, longer wait and another erase pass; orphan rows would pin uploads forever. Both waits read `DELETE_RUN_UNWIND_TIMEOUT_MS` at call time.
- Keep usage records, detached (`conversation_id`/`message_id` nulled); never delete them.
- Delete a sandbox row only when its container is confirmed `destroyed`; the row is the only record a failed destroy's container exists.
- Delete the conversation's stream logs too (they hold the transcript); best-effort behind `hasStreamBroker()`.
- `eraseRows` erases sub-agent children in the same transaction, then their stream logs, and deletes `routine_runs` for erased conversations (no FK). A retained (soft-deleted) parent's children are not stamped with a date of their own.
- Retention fails on: `getConversationSettings()` resolves `keepDeleted` true when the row is unreadable, and the sweep stands down. An env pin outranks the failed read.
- `conversationPurgeAt` is derived on read, never stored.
- An admin hold survives any retention-policy change.
- Restoring brings shares back but not the workspace (the sandbox is destroyed at delete time). `restoreConversation` flips an orphaned routine chat to `kind: "chat"`.

## Rewind and retry

- `rewind.ts` is the only code that removes part of a conversation. Rewind removes a message and everything after; retry removes everything after the newest typed message and answers that row again.
- "After" means `created_at`, never lamport: a mid-run summary sits just below its message by lamport.
- Removed rows follow the delete retention setting (erase, or stamp `deleted_at`); detach their usage rows; removed sub-agents follow the same setting.
- Delete the removed runs' stream logs (a run is in the suffix if its stream started at or after the pivot message), or a resubscribe snapshot brings the messages back.
- Removing an `instructions_update` notice clears `instructions.latest`.
- Return a rewound message's attachments only to their uploader, refreshing `created_at` so the reaper's grace restarts.

## Elsewhere, about conversation rows

- Listings and the admin list exclude `kind: "subagent"`; `/v1/stats/conversations` groups a child's usage under its parent (totals include children; `model`/`avgTtftMs` are the thread's own).
