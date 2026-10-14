# apps/server/src/streams/runs

Run starters and the shared tool loop (`engine.ts` `runToolLoop`), compaction, context-stage runs and sub-agents. Read `../AGENTS.md` first: the prefix invariant, stopping and the registry apply here.

## Starters

- Chat and Agent share `runToolLoop`; `chatRun.ts`/`agentRun.ts` differ only in setup and system prompt. Chat always has manual-mode approval semantics. Chat, agent and retry all start through `startRunOnRow`.
- Call `assertModelUsable` in every starter beside `assertAttachmentsOwned`, before any row is written — it makes the provider allowlist a spending limit.
- A send into a `kind: "routine"` conversation runs on the routine's model whatever the client names (`routineModelFor`).
- `recordModelUse` only on a send, keyed to the sender; never for compaction or the literal `"default"`. One SQL statement, awaited, skipped when unchanged.
- Starters write `mcp_overrides` only when they create the row.
- Give rows a run writes `monotonicLamport(previous, now)`; keep it scoped to the loop's own inserts (not starter lamports or `packages/sync`).
- `titleIfUnnamed` (`streams/runs/agentRun.ts`) is gated on message count, never on the title text, so a thread a user named "New conversation" is not overwritten.

## History and prefix

- `loadHistory` replays every row after the newest completed summary; only compaction moves the front. Never trim, window or cap the read.
- Never change an older part of the prompt (an attachment verdict, a replayed row's bytes) — it breaks the cache like a trim.
- On replay strip partner-less tool calls (`resolvedCallIds`) and partner-less results (`presentCallIds`). A skipped or stopped call still persists a `tool_result`; never leave a `tool_call` unpartnered.
- A user row renders as notices, then the skill block, then the typed text.
- The thinking level is fixed per run in `RequestShape` and recorded on `conversations.thinking_level`; send it unchanged in compaction and context-stage warm-up.
- Attachment verdicts (`selectAffordableAttachments`, `files/storage.ts`): a current-turn reserve plus a history pool spent oldest-first, so an older turn's verdict never depends on a newer one. Dropping middle attachments is deliberate; don't switch to recency-first. Image budget is bytes, document budget tokens, kept separate; an image with missing bytes is admitted at zero cost.
- `writeOverflowToSandbox` writes only into a sandbox already active (`hasActiveSandbox`) and must never create one.
- `loadHistory`'s `omittedAttachments` comes from the same verdict the prompt used.

## Usage

- Emit `message.usage` when each request finishes; build every copy (deferred `message.end`, snapshot) with `turnUsageFor`.
- One `usage_records` row per completion, written through `usageRecordValues` (rounds fractional llama.cpp timings for integer columns). Inserts are best-effort and never fail a turn or a summary.
- `cached_tokens` null means "backend doesn't report"; never write `?? 0` on that path.

## Waits: approvals and check-ins

- `waitForApproval` returns `ApprovalOutcome`; only `denied` may say the user refused, and `timeout` must not suggest allowlisting. Keep the unreachable `case "aborted"`.
- `waitForStepsDecision` mirrors `waitForApproval`, takes the abort signal, and yields the slot via `slot.yieldWhile`.
- Catch `RunSlotAbortedError` from an approval inside the per-call loop and record that call as stopped, so earlier calls' results persist. Check abort per call, not per iteration.
- A standing grant comes only from `always: true` and only from the run's sender (`always && answeredBy === userId`); an editor's "always" approves once.
- `approval.request` carries the run's `mode` and `granter_user_id`; clients must not infer either.
- Timeout precedence: `user_prefs.*_timeout_ms` → `APPROVAL_TIMEOUT_MS` (read at call time) → 10 min. Clamp to 24 h (`setTimeout` past 2^31−1 fires in 1 ms). Adaptive windows time `streamCompletion` alone, never the iteration.
- Compute one deadline per wait before emitting it, so the wire and the timer agree.
- `max_iterations` is a check-in cadence, never a ceiling; "Keep going" sets an absolute `budgetEnd`. Unanswered check-ins follow `unattendedDecision` (`timeouts.ts`); there is no stop rung.
- "Answer now": `tool_choice: "none"` with tools kept in the request; persist `CHECKIN_ANSWER_NUDGE` as a fixed-text `user` row (never `system`, author = presser or null); answer stray calls with `ANSWER_NOW_NOT_RUN`. A stop at a check-in writes no nudge.
- The auto-continue notice is never a message row: emit `steps.decision {by: "timeout"}`.
- `loop-detector.ts` hashes each iteration's call names and args, never results; "Keep going" resets it.
- Emit `steps.decision` inside `yieldWhile`, before the run re-queues, so no device sees a stale check-in beside a queue position.

## Planning handover

- A successful `propose_plan`/`ask_questions` (`HANDOVER_TOOL_NAMES`) ends the turn via `endTurnComplete(id, true)` + `break`, before the check-in block, so auto-compaction still runs; later calls in the message get `HANDOVER_ALREADY_SUBMITTED`.
- A prose planning turn is nudged once: persist `PLAN_REQUIRED_NUDGE` (author null), resend with `tool_choice: "required"` on that one request only, clearing the flag as it goes out. Never on an answer-now turn.
- Never park a run on plan review; each decision is a new message.

## Tools inside the loop

- Run read-only bash with `READ_ONLY_BASH_ENV` (fsmonitor off, `cat` pager).
- Check a `skill` call's name against the live catalog at call time (`SKILL_TOOL_NAME` branch of `runOneToolCall`).
- Append `TODO_STALE_REMINDER` (`todo-staleness.ts`) to a built-in tool result inside `runOneToolCall` before `tool.result` is emitted — never as its own message. Re-seed its count after an in-run compaction.

## Sub-agents

- Offer `subagent` on the agent surface and in routines only; never in chat or to a child.
- A child is its own conversation row (`kind: "subagent"`), never rows in the parent's. It shares only, via `role`: the parent's sandbox (`workspaceConvId`), the parent's MCP state, the parent run's sender as `userId`, and the parent's abort signal.
- A child: no plan tools or nudge (`subagentSystemPrompt`, never `planningSystemPrompt`), no step check-in (answers now), no request shape, no after-turn compaction, never extends a context stage.
- Run all `subagent` calls of one message inside ONE `yieldWhile` of the parent's slot (`runSubagentGroup`) — holding the slot deadlocks at concurrency 1. Start each child after the previous has its queue place (`onInLine`).
- Persist results in call order via `ranAlready`, checked before the per-call abort check; the group catches the post-stop `RunSlotAbortedError` so finished reports survive. Over `MAX_SUBAGENTS_PER_MESSAGE`, answer with a refusal.
- `runSubagent` never rejects; failures are `ok: false`, and `text: null` on a complete child is a failure (`subagentOutcome`). It refuses under a deleted parent.
- `subagentResultText` must be deterministic (replayed every turn): one 16 KB cut on a character boundary, closing tag neutralised.
- Cut labels by code point, never `slice` — a lone surrogate fails the jsonb insert.
- Freeze offered models on `conversations.subagent_models`; an unknown `model` is an error, never a fallback. In a routine, `choose` acts as `parent`; a failed settings read answers `parent`.
- Track child stream ids in `starting` between row insert and registration so `listSubagents` doesn't read them as lost. Hold `admitted_at` in `childClock`, write it at `markEnded`.

## Compaction and context stages

- `fillDecision` (`auto-compact.ts`) is the one policy, before every request and after every turn. A request that cannot fit is compacted or refused with `CANNOT_FIT_REASON`, never sent. Keep the `AUTO_COMPACT_MIN_MESSAGES` floor; `AUTO_COMPACT_THRESHOLD=0` disables only the early step. An unknown window disables automatic compaction.
- The in-run check runs before each request and before that iteration's assistant row. Don't retry in a run what already failed in it.
- In-run, use `compactWithinRun` (run's stream, held slot, run's lamport counter) — never `startCompactRun`. Reach both via dynamic `import()` (import cycle).
- A message the run hasn't answered stays after the summary (`cutoffBefore`); otherwise insert `COMPACTION_CONTINUE_NUDGE` in the same transaction as the summary (`commitSummary`'s `follow`).
- Summaries take `nextConversationLamport` (or the run's counter in-run), never `Date.now()`.
- A compaction request is the last run's request plus the instruction as the final user turn, `tool_choice: "none"` (`compactionRequest`); replay instruction notices, don't strip them.
- Summarise oversize histories in parts (`summaryParts`), never splitting a call from its results; `fitMessage` also cuts tool-call args to valid JSON. An empty summary fails and is never committed.
- The after-turn trigger stays after `runToolLoop`'s `finally` (after `unregisterRun`), success path only — earlier, the run's own lock refuses it silently.
- A compaction stopped while queued still persists a terminal status and `message.end`.
- `extendWithinRun` yields the slot (`acquireExclusiveSlot` needs the whole backend) and warms nothing; a stop puts the stage back. A stage run calls `registerRun` before `openProducer`, writes no message rows, and its fallback compaction honours `canCompact`.
- `leaveCompactionToPerson` skips one after-turn compaction per conversation and stage when the person could extend now; never for a routine.
- Compaction, automatic included, queues for a slot like any other run; never let it jump the queue.

## Tests

- Stop-batch tests are Docker-gated, wait on the sandbox row (not a sleep), and assert nothing ran behind the stop rather than an exact skip count.
