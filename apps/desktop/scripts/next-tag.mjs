#!/usr/bin/env node
// Works out the next release tag from the tags that already exist, so nobody
// has to type a version number and get it wrong. `scripts/release.sh` is the
// only caller; this file exists separately because deciding a version is worth
// testing, and a shell script is not where that belongs.
//
// Usage:
//   next-tag.mjs beta          the next beta of the next patch
//   next-tag.mjs beta:minor    ...of the next minor, or major
//   next-tag.mjs promote       the release the current beta is a candidate for
//   next-tag.mjs patch|minor|major   a release with no beta before it
//
// Tags come from `git tag --list 'v*'`. The decision itself is a pure function
// over a list of tags (`nextTag`), which is what the tests exercise — reading
// them from stdin as well looked convenient and was not: under command
// substitution stdin is neither a TTY nor readable, and `readFileSync(0)`
// fails with EAGAIN, which is how release.sh first tried to run.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseTag } from "./stamp-version.mjs";

/**
 * Every tag this repository recognises, newest first.
 *
 * Ordered by semver rather than by creation date: a tag can be pushed at any
 * commit and at any time, so "the last one I made" is not a reliable answer to
 * "what version are we on". A stable release sorts *after* its own betas —
 * 1.2.0 is newer than 1.2.0-beta.9 — which is what makes `promote` and the
 * bump commands agree about where they are starting from.
 */
export function orderTags(tags) {
  return tags
    .map((tag) => {
      try {
        const { version, prerelease } = parseReleaseTag(tag);
        const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
        const betaN = prerelease ? Number(version.split("-beta.")[1]) : 0;
        return { tag, major, minor, patch, prerelease, betaN };
      } catch {
        // A tag this parser does not recognise is not a release of ours.
        return null;
      }
    })
    .filter((t) => t !== null)
    .sort(
      (a, b) =>
        b.major - a.major ||
        b.minor - a.minor ||
        b.patch - a.patch ||
        // Stable outranks any beta of the same version.
        Number(a.prerelease) - Number(b.prerelease) ||
        b.betaN - a.betaN,
    );
}

const BUMP = {
  patch: (v) => ({ major: v.major, minor: v.minor, patch: v.patch + 1 }),
  minor: (v) => ({ major: v.major, minor: v.minor + 1, patch: 0 }),
  major: (v) => ({ major: v.major + 1, minor: 0, patch: 0 }),
};

const ZERO = { major: 0, minor: 0, patch: 0, prerelease: false, betaN: 0 };

/**
 * The next tag for `kind`, given the tags that exist.
 *
 * The rules, and why:
 *
 *   - `beta` continues an unreleased beta line (`-beta.2` after `-beta.1`) or
 *     starts one for the next patch. `beta:minor` / `beta:major` start one for
 *     a larger bump, since the size of a release is known when the first beta
 *     is cut, not when it ships.
 *   - `promote` drops the `-beta.N` from the newest beta. It refuses when the
 *     newest tag is already stable, because there is nothing to promote —
 *     asking for that is far more likely a mistake than an intent.
 *   - `patch`/`minor`/`major` bump from the newest *stable* tag and refuse if a
 *     beta of something newer exists, because publishing a release that skips
 *     the beta everyone is testing is a decision, not a default. The message
 *     names `promote` instead.
 */
export function nextTag(kind, tags) {
  const ordered = orderTags(tags);
  const newest = ordered[0] ?? ZERO;
  const newestStable = ordered.find((t) => !t.prerelease) ?? ZERO;

  if (kind === "promote") {
    if (!newest.prerelease) {
      throw new Error(
        `the newest tag is ${newest.tag ?? "(none)"}, which is not a beta — nothing to promote`,
      );
    }
    return `v${newest.major}.${newest.minor}.${newest.patch}`;
  }

  if (kind.startsWith("beta")) {
    const size = kind.includes(":") ? kind.split(":")[1] : "patch";
    if (!BUMP[size]) throw new Error(`unknown bump "${size}" (expected patch, minor or major)`);
    // Already mid-beta for an unreleased version: the next one continues it
    // rather than starting a new line one patch further on.
    if (newest.prerelease) {
      return `v${newest.major}.${newest.minor}.${newest.patch}-beta.${newest.betaN + 1}`;
    }
    const next = BUMP[size](newestStable);
    return `v${next.major}.${next.minor}.${next.patch}-beta.1`;
  }

  if (!BUMP[kind]) {
    throw new Error(`unknown release kind "${kind}" (expected beta, promote, patch, minor or major)`);
  }
  if (newest.prerelease) {
    throw new Error(
      `${newest.tag} is a beta of an unreleased version — use "promote" to release it, ` +
        `or delete the tag if it is abandoned`,
    );
  }
  const next = BUMP[kind](newestStable);
  return `v${next.major}.${next.minor}.${next.patch}`;
}

function readTags() {
  return execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function main() {
  const kind = process.argv[2];
  if (!kind) {
    console.error("usage: next-tag.mjs <beta|beta:minor|beta:major|promote|patch|minor|major>");
    process.exit(1);
  }
  process.stdout.write(nextTag(kind, readTags()) + "\n");
}

// Only run as a CLI, not when imported by the test. Both sides realpath'd for
// the reason stamp-version.mjs documents at length: Node resolves the entry
// module through symlinks, so a plain comparison misses on macOS's
// /var → /private/var and anywhere the path needs encoding.
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
