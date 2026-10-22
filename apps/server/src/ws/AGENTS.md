# apps/server/src/ws

WebSocket handlers: chat/agent sockets, stream delivery (`delivery.ts`), send outcomes, run actions, the sandbox terminal and the executor socket. Authorization rules live in `../streams/AGENTS.md`.

## Authorization

- Every command re-authorizes (`assertConversationAccess`); a revoke takes effect on the next command, not instantly.
- Anything that outlives the command that created it re-authorizes per delivery: a watch, each run it announces, live `conversation.run` notices, `conversation.rewound`, and a `send.status` replay before it re-taps a run.
- After an authz await, re-read the registry before sending — run state may have changed meanwhile.
- Stop and approve authorize on the conversation (`mayActOnRun`, `actingRole` for sub-agents), never on the run's starter; `findRunsByApprovalCallId` only locates. Refusals are silent no-ops.
- A mode switch (`changeRunMode`) is the exception: only the run's sender switches a live run (Auto is a standing grant, like "Allow always"), only the owner's pick or send is stored (`recordPermissionMode`), and only on a `kind: "agent"` thread, never a sub-agent's id.
- `agent.approve`/`deny` with a `stream_id` act only on that run; a named run without the approval is a no-op and must not fall back to the call-id lookup — model call ids repeat across runs.
- Type-check every element of socket-supplied attachment arrays (`validateSendAttachments`); socket input is a claim, and `RegExp.test` coerces arrays.

## Delivery (delivery.ts)

- A socket watches every conversation it sends into (`autoSubscribe`) or opens.
- The chat list learns run state via `conversations.watch` → `conversation.run` notices (replacement semantics, `run: null` = idle); never per-row `stream.subscribe`. Drop foreign ids silently at watch time (no existence oracle) and cap the watch at 100 ids.
- `conversation.rewound` names removed sub-agent streams in `removed_stream_ids`.

## Sockets

- Call `resume()` before `close()` on a paused socket — a paused socket never completes the close handshake (client sits 30 s in CLOSING).
- Authenticate through `auth/middleware.ts` (`resolveSessionFromToken`), never `auth.api.getSession` directly — it skips the ban check.

## Terminal (sandbox.ts)

- Re-check the session on input (at most once per 5 s) and every 60 s idle. A failed lookup keeps the shell; only a session resolving to nobody or someone else drops it.
- Send `terminal.ready {tty, workdir}`; the client local-echoes only when `tty` is false.
