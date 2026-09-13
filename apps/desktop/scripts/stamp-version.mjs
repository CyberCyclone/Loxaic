#!/usr/bin/env node
// Stamps the release version into the three package files that carry one —
// apps/desktop/package.json, apps/server/package.json, apps/mobile/app.json's
// expo.version — from a git tag, and does nothing else. CI is the only
// caller, always from a tag; there is deliberately no "bump" mode.
//
// Committed versions stay at 0.0.0: a dev/e2e build reporting 0.0.0 reads as
// "unreleased" (the updater is off there regardless — see the update-channel
// stage), and the alternative — a bot commit bumping version numbers on every
// tag — is churn this repo doesn't need. `@expo/fingerprint` also excludes
// `version` from what it hashes, so stamping never forces a native rebuild.
//
// Usage:
//   stamp-version.mjs <tag>          rewrite all three files in place
//   stamp-version.mjs --parse <tag>  print version/prerelease/channel as
//                                    key=value lines, for $GITHUB_OUTPUT
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

// vX.Y.Z or vX.Y.Z-beta.N — nothing else. A tag like `v1.2.0-alpha.1` or
// `v1.2` is rejected rather than guessed at, since a shape this parser
// doesn't recognise is far more likely a typo than a new release kind.
const TAG_PATTERN = /^v(\d+\.\d+\.\d+)(?:-beta\.(\d+))?$/;

/**
 * Parses a release tag into the version to stamp and which channel(s) it
 * publishes to. Throws on anything that doesn't match — a CI job should fail
 * loudly on an unexpected tag, not silently stamp something wrong.
 */
export function parseReleaseTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (!match) {
    throw new Error(`not a release tag: "${tag}" (expected vX.Y.Z or vX.Y.Z-beta.N)`);
  }
  const [, base, betaN] = match;
  const prerelease = betaN !== undefined;
  return {
    version: prerelease ? `${base}-beta.${betaN}` : base,
    prerelease,
    channel: prerelease ? "beta" : "production",
  };
}

/**
 * Rewrites a package.json's top-level "version" field with a targeted string
 * replace rather than a parse-mutate-reserialize round trip — a JSON.stringify
 * would also normalise formatting (indentation, key order) the rest of the
 * file was hand-written with, turning a one-line diff into a noisy one every
 * release. Fails loudly if the field isn't found rather than silently no-op.
 */
const VERSION_FIELD = /"version":\s*"[^"]*"/;

function stampPackageJson(file, version) {
  const raw = readFileSync(file, "utf8");
  // Checked as a match, not as "did the string change": restamping a file to
  // the version it already has is a real, idempotent case (CI re-running a
  // tag, or a version that happens to repeat), and comparing the replaced
  // string to the original would misread that as "no field found" — which is
  // exactly the bug this comment replaced.
  if (!VERSION_FIELD.test(raw)) {
    throw new Error(`no "version" field found in ${file}`);
  }
  writeFileSync(file, raw.replace(VERSION_FIELD, `"version": "${version}"`));
}

/** app.json's version lives one level down, at expo.version — a real parse
 * here (not a string replace) is safe because Expo's CLI already treats this
 * file as JSON it may rewrite (`eas update:configure`, `expo prebuild`), so
 * there's no existing hand-formatting convention to preserve.
 *
 * This is also why `apps/mobile/app.config.js` overlays app.json rather than
 * replacing it: a config that only existed as JavaScript would leave this
 * nothing to write to. That file passes `version` through untouched, which is
 * the half of the contract it has to keep. */
function stampAppJson(file, version) {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.expo || typeof parsed.expo.version !== "string") {
    throw new Error(`no expo.version field found in ${file}`);
  }
  parsed.expo.version = version;
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
}

/** Rewrites all three files in place, rooted at `repoRoot` (a parameter, not
 * the module-level constant, so this is testable against a scratch tree). */
export function stampFiles(repoRoot, version) {
  stampPackageJson(path.join(repoRoot, "apps/desktop/package.json"), version);
  stampPackageJson(path.join(repoRoot, "apps/server/package.json"), version);
  // The *numeric* version for the mobile app, even on a beta tag — see
  // marketingVersion.
  stampAppJson(path.join(repoRoot, "apps/mobile/app.json"), marketingVersion(version));
}

/**
 * The version a store will accept, which is not always the version of the
 * release.
 *
 * `expo.version` becomes `CFBundleShortVersionString`, and Apple requires that
 * to be a period-separated list of at most three integers — `1.2.0-beta.1` is
 * rejected at upload with ITMS-90060. The submission is scheduled server-side
 * and the build runs `--no-wait`, so that rejection lands long after the
 * release workflow has reported success: every beta would silently never reach
 * TestFlight, from a green run.
 *
 * The prerelease counter is not lost, it just is not carried here. A beta
 * build is told apart by its build number, which EAS increments per submission
 * (`autoIncrement`, `appVersionSource: remote`), and by the channel the app
 * reports in Settings. The desktop and server keep the full `1.2.0-beta.1`,
 * because electron-updater's feed rules depend on the prerelease component.
 */
export function marketingVersion(version) {
  return version.split("-")[0];
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--parse") {
    const { version, prerelease, channel } = parseReleaseTag(args[1]);
    // $GITHUB_OUTPUT format: one key=value pair per line.
    process.stdout.write(`version=${version}\n`);
    process.stdout.write(`prerelease=${String(prerelease)}\n`);
    process.stdout.write(`channel=${channel}\n`);
    return;
  }
  const tag = args[0];
  if (!tag) {
    console.error("usage: stamp-version.mjs <tag>  |  stamp-version.mjs --parse <tag>");
    process.exit(1);
  }
  const { version } = parseReleaseTag(tag);
  stampFiles(REPO_ROOT, version);
  console.log(`stamped ${version} into desktop/server package.json and mobile app.json`);
}

// Only run as a CLI, not when imported by the test file.
//
// Compared as real paths on both sides, not as strings. Gluing "file://" onto
// argv[1] matched only on POSIX paths with nothing to percent-encode — every
// windows-latest release leg and any checkout under a path with a space had
// main() silently never run: exit 0, nothing stamped, every file still at
// 0.0.0, the one failure this script exists to prevent. Converting argv[1]
// to a URL is not enough either: Node resolves the entry module through
// symlinks, so `import.meta.url` is the *real* path while argv[1] is what was
// typed — different on macOS for anything under /var → /private/var, which
// the subprocess test found the moment it ran. realpath on both is what
// makes them the same file whenever they are.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main();
}
