#!/usr/bin/env bash
# Cuts a release by pushing a tag.
#
# A version lives in exactly one place — the tag — and this is what puts it
# there. Nothing is committed: `apps/desktop/scripts/stamp-version.mjs` writes
# the number into the three package files during the release run, so the
# repository stays at 0.0.0 and there is no bot commit bumping versions.
#
#   ./scripts/release.sh beta         next beta of the next patch
#   ./scripts/release.sh beta:minor   ...of the next minor, or beta:major
#   ./scripts/release.sh promote      release the beta that is under test
#   ./scripts/release.sh patch        a release with no beta before it
#   ./scripts/release.sh minor|major
#
#   --dry-run   print what would be tagged, and push nothing
#
# What each kind publishes is in docs/DEPLOY.md; the short version is that a
# beta tag reaches beta testers on both mobile and desktop, and a release tag
# reaches everyone *and* beta testers, so beta is never behind stable.
#
# This runs from your workstation rather than a workflow because cutting a
# release is a decision. CI does everything after the tag exists.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

die() { printf '%s\n' "$*" >&2; exit 1; }

KIND=""
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -*) die "unknown option: $arg" ;;
    *) [ -z "$KIND" ] || die "give one release kind, not two"; KIND="$arg" ;;
  esac
done
[ -n "$KIND" ] || die "usage: $0 {beta|beta:minor|beta:major|promote|patch|minor|major} [--dry-run]"

command -v gh >/dev/null || die "gh is not installed — it is what watches the run afterwards"
gh auth status >/dev/null 2>&1 || die "gh is not signed in (run: gh auth login)"

# Tags first: the next version is computed from what exists on the remote, not
# from whatever this checkout last fetched. A stale view would happily mint a
# tag that already exists somewhere else.
echo "→ fetching tags"
git fetch --quiet --tags --prune-tags origin
git fetch --quiet origin dev

NEXT="$(node apps/desktop/scripts/next-tag.mjs "$KIND")" || exit 1

# `promote` tags the commit the beta was cut at, deliberately: promoting means
# "release exactly what the beta testers have been running", and taking dev's
# head instead would ship whatever landed since, untested by anyone.
if [ "$KIND" = "promote" ]; then
  # The highest beta of the version being promoted — `sort -V` so beta.10
  # outranks beta.9, which a lexical sort gets wrong.
  BETA_TAG="$(git tag --list "${NEXT}-beta.*" | sort -V | tail -1)"
  [ -n "$BETA_TAG" ] || die "cannot find the beta tag $NEXT was promoted from"
  TARGET="$(git rev-parse "$BETA_TAG^{commit}")"
  SOURCE="$BETA_TAG"
else
  TARGET="$(git rev-parse origin/dev)"
  SOURCE="origin/dev"
fi

cat <<EOF

  tag     $NEXT
  at      ${TARGET:0:8}  ($SOURCE)
  message $(git log -1 --format=%s "$TARGET")

EOF

if [ "$DRY_RUN" = true ]; then
  echo "(--dry-run: nothing pushed)"
  exit 0
fi

git tag -a "$NEXT" -m "$NEXT" "$TARGET"
# Pushed by full refspec so a branch of the same name could never be written
# by accident.
git push origin "refs/tags/$NEXT"

cat <<EOF

Pushed $NEXT. The release workflow is what happens next:

  gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')

It publishes the update, builds what needs building, and undrafts the GitHub
release only once an installer has actually uploaded.
EOF
