# apps/mobile/lib

Pure, unit-tested client logic: stream folds, history paging, the connection monitor, run state, and the decisions behind most UI. Keep decisions here as pure functions of their inputs and let components only render them. Also covers `packages/api-client`, the typed REST and WS client this app uses.

## Reachability (`connectionMonitor.ts`, `packages/api-client`)

- One app-wide reachability state: `connectionMonitor.ts` (controller) over pure `connectionMonitorCore.ts`, published by `connection.ts`. Screens never write it.
- Every REST request in `packages/api-client` goes through `serverFetch`, which reports `answered`/`suspect`/`stalled` to the observer. `isUnreachableError` means exactly "no answer" (`ServerUnreachableError`); never count an HTTP error as down.
- Only the `GET /health` probe can call the server down; a failed request never sets the state — 502/503 can come from our own server.
- Probes: one in flight, 4 s timeout, backoff 1/2/4/8 s then every 10 s, three failures in a row → `offline`, heartbeat every 25 s while online and foregrounded. A failed probe beats a socket that reports "open", and triggers its replacement.
- Grace: 300 ms after a resume, 1.5 s for a just-opened socket. Input waits the window (`resuming`); nothing is shown (`showsDisconnected`). A resume with no socket tracked stays `online`. Bump `epoch` on each resume so a probe armed before it is ignored (iOS fires frozen timers on return).
- Only a return from `background` is a resume (`appStateEvent`); `inactive` is not — locking an iPhone passes through `active`.
- A socket closed with 4001 is a session problem: `checkSession` re-asks and a dead session signs out. The terminal socket is not tracked: its 4503 means the machine is offline, not the server.
- Launch waits at most `LAUNCH_SESSION_TIMEOUT_MS` (`session.tsx`); past it keep the token with the user unknown, and fetch the user whenever the monitor says `online` and it is still unknown.
- Anything read from storage at launch must wait for `hydrateStorage()` — child effects run before `SessionProvider`'s.
- Electron is not same-origin: the API URL comes from `window.loxaic.apiBaseUrl` via `endpoint.ts`.
- A new client socket reports through `trackSocket`, or the monitor cannot tell an "open" socket to a stopped server.

## Uploads

- Native uploads use `nativeAttachmentFile` (`attachmentUpload.ts`), returning `{name, type, bytes()}` — `expo/fetch`'s FormData rejects RN's `{uri, name, type}` part before sending.

## Stream folds and timing

- Subscribe on select once per conversation per socket (`conversationWatch.ts`), after the history fetch settles. Never subscribe after `turn.started`: it tears down the active run's tap.
- Live counters time the newest message, not the run (`liveTimer.ts`): start from `message.start.started_at`; a live event uses arrival time, a snapshot converts with its sync's `server_now`; the run start is the fallback and the floor.
- A snapshot of a message already held keeps its computed `startedAt` (`applySnapshotToMsgs` → `snapshotMessageToMessage`); never recompute it per snapshot.
- Pass a snapshot's `server_now` through as received, never default it to `Date.now()` (`localDeadline`). Convert `expires_at` once on receipt (`pendingWaits.ts`) and keep it.
- `isEmptyGenerating` (does the reply get a row) must count `tools`. `typingIndicatorFor` is a separate decision: a tool-only reply shows the indicator only while the run reports a queue place or a model load.
- Copy `author_user_id` in `foldSnapshot`/`applyEventToMsgs` only when the key is present. In `checkinNotice.ts` an id means that person, null means nobody (timed out), absent claims neither.
- Strip the todo reminder from tool cards with `stripTodoReminder` on all three `streamMessages` paths.
- Apply `conversation.rewound` by id, never position (`rewind.ts`); ignore later snapshots and events of removed runs; clear the agent's live run state only when the followed run was removed (`rewindClearsLiveRun`).

## History paging

