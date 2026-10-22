# apps/mobile/components

UI components, including the vendored gluestack primitives in `ui/`. These rules cover overlays, keyboards, web-only quirks of the vendored components, and component-level rules that new components must follow.

## Vendored gluestack (`ui/`)

- `box`, `heading`, `hstack`, `vstack` and `text` `index.web.tsx` are hand-patched to emit `data-testid={testID}`; re-apply the patch if gluestack is ever re-vendored.
- Never put a testID on an `Icon` (its web layer is unpatched); put it on the wrapping `Pressable`/`Button`.
- Never pass a `withUniwind` component a `className` that is present but undefined (styleq error toast); omit the prop. A `tva({})` with no base classes returns undefined.
- On web a raw RN `Text` inside a gluestack `Text` does not inherit its style (the gluestack web `Text` is a `<span>`); wrap the inlines in one RN `Text` styled `inherit`, as `renderInlineRun` does.
- Overlays animate with reanimated `entering`/`exiting` layout animations (`ui/modal`, `menu`, `popover`, `actionsheet/animated.tsx`). On web `entering` must be a built-in animation, never `.withInitialValues(...)`: a custom one writes inline position and size that freezes the modal at its loading size. `ModalContent`/`Menu` use `FadeIn` on web, zoom on native.

## Modals and sheets

- Any modal that can grow past a handful of rows needs both `max-h-[85%]` on `ModalContent` and `scrollEnabled` on `<ModalBody>` — the vendored `ModalBody` hardcodes `scrollEnabled={false}` (a caller prop wins). Check both halves whenever you add a row.
- A modal whose rows are a long, growing list (`ChangelogModal`) uses a virtualised list with `flexShrink: 1` in place of `ModalBody`, under the same `max-h-[85%]`; full screen on a phone, `h-full w-full` replaces the cap.
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

- Nudges and notices nobody typed (compaction nudge `chat.message.compactionNudge`, plan nudge, check-in nudge, a sub-agent's `fromAgent` turns) render as notices, not user bubbles.

## Plan review and sub-agents

- Plan and questions panels share `ReviewSheet`; never duplicate it. A panel's draft (and its chosen model) is keyed to its call id, never reset in an effect — panels stay mounted while closed.

## Markdown

- Model-card HTML is converted to markdown (`markdown/html.ts`, via `<Markdown html />`, details sheet only), never rendered as HTML. Code is untouched, unknown tags stay literal, images are not fetched.
- Only http(s) and mailto links survive, in the converter and in `openLink` for every markdown link.

## Host models and providers

- The provider API key field is never seeded: empty means keep; removal is an explicit Remove control sending `apiKey: null`. Warn when a keyed provider's address changes, and derive the plain-http warning from the stored key as well as the field.
- The provider allowlist editor guards every state write (spinner included) with a request counter and retires the in-flight request on close — otherwise one provider's list is saved as another's allowlist.

