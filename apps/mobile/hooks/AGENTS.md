# apps/mobile/hooks

React hooks holding client state around the pure functions in `lib/`: the chat and agent session hooks (`useChatSession`, `useAgentSession`), per-conversation choices that must follow a new thread to its real id, polling, and prefs. These rules cover socket handling, id promotion and the races between them.

## Sockets and sends

- Read the clock once per socket message in the handler (`arrivedAt` in `onEvent`) and pass it down; never call `Date.now()` inside a fold or a state updater (React may defer or repeat it).
- Socket hooks never listen to AppState; the connection monitor owns that listener and asks for a replacement through `onReconnectRequest`.
- Resubscribes skip local ids (`c<ts>`, `pending-*`). A `turn.started` naming a send renames only that send's thread; any refusal naming a send takes it back; on `send.unknown` take the thread back and restore its text.
- Do not ask `send.status` for a workspace send until its frame has gone out. `client_ref` must include randomness — the key is per user, across devices.
- `turn.started` for our own send or retry into an existing conversation never moves the screen (`followsTurnStarted`). A rewind's text goes back to its own thread's composer (`PendingSeeds`); a retry answered after the person left the thread is not sent.
- Agent `handleSend` returns whether the message went out and rolls back the optimistic bubble or `pending-*` run when not. The mode selector moves only if the server heard it; a plan decision is sent first and acted on after.
- Every approval answer, the thread's own included, names the stream it arrived on (`toPendingApproval`'s `streamId`, `approvalStreamId`) — an unnamed answer can run another thread's call.
- `stopping` is client-only, keyed by conversation id and cleared only by `clearStream`; `handleStop` with no tracked stream must say so, not return silently.
- On a no-room `error` code or `stream.end.error_code`, show `NoRoomModal`, take the unsent bubble back and restore the text (never attachments).

## Promotion: local id to real id

- "The real id arrived" is the session's `promotion` (`{localId, realId}`), never inferred from the ids — leaving an unsent new chat for an existing thread also goes from local to real.
- `useMcpSwitches` holds choices for a local id and PATCHes the real id only when the row disagrees (`carriesChoices`); session hooks read them through the `pendingMcp` ref. Use one instance per screen, feeding the `+` menu, context popup and Inspector. A switch flipped in a chat is always stored as an explicit choice, even when it matches the default.
- A thinking level chosen before a chat exists rides the first send, moves to the local id (`pendingOwner`), then to the real id keyed by `promotion.localId` (`useThinkingChoice`).
- A new chat's chosen context stage rides the opening send as `context_stage`, held in a ref read at send time.
- `useStoredState` broadcasts writes to every holder of the key and resolves updates from a ref, never inside a state updater.

## History and subscriptions

- Subscribe to an opened conversation only after its history fetch settles — a snapshot landing first makes the history fill skip.
- The plan panel auto-opens only once the newest page has actually arrived (`historyLoaded`); the bar waits for `historySettled`; a failed fetch is retried on the next select.
- `useReview` auto-opens the newest pending item once per session, for someone who can decide, with nothing running; viewers only get `PlanReviewBar`. It waits while a sub-agent sheet is open (`blocked` from `useSubAgents().sheetOpen`, including the hand-over) and does not mark a held item seen.
- Running-status notices: re-send the whole visible id set whenever the list changes and on every `onopen`, and clear the notice map on `onopen` — the server does not replay across sockets. Drop the notice for every id no longer sent (`runNoticesWithin`).
- A rewind re-asks for todos (`rewindsByConv` is part of the answer's identity); a run's end does not.

## Sub-agents

- Route a child's own stream messages first in both session hooks (`useSubAgentState`), and the parent's `subagent.*` events before queue and prompt-line handling.
- Subscribe to a transcript only while its panel is open, and only if it is still open when the history lands; there is no unsubscribe.
- Only a 404 settles a listing as "none"; any other failure marks `listFailed` and retries on the next socket or open (`loadFor`).

## Context stages (`useContextStages`)

- Shared by Chat and Agent; never used for routines.
- Measure "nearly full" against the active stage's own window (`ModelInfo.context_stage.windows[active]`), never the ring. Ask after a turn ends, once per conversation per stage per session, at `CONTEXT_STAGE_PROMPT_AT` (below the server's compaction threshold), never for a model set to extend itself.
- Never offer a step-down for a new conversation (the server does it); offer it only when reopening, no lower than `blocked_down_to`. An answer landing after the person switched threads opens nothing and is not marked shown (`stepDownAnswerStillApplies`).
- Never drive a prompt from a stale model list (`listBehind`, `inThisSession` keyed on `promotion`); close dialogs the list makes moot. A switch this device started polls the list.
- The stage pill is run state (`stageCardByConv`, from `context.stage` and snapshot `context_stage`), not a message. Remember dismissed cards by run id (`droppedStageStreams`, `shouldInstallStageSnapshot`) so a reconnect's resync does not bring them back. Hide the typing indicator during a switch; the composer shows Stop for a server-started stage run.

## Skills

- Before the list arrives the client knows only `/compact` (`FALLBACK_SKILLS`). Show a list only for the conversation it was fetched for (`skillsFor`).
- Send an overridden `/compact` as a message, never `command.run`.

## Routines

- The routine chat screen is `useChatSession` with a `scope`: it lists via `getRoutineConversations`, filters kind `routine`, refuses the implicit create, and reads and writes no offline cache.

## Polling and prefs

- The optimistic enable switch in `useLocalModels` bumps the poll sequence so an in-flight poll cannot flip it back.
- The check-ins screen uses one prefs copy (`usePrefs.ts`) with controlled controls; a failed save reverts only the fields it patched (`lib/prefsRollback.ts`); `busy` is a count, not a flag.
- `useKeyboardHeight` pads sheets for the keyboard (minus the bottom inset on iOS, whole on Android); `KeyboardAvoidingView` mis-measures inside a sheet.
- `useAppUpdates.ts` calls both the electron-updater and expo-updates hooks unconditionally and selects one.
