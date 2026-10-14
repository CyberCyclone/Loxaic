# apps/mobile/components

UI components, including the vendored gluestack primitives in `ui/`. These rules cover overlays, keyboards, web-only quirks of the vendored components, and component-level decisions that look arbitrary but are load-bearing.

## Vendored gluestack (`ui/`)

- `box`, `heading`, `hstack`, `vstack` and `text` `index.web.tsx` are hand-patched to emit `data-testid={testID}`; re-apply the patch if gluestack is ever re-vendored.
- Never put a testID on an `Icon` (its web layer is unpatched); put it on the wrapping `Pressable`/`Button`.
- Never pass a `withUniwind` component a `className` that is present but undefined (styleq error toast); omit the prop. A `tva({})` with no base classes returns undefined.
- On web a raw RN `Text` inside a gluestack `Text` does not inherit its style (the gluestack web `Text` is a `<span>`); wrap the inlines in one RN `Text` styled `inherit`, as `renderInlineRun` does.
- Overlays animate with reanimated `entering`/`exiting` layout animations (`ui/modal`, `menu`, `popover`, `actionsheet/animated.tsx`). On web `entering` must be a built-in animation, never `.withInitialValues(...)`: a custom one writes inline position and size that freezes the modal at its loading size. `ModalContent`/`Menu` use `FadeIn` on web, zoom on native.

## Modals and sheets

- Any modal that can grow past a handful of rows needs both `max-h-[85%]` on `ModalContent` and `scrollEnabled` on `<ModalBody>` — the vendored `ModalBody` hardcodes `scrollEnabled={false}` (a caller prop wins). Check both halves whenever you add a row.
- Never stack modals. Swap one for another as siblings rendered by the screen (`ModelModal` beside `RoutineModal` or the plan panel); on iOS open the second `SHEET_EXIT_MS` after the first starts closing. Never put a dialog over a sheet (`sheetGone`).
- Size an Actionsheet with an inner view from `useWindowDimensions()` and safe-area insets — a height class on `ActionsheetContent` is erased on native and `snapPoints` is read once at load. `McpToolsSheet` gives its list a height up front on native for the same reason.
- `SettingsModal` renders once, in `AppShell`; screens open it with `useShell().openSettings()` and never render their own.
- Any Modal or Actionsheet with server-backed buttons carries a `DisconnectedNote`: portals render above `ConnectionBanner`.
- A sheet's draft is built from a snapshot of the row it opened on, never the polled object — each poll would reset the draft (model settings sheet).

## Keyboard

- Any modal or sheet with number or URL fields uses `keyboardDismissMode="on-drag"` on its scroll body: iOS number pads and URL keyboards have no close key, and `closeKeyboard()` in e2e relies on the drag.
- Lists inside a modal with a search field use `keyboardShouldPersistTaps="handled"`, or the first tap only closes the keyboard.
- Long sheets with text fields near the bottom set `automaticallyAdjustKeyboardInsets`.
- The permission bar and the step check-in banner dismiss the keyboard on mount, native only (on web it would steal focus from typing). Key them by the question (`approvalKey`/`checkinKey`) so they remount for a new one.

## Chat thread and composer

