# apps/mobile

The one frontend (Expo + expo-router + gluestack-ui v5 + UniWind) for iOS, Android, web and the Electron renderer; its web export is the web app. These rules cover dependencies, build and update config, styling, testIDs, offline gating, and the `lib/`, `hooks/` and `app/` folders. `components/` has its own AGENTS.md. Keep decisions in `lib/` as pure, unit-tested functions; components and hooks only render or wire them.

## Expo and dependencies

- Expo SDK 57, New Architecture only: never add `newArchEnabled` to `app.json`; `expo prebuild` wipes `ios/`/`android/` unless given `--no-clean`.
- Upgrade the SDK inside `apps/mobile` with `npx expo install expo@^NN --fix`, then `npx expo install --check` and `npx expo-doctor@latest`.
- `runtimeVersion.policy: "fingerprint"`: any native or dependency change (an SDK bump included) starts a new EAS Update runtime that no existing binary receives.
- TypeScript is held back on purpose via `expo.install.exclude` in `package.json`; bump it workspace-wide in its own PR, never as a side effect of an SDK upgrade.
- **Never add a dependency with a required `nativewind` peer** — pnpm materialises a second React island ("Invalid hook call"). UniWind is the styling engine. If a second React appears (`ls node_modules/.pnpm | grep '^react@'`), fix the dependency; never re-add a React-singleton `resolveRequest` shim to `metro.config.js`.
- Keep `babel-preset-expo` a declared devDependency (pnpm does not hoist it where Babel resolves), and never list `react-native-worklets/plugin` in `babel.config.js` — the preset injects it; listing it twice breaks reanimated.
- Never set `EXPO_PUBLIC_USE_RN_FETCH=1` to work around an upload problem — it is inlined at bundle time and changes fetch app-wide (see Uploads under `lib/` below).

## Variants and over-the-air updates

- `app.config.js` is the only variant table (dev/beta/production); `APP_VARIANT` unset means production and an unknown value throws. Each `eas.json` profile sets the matching `APP_VARIANT`, and `eas update` must run with the same one as the build it targets — otherwise the update reaches nobody.
- Beta and production are separate apps and separate Play listings (`com.loxaic.app`, `com.loxaic.app.beta`), not tracks of one.
- Keep `updates.checkAutomatically: "ON_ERROR_RECOVERY"` — JS drives every check.
- OTA updates are unsigned (EAS signing is Enterprise-only). Never add `codeSigningCertificate` while updates come from EAS — such a build refuses every update for life.

## Styling and layout

- UI colours use semantic gluestack tokens only (`text-foreground`, `bg-primary`), never numbered Tailwind colours or hex in `className`. Exception: SVG fills/strokes take literal hex — `react-native-svg` cannot resolve CSS variables (see `ContextRing`). Tokens live in `global.css` (Tailwind v4 `@theme inline`, `@variant light`/`dark`); dark is the default.
- gluestack puts `min-h-0` on every `Box`/`VStack`, so a column taller than its parent compresses its children into each other rather than overflowing. Anything that can outgrow the screen sits in a `ScrollView` (`style={{flex: 1, minHeight: 0}}`).
- RN views default to `flexShrink: 0`. A data-derived label beside a control needs `min-w-0 shrink` plus truncation on the label and `shrink-0` on the control, or the label covers the control.
- To truncate a gluestack `Text` on web use `TRUNCATE_TEXT` from `lib/truncate.ts` plus `min-w-0` on the flex parent. `numberOfLines` is inert there, and the `truncate` class half-works: its `nowrap` loses to the base inline `whitespace-pre-wrap`.
- Never use `ButtonSpinner` outside a `Button` — it throws and blanks the whole tree; use `components/ui/spinner`.
- Never read a result back out of a `setState` updater (React may defer it); decide from a ref before the update.

## testIDs

- Name testIDs `area.element[.qualifier]`, dot-separated, lowerCamel per segment (`login.submit`, `agent.mode.manual`). `area` is the screen or component family; `qualifier` only comes from an existing data array (`MODES`, `NAV_ITEMS`) or a server id, never an invented string.
- Put the testID on the element the user touches (`InputField`, `TextareaInput`, `Pressable`, `Button`), not a wrapper. Only an assertion anchor with nothing interactive (a message bubble, an error `Text`) carries one on a non-interactive element.
- A testID on an element repeated per item must carry the item's id (`chat.toolCall.<callId>`); e2e never selects by position — lists are inverted and virtualised.
- Selected state that e2e reads goes in `aria-selected`; react-native-web drops `accessibilityState` through the gluestack `Pressable`.
- A new interactive element needs a testID, and every feature needs e2e coverage on each platform where it exists (`apps/e2e`).