- Always apply the newest page (`withNewestPage` in `historyPages.ts`), merged with any live run; never skip it — the cursor would be wrong.
- Merge history by `lamport` (`mergeHistory`, behind `withNewestPage` and `prependOlder`), never simply prepend. History without `lamport` goes in front; history older than the first placed message goes ahead of leading optimistic bubbles; `message.start` for an on-screen message fills in a missing `lamport`.
- `applySnapshotToMsgs` places a missing message by `lamport` and omits one older than the loaded page while older history remains; without `lamport`, append. Never skip a finished run on absence alone — it may be newer.
- The offline cache (`message-cache.ts`) keeps only the newest 100 messages per thread; never write older pages to it.

## Run state

- Agent run state is per conversation (`agentRunState.ts`), folded from every conversation's events; todos are not part of it. A rewind that drops a prompt moves the run off `awaiting_*`; only an active run's snapshot yields a prompt.
- Never read a waiting approval's mode from the mode selector — the selector is the next message's mode.
- The Inspector's todo list is the newest accepted `todo_write` in loaded messages (`todos.ts`), never run state; ask `GET /v1/conversations/:id/todos` only when `needsServerTodos`.
- Only a plan result with `ok === true` counts as a plan. Questions are answered by one message (`formatAnswers`); a set is answered once any user row follows it. "Other" is client-side only.
- A no-room refusal is matched to its send by `client_ref` (`noRoom.ts`'s `PendingSends`), never a "last send" slot; a mid-run refusal opens the modal only for the thread on screen.

## Sub-agents (`subAgents.ts`)

- A card counts queue wait from `started_at`, then running time from `admitted_at` (`subAgentCounterSince`); a child re-queued after running keeps counting running time.
- Find a card by `(message id, call id)`; with a known message id match exactly or not at all (`subAgentForCall`).
- A snapshot never revives a child this device saw end; the stored listing only adds, ends or fills in missing figures. Convert start time and approval deadline to the device clock once and keep them.

## Models and context stages

- `defaultModel` prefers built-in models — every hosted model is "loaded", so `find(m => m.loaded)` would start a chat on a paid one.
- Open on the last-used model only when no conversation exists yet (`selectModel.ts`), never because an existing conversation lacks `model_pref`; recents must still be offered (`isKnown`).
- An absent `recentModels` means the server does not track it, never "nothing used".
- Every stage decision is a pure function (`contextStages.ts`, `stageCard.ts`, the stage helpers in `localModels.ts`).
- Context length past the trained max is a warning (`parseNumericInput` returns `{ value, warning }`, Save stays enabled); only the 32-bit ceiling is refused.
- Map a server 400's `index` (it counts only the non-blank rows sent) back onto the draft row with `withServerProblem`.

## Usage figures (`usage.ts`, `promptStats.ts`)

- Never label reusable as cached: "Prompt cached" is the backend's figure, "Prompt reused" ours (`promptReuse()`). Floor percentages, never round.
- Never turn a null figure into 0; `reusable_tokens: 0` is shown as "0%".
- `showPromptStats` must not gate on `loadingModel` — the line shows through a model load.
- At completion the evaluated segment takes the remainder (no 99% bar); `remaining_ms` null means nothing left, and guard `> 0`.
- Name an MCP tool-source row from the viewer's own server list (`toolSourceName`); breakdowns carry ids, not names.

## Skills palette

- Enter/Tab pick from the palette only when the query matches a name or a row was arrowed to (`paletteTakesEnter`); highlight nothing when Enter would send; keep the highlighted row in view (`scrollToShow`).

## Deleting

- What the delete dialog says about agent files keys on the workspace kind (`deleteMessage.ts`): a local folder is untouched, a scratch or GitHub workspace is destroyed.

## Updates (`expo-updates.ts`)

- `expo-updates.ts` is the only file that imports `expo-updates`. `isSupported()` checks `Platform.OS` first — the web shim claims `isEnabled = true` and implements nothing. `useUpdateState()` always calls `useUpdates()` and masks its output when unsupported.
- `Updates.channel` (embedded from `APP_VARIANT`) is the install's channel; never add a runtime channel override or stored channel preference.
- Never reload automatically: `checkNow` downloads and stops; the restart is a banner the person taps. Automatic checks are throttled to 15 min and single-flighted; "Check now" bypasses the throttle.
