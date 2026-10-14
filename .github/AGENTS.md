# .github

CI and release workflows: `ci.yml`, `release.yml` (desktop installers, GitHub release, mobile OTA and store builds) and `dev-update.yml`. These rules cover what a release must and must not do, and the traps in its shell.

## Shell in workflows

- Never pipe into `grep -q` under `pipefail`: the early exit fails the pipeline on a match. Capture the output, then match with a here-string (`grep -qx … <<< "$out"`).
- The `meta` step branches on the parsed `prerelease` value being exactly `true` or `false`; anything else (including empty output) fails the step rather than falling through to stable.
- `meta` parses the tag with `apps/desktop/scripts/stamp-version.mjs` (`parseReleaseTag`); never parse tags a second way here.

## Secrets and permissions

- **Pin every action to a commit SHA and scope `contents: write` to the release jobs that need it.** Windows/Linux updates have no authenticity check beyond the `sha512` in the same release, so whoever can write a release asset gets code execution on every install.
- Expose the signing and notarization secrets only to the macOS package step. Its shell unsets empty values and unsets all of them on non-macOS legs: `""` breaks electron-builder, and `WIN_CSC_LINK` falls back to `CSC_LINK`, which would sign the NSIS installer with the Apple certificate.
- The `desktop` and `expo-update` jobs name `environment: release` so their secrets can move behind required reviewers. `dev-update.yml` also reads `EXPO_TOKEN` on every push to `dev`, so the gate protects nothing until its `dev-update` environment holds its own token and the repository copy is deleted.
- `EXPO_TOKEN` can publish JavaScript to every installed app (updates are unsigned on this EAS plan); it is the only Expo secret GitHub holds. EAS holds the App Store Connect and Play service-account keys.
- Each iOS submit profile in `apps/mobile/eas.json` carries `ascAppId`; non-interactive `eas submit` cannot look it up. It is not a secret.

## Desktop release

- Draft first (`create-release`, idempotent), upload every leg with `EP_DRAFT=true`, undraft last in `publish-release`. Drafts are invisible to installed updaters.
- On re-run, reuse an existing release only while it is still a draft; a published tag fails the run.
- The package matrix uses `fail-fast: false`; `publish-release` runs on `always()` minus cancellation and counts installer assets before undrafting.
- The installer guard checks separately for no assets at all, and requires each platform that uploaded an installer to also have its feed (`beta-mac.yml`/`beta-linux.yml`/`beta.yml`, `latest*` for stable) — counted per variant and per platform, never as a total.
- On macOS runners raise `kern.maxfilesperproc` with `sudo sysctl` and `ulimit -n` before signing; `ulimit` alone still hits `EMFILE` in osx-sign.
- The signing certificate must be Developer ID Application; an Apple Development certificate signs but cannot be notarized. Check with `security find-identity -v -p codesigning`.

## Branch pointers

- A release is cut from `dev` by pushing a `vX.Y.Z` (or `vX.Y.Z-beta.N`) tag, the only thing that sets a version; `workflow_dispatch` re-publishes an existing tag.
- The `master` and `beta` rulesets block only deletion and force pushes: a user-owned repo cannot exempt the Actions app, so stricter rules would stop `advance-branches`.
- The git `beta` branch and the EAS `beta` channel are unrelated.
- `advance-branches` moves `beta` and `master` with a non-forced push, only after `publish-release` and `expo-update` succeed. Keep `expo-update` in its `needs`: `if: success()` sees only its own needs.
- `publish-release` deliberately tolerates a failed `expo-update` (the installers are real); only the pointers must not claim more than shipped.

## Mobile OTA and store builds

- Set `APP_VARIANT` job-wide on `expo-update` to the matrix variant. Variants have different runtime versions, so an update published under the wrong one reaches nobody, silently.
- The EAS environment for the beta variant is `preview` (EAS has only development/preview/production); keep it in step with `eas.json`.
- A release tag publishes OTA to both `production` and `beta`; a beta tag to beta only.
- Runtime versions are per platform and per variant: the publish step emits `runtime_ios` and `runtime_android` and fails if either is missing or reports more than one.
- Start a native build only when `eas build:list` has no finished build for that runtime and variant; `force_native_build` overrides.
- When the gate finds a build, skip build and submit entirely. Never call `eas submit --non-interactive` without a target, and never use `--latest` (it ignores profile and runtime).
- Submission goes only to TestFlight/App Store Connect and Play's internal track via `--auto-submit-with-profile`; a tag push must never release to users unreviewed.
- Collect store-submit failures per platform and fail after both have run; an iOS failure must not skip Android.
- Only the `dev` variant builds an APK; beta and production submit App Bundles to their own Play listings.
- Never add an Expo Go path to update workflows; Expo Go cannot open published updates.
- CI cannot create EAS credentials: the first build of each platform and variant is run by hand once, and each Play listing's first bundle is uploaded by hand in Play Console. A credentials error in CI usually means that step was skipped.
