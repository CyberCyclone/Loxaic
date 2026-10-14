# apps/mobile/app

expo-router routes: the root layout, sign-in, onboarding and change-password at the top level, and every signed-in screen under `(app)/`. These rules cover layout ordering and screen-level data handling.

## Layouts

- Keep `useLocalExecutorSync` in the root `_layout.tsx`, above the auth gate — `AppShell` unmounts the moment the token clears and would never send the null.
- The `(app)` layout redirects a user flagged `must_change_password` to the top-level `/change-password`; everything inside the shell would answer 403.
- The onboarding column is a `ScrollView`, not a centred `Box`: the Host step outgrows a short window.

## Screens

- Admin `openDetail` re-checks the selected row after its await before installing a transcript and cursor — a late response otherwise lands under another row.
- Routine rows show the live badge while running, then the recorded status (`threadList.status.<id>`); when the badge goes, re-fetch the record, retrying while it lags (`routineRecordCheck`), and show nothing meanwhile.
- The routine delete dialog's count comes from `GET /:id/conversations/count`, not the 50-row listing; an unknown count is null, never 0 (`deleteRoutineMessage`).
- Show "Model unavailable" for an unresolvable routine model only once the model list has loaded (`modelsLoaded`); never fall through to the raw ref.
- Wait settings live on `checkins.tsx` (`settings.nav.checkins`), not the settings modal; each control hides when the server omits its field.