- `MessageList` stickiness: on native only drag scroll events count; on web every scroll event counts — react-native-web reports drags for touch only. Follow-newest re-arms on the newest message's id, never the count.
- Approve and Deny close their dialog only once `trySend` says the answer went out, as Stop and the check-in do.
- A child's approval uses the surface's own component (`PermissionBar` on Agent, `ToolApprovalDialog` on routines) with a `source` line; the run's own approval wins.
- Offer no standing grant ("Allow always") when the approval lacks `mode`/`granter_user_id` (older server).
- The step check-in is a banner (`StepCheckInBanner`), never a modal: the transcript must stay readable behind it.
- Nudges and notices nobody typed (compaction nudge `chat.message.compactionNudge`, plan nudge, check-in nudge, a sub-agent's `fromAgent` turns) render as notices, not user bubbles.
- The omitted-attachments notice renders on the newest message only, only on positive information, and recommends compaction, never re-attaching.
- `expo-image-picker` is native-only: the attach control is split (`composer/ComposerPlusMenu.tsx` / `.web.tsx`). Web keeps a persistent `<input type="file">` (`composer.attach.input`) mounted for the composer's lifetime, outside the `+` popup, clicked inside the press handler so the user gesture counts.
- The web `+` is not gluestack `Menu` (no submenus): `ComposerPlusMenu.web.tsx` places plain-`div` panels via `lib/submenuPlacement.ts`, opens submenus on hover with a 150 ms close delay, and at phone width opens a submenu that replaces the menu only on press, never hover.
- The native `+` sheet picks its page through `plusMenuPage`, which falls back to the main page when a page's content disappears.
- MCP switches are owner-only; show a shared editor the switches locked with the reason.
- Context-stage modals' Compact goes through `compactRequest`.

## Plan review and sub-agents

- Plan and questions panels share `ReviewSheet`; never duplicate it. A panel's draft (and its chosen model) is keyed to its call id, never reset in an effect — panels stay mounted while closed.
- The Accept mode dropdown is a list inside the sheet, never a floating `Menu`.
- `SubAgentCard` replaces the tool card through `SubAgentContext`; the sub-agent panel is `ReviewSheet` with `scroll={false}` holding its own `MessageList` with a distinct `testID`.

## Agent screen

- The mode control is the run header's `ModeSwitch` (segments keep `agent.mode.<mode>` ids); the no-run placeholder has its own switch.
- The Inspector body sits in a `ScrollView` in both layouts. Tool-card and Inspector testIDs: `agent.inspector.panel`, `agent.inspector.changedFiles.count`, `chat.toolCall.<callId>`, `chat.toolCall.result.<callId>`.
- The workspace chooser reads `GET /v1/config` and refuses GitHub with the reason and fix when sandbox networking is off, never hides it. It resets its repo half on open, and a container choice must not survive onto a machine without an engine.
- The terminal panel holds a socket only while open and never creates a workspace (it may resume a paused one). Web/Electron use `@xterm/xterm` with the DOM renderer only (no canvas/WebGL addons); native uses a text view; both keep the `agent.terminal.input` line input.
- The delete-confirm wording comes from `/v1/config` and claims neither outcome while it loads.

## Markdown

- Model-card HTML is converted to markdown (`markdown/html.ts`, via `<Markdown html />`, details sheet only), never rendered as HTML. Code is untouched, unknown tags stay literal, images are not fetched.
- Only http(s) and mailto links survive, in the converter and in `openLink` for every markdown link.
- Size list markers per list (`markerWidth` in `markdown/blocks.tsx`), never a fixed width.

## Host models and providers

- The provider API key field is never seeded: empty means keep; removal is an explicit Remove control sending `apiKey: null`. Warn when a keyed provider's address changes, and derive the plain-http warning from the stored key as well as the field.
- The provider allowlist editor guards every state write (spinner included) with a request counter and retires the in-flight request on close — otherwise one provider's list is saved as another's allowlist.
- `ModelModal`: hide recents while searching; otherwise render them in addition to their group (`models.recent.<id>` vs `models.row.<id>`). Cap one provider at 50 rows behind "N more — search" — a FlatList cannot nest in the ScrollView.
- Context-stage modals describe others' impact from the server's `others` (counts, last-used time), never names. A "won't fit" estimate warns but never disables Extend. Context settings ticks the stage the chat will be at (`chatStage`), not the loaded one.
- Runtime picker: track head and older-page requests separately (`ListRequests`), one row per tag. Clear its list as it opens (during render), not as it closes; lock row buttons while the runtime has changed since the list was fetched. Draw the switch confirmation under its row.
- Extra options: the runtime card holds its draft itself, not the collapsible section; a poll replaces the draft only when it is not edited (`followSaved`), never via a sticky "has typed" flag; flag concurrent edits with `changedElsewhere`. Hide the section when the server omits `runtime.extraOptions` — older servers answer 200 and drop the field.

## Shell and settings

- `AppShell` derives the active surface from the first path segment (`/routines/<id>` is a real route).
- Chat-list row testIDs carry the state (`threadList.run.<convId>.<state>`, label `….label`); `stopping` is a client overlay that shows over any notice.
- Show the desktop update row even when checks are off, with the reason.
- `describeVersion` renders `nativeBuild` — beta builds share the numeric version.
