# apps/server/src/ws

WebSocket handlers: chat/agent sockets, stream delivery (`delivery.ts`), send outcomes, run actions, the sandbox terminal and the executor socket. Authorization rules live in `../streams/AGENTS.md`.

## Authorization

- Every command re-authorizes (`assertConversationAccess`); a revoke takes effect on the next command, not instantly.
- Anything that outlives the command that created it re-authorizes per delivery: a watch, each run it announces, live `conversation.run` notices, `conversation.rewound`, and a `send.status` replay before it re-taps a run.
- After an authz await, re-read the registry before sending — run state may have changed meanwhile.
- Stop and approve authorize on the conversation (`mayActOnRun`, `actingRole` for sub-agents), never on the run's starter; `findRunsByApprovalCallId` only locates. Refusals are silent no-ops.
- `agent.approve`/`deny` with a `stream_id` act only on that run; a named run without the approval is a no-op and must not fall back to the call-id lookup — model call ids repeat across runs.
- Type-check every element of socket-supplied attachment arrays (`validateSendAttachments`); socket input is a claim, and `RegExp.test` coerces arrays.

## Delivery (delivery.ts)

- Tap, then read: attach the live tap before the catch-up read and buffer meanwhile; reserve the subscription slot synchronously so racing subscribes cannot double-deliver.
- A subscribe always reads a run from seq 0 and folds a full snapshot; the cursor only skips runs with `lastSeq <= cursor`. Consider only the conversation's last three runs, and snapshot a finished run once per socket.
- A caught-up cursor skips an active run's snapshot, never its tap (`tapOnly`: read after the cursor, no fold) — a reconnect is a new socket.
- The run a client's cursor names gets one snapshot per socket even when caught up (`forceSync`), because `producer.end` writes no record. Send a snapshot, not `stream.end`.
- Strip `pending_checkin` and `pending_approval` from any non-active snapshot, and end children still marked running in a finished parent's snapshot (`endStaleSubAgents`).
- Past 512 KB of unsent socket buffer, drop events; the client's gap detection resubscribes.
- A socket watches every conversation it sends into (`autoSubscribe`) or opens.
- The chat list learns run state via `conversations.watch` → `conversation.run` notices (replacement semantics, `run: null` = idle); never per-row `stream.subscribe`. Drop foreign ids silently at watch time (no existence oracle) and cap the watch at 100 ids.
- `conversation.rewound` names removed sub-agent streams in `removed_stream_ids`.

## Send outcomes

- Remember each send's outcome by `(user, client_ref)` in `send-outcomes.ts` (memory, `STREAM_TTL_SECONDS`, 50 per user, clamped to 24 h). `send.status` replays `turn.started` or the refusal, or answers `send.unknown`.
- Remember only this surface's send types (retries included); another surface's would never settle.

## Commands

- `command.run` resolves the name in the conversation owner's skills and compacts only when it is the built-in action; refuse an overridden `/compact` there.

## Sockets

- Call `resume()` before `close()` on a paused socket — a paused socket never completes the close handshake (client sits 30 s in CLOSING).
- Authenticate through `auth/middleware.ts` (`resolveSessionFromToken`), never `auth.api.getSession` directly — it skips the ban check.

## Terminal (sandbox.ts)

- Re-check the session on input (at most once per 5 s) and every 60 s idle. A failed lookup keeps the shell; only a session resolving to nobody or someone else drops it.
- Send `terminal.ready {tty, workdir}`; the client local-echoes only when `tty` is false.
- Input is raw both ways — never append `"\n"` to `terminal.input`.
- Send `terminal.error` as a message, not a close reason (123-byte cap). Close code 4503 means the machine is offline, decided by asking the executor registry.
- Cap terminals at 8 per user (`MAX_TERMINALS`), reserved before the open's await; drop output past 1 MB of unsent buffer.
- Guard `openTerminal()` so an executor dropping mid-open yields 4503, not a bare 1006.