## Offline and reachability

- Every control that needs the server reads `useServerReachable()` and is disabled when it is false; a handler that can race the change also checks `isOffline()`/`requireServer`. A failed request is reported with `describeRequestError`, never the raw "Failed to fetch".
- Stays enabled offline: the server address and its Test, Disconnect (`local` on `WarningConfirmModal`), theme, updates, tailnet settings, sign out, navigation, and reading what is loaded.
- A loader that could not ask keeps "could not ask" distinct from "none" ("Couldn't load… Try again", never "No X yet"), and asks again when the server is back. Likewise a figure that is unknown is omitted or shown as "?", never as 0.

## `lib/`

### Reachability (`connectionMonitor.ts`, `packages/api-client`)

- One app-wide reachability state: `connectionMonitor.ts` (controller) over pure `connectionMonitorCore.ts`, published by `connection.ts`. Screens never write it.
- Every REST request in `packages/api-client` goes through `serverFetch`, which reports `answered`/`suspect`/`stalled` to the observer. `isUnreachableError` means exactly "no answer" (`ServerUnreachableError`); never count an HTTP error as down.
- Only the `GET /health` probe can call the server down; a failed request never sets the state — 502/503 can come from our own server.
- Anything read from storage at launch must wait for `hydrateStorage()` — child effects run before `SessionProvider`'s.
- Electron is not same-origin: the API URL comes from `window.loxaic.apiBaseUrl` via `endpoint.ts`.
- A new client socket reports through `trackSocket`, or the monitor cannot tell an "open" socket to a stopped server.

### Uploads

- Native uploads use `nativeAttachmentFile` (`attachmentUpload.ts`), returning `{name, type, bytes()}` — `expo/fetch`'s FormData rejects RN's `{uri, name, type}` part before sending.

### Stream folds and timing

- Pass a snapshot's `server_now` through as received, never default it to `Date.now()` (`localDeadline`). Convert `expires_at` once on receipt (`pendingWaits.ts`) and keep it.
- Copy `author_user_id` in `foldSnapshot`/`applyEventToMsgs` only when the key is present. In `checkinNotice.ts` an id means that person, null means nobody (timed out), absent claims neither.

### Run state

- Never read a waiting approval's mode from the mode selector — the selector is the next message's mode.
- The selector follows the thread on screen only through `followSelector` (`lib/modeSelector.ts`); never reset it to a fixed mode on load, reconnect or thread switch.

### Updates (`expo-updates.ts`)

- `expo-updates.ts` is the only file that imports `expo-updates`; everything else goes through it.
- Never label `reusable_tokens` as cached: "cached" only when `promptReuse()` says the backend measured it, "reused" otherwise, and floor the percentage. The labels are written in `components/`, the decision in `lib/usage.ts`.

## `hooks/`

### Sockets and sends

- Read the clock once per socket message in the handler (`arrivedAt` in `onEvent`) and pass it down; never call `Date.now()` inside a fold or a state updater (React may defer or repeat it).
- Socket hooks never listen to AppState; the connection monitor owns that listener and asks for a replacement through `onReconnectRequest`.
- Every approval answer, the thread's own included, names the stream it arrived on (`toPendingApproval`'s `streamId`, `approvalStreamId`) — an unnamed answer can run another thread's call.

### Promotion: local id to real id

- "The real id arrived" is the session's `promotion` (`{localId, realId}`), never inferred from the ids — leaving an unsent new chat for an existing thread also goes from local to real.

### Skills

- Send an overridden `/compact` as a message, never `command.run`.

### Sheets

- `useKeyboardHeight` pads sheets for the keyboard (minus the bottom inset on iOS, whole on Android); `KeyboardAvoidingView` mis-measures inside a sheet.

## `app/`

### Screens

- Wait settings live on `checkins.tsx` (`settings.nav.checkins`), not the settings modal; each control hides when the server omits its field.
