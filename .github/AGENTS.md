# .github

CI and release workflows: `ci.yml`, `release.yml` (desktop installers, GitHub release, mobile OTA and store builds) and `dev-update.yml`. These rules cover what a release must and must not do, and the traps in its shell.

## Shell in workflows

- Never pipe into `grep -q` under `pipefail`: the early exit fails the pipeline on a match. Capture the output, then match with a here-string (`grep -qx … <<< "$out"`).

## Secrets and permissions

- **Pin every action to a commit SHA and scope `contents: write` to the release jobs that need it.** Windows/Linux updates have no authenticity check beyond the `sha512` in the same release, so whoever can write a release asset gets code execution on every install.
- Expose the signing and notarization secrets only to the macOS package step. Its shell unsets empty values and unsets all of them on non-macOS legs: `""` breaks electron-builder, and `WIN_CSC_LINK` falls back to `CSC_LINK`, which would sign the NSIS installer with the Apple certificate.
- The `desktop` and `expo-update` jobs name `environment: release` so their secrets can move behind required reviewers. `dev-update.yml` also reads `EXPO_TOKEN` on every push to `dev`, so the gate protects nothing until its `dev-update` environment holds its own token and the repository copy is deleted.
- `EXPO_TOKEN` can publish JavaScript to every installed app (updates are unsigned on this EAS plan); it is the only Expo secret GitHub holds. EAS holds the App Store Connect and Play service-account keys.
- Each iOS submit profile in `apps/mobile/eas.json` carries `ascAppId`; non-interactive `eas submit` cannot look it up. It is not a secret.

## Desktop release

- The signing certificate must be Developer ID Application; an Apple Development certificate signs but cannot be notarized. Check with `security find-identity -v -p codesigning`.

## Branch pointers

- A release is cut from `dev` by pushing a `vX.Y.Z` (or `vX.Y.Z-beta.N`) tag, the only thing that sets a version; `workflow_dispatch` re-publishes an existing tag.
- The `master` and `beta` rulesets block only deletion and force pushes: a user-owned repo cannot exempt the Actions app, so stricter rules would stop `advance-branches`.
- The git `beta` branch and the EAS `beta` channel are unrelated.

## Mobile OTA and store builds

- Every checkout that bundles the app (`desktop`, `expo-update`, `dev-update.yml`) needs `fetch-depth: 0`: Metro writes the changelog from tags, and a shallow clone ships one that says it is missing.
- The EAS environment for the beta variant is `preview` (EAS has only development/preview/production); keep it in step with `eas.json`.
- Submission goes only to TestFlight/App Store Connect and Play's internal track via `--auto-submit-with-profile`; a tag push must never release to users unreviewed.
- Only the `dev` variant builds an APK; beta and production submit App Bundles to their own Play listings.
- Never add an Expo Go path to update workflows; Expo Go cannot open published updates.
- CI cannot create EAS credentials: the first build of each platform and variant is run by hand once, and each Play listing's first bundle is uploaded by hand in Play Console. A credentials error in CI usually means that step was skipped.
