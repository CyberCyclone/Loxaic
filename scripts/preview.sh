#!/usr/bin/env bash
# Per-pull-request preview environments on a machine you own.
#
# The direction of travel is deliberate: this runs on *your* workstation, which
# is already authenticated to GitHub, and pushes to the preview host over an
# SSH key you already have. Nothing in GitHub Actions holds a credential to the
# host, the host opens no inbound port to the internet, and the host needs no
# GitHub access of its own. A pull request's code is still *run* on that
# machine — that is what a preview is — so the isolation that matters is in
# compose.yml: containers with no Docker socket, their own database, and a mock
# inference backend.
#
#   ./scripts/preview.sh up 136        # deploy PR 136, print its URLs
#   ./scripts/preview.sh down 136      # destroy it, volumes and all
#   ./scripts/preview.sh list          # what is deployed right now
#   ./scripts/preview.sh sync          # destroy previews whose PR is closed
#   ./scripts/preview.sh logs 136      # follow a preview's logs
#
# Configuration, all overridable from the environment:
#
#   PREVIEW_SSH       where the previews run          (cgibson@192.168.1.13)
#   PREVIEW_HOSTNAME  what a phone dials to reach it  (pheonix.tail47eac7.ts.net)
#   PREVIEW_ROOT      where they live on that host    (loxaic-previews, under $HOME)
#
# PREVIEW_HOSTNAME is separate from PREVIEW_SSH on purpose: the deploy goes over
# the LAN address, which is fast and needs nothing, while the URL handed to the
# phone is the tailnet one that resolves from anywhere.
set -euo pipefail

SSH_TARGET="${PREVIEW_SSH:-cgibson@192.168.1.13}"
# The tailnet name rather than the LAN address, because this is the value that
# gets baked into the app bundle and advertised by Metro — and a phone testing a
# preview is as likely to be on cellular as on the house wifi. The ports stay
# published on every interface either way, so 192.168.1.13 keeps working for
# anything on the LAN; override PREVIEW_HOSTNAME for a device with no Tailscale.
PUBLIC_HOST="${PREVIEW_HOSTNAME:-pheonix.tail47eac7.ts.net}"
ROOT="${PREVIEW_ROOT:-loxaic-previews}"
BARE="$ROOT/repo.git"

die() { printf '%s\n' "$*" >&2; exit 1; }

on_host() { ssh -o BatchMode=yes "$SSH_TARGET" "$@"; }

# Two ports per PR, derived from its number so a preview's URL is stable across
# redeploys and predictable without looking anything up. The modulus wraps
# after 200 open PRs, which would collide; `up` checks for that below.
ports_for() {
  local pr="$1"
  SERVER_PORT=$(( 42000 + (pr % 200) * 2 ))
  METRO_PORT=$(( SERVER_PORT + 1 ))
}

require_pr() {
  [[ "${1:-}" =~ ^[0-9]+$ ]] || die "usage: $0 $2 <pr-number>"
}

# One-time host setup, idempotent so `up` can just call it every time rather
# than making you remember whether you have run it.
bootstrap() {
  on_host "set -e
    command -v docker >/dev/null || {
      echo 'docker is not installed on this host — see docs/PREVIEW.md' >&2
      exit 1
    }
    docker version >/dev/null 2>&1 || {
      echo 'cannot reach the docker daemon as this user — after usermod -aG docker you need a fresh login' >&2
      exit 1
    }
    mkdir -p \"\$HOME/$ROOT\"
    [ -d \"\$HOME/$BARE\" ] || git init --quiet --bare \"\$HOME/$BARE\""
}

up() {
  local pr="$1"
  require_pr "$pr" up
  ports_for "$pr"
  bootstrap

  # A wrapped port block belonging to a *different* live preview is the one
  # case where the deterministic scheme lies. Say so rather than fighting it
  # for the port.
  local clash
  clash="$(on_host "ls -1 \"\$HOME/$ROOT\" 2>/dev/null" \
    | sed -n 's/^pr-\([0-9]\{1,\}\)$/\1/p' \
    | awk -v me="$pr" '$1 != me && ($1 % 200) == (me % 200) { print $1 }' || true)"
  [ -z "$clash" ] || die "PR $pr wants the same ports as deployed PR $clash — 'down' that one first"

  # The commit under test is the PR's head as GitHub currently sees it, not
  # whatever this checkout happens to have fetched previously.
  local sha
  sha="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" \
    || die "could not read PR $pr from GitHub"
  git fetch --quiet origin "refs/pull/$pr/head" || die "could not fetch PR $pr"

  # Pushed to refs/preview/*, never refs/heads/*: git refuses to update a
  # branch that is checked out somewhere, and the preview checkout would be
  # exactly that. The worktree stays detached for the same reason.
  echo "→ pushing ${sha:0:8} to $SSH_TARGET"
  git push --quiet --force "$SSH_TARGET:$BARE" "$sha:refs/preview/pr-$pr"

  echo "→ checking out"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    bare=\"\$HOME/$BARE\"
    dir=\"\$root/pr-$pr\"

    if [ -e \"\$dir/.git\" ]; then
      git -C \"\$dir\" checkout --quiet --force --detach 'refs/preview/pr-$pr'
      # Anything an earlier commit left behind would otherwise ride into the
      # build context and make the image disagree with the ref it claims to be.
      git -C \"\$dir\" clean -xdfq
    else
      rm -rf \"\$dir\"
      git -C \"\$bare\" worktree prune
      git -C \"\$bare\" worktree add --quiet --detach \"\$dir\" 'refs/preview/pr-$pr'
    fi
    mkdir -p \"\$dir/infra/preview\""

  # The preview's own configuration comes from *this* checkout, never from the
  # pull request. Two reasons, and the second is the important one: a PR opened
  # before this tooling existed has no compose.yml at all and would be
  # undeployable, and a PR that did carry one could rewrite the terms it runs
  # under — mounting the Docker socket, say. The PR supplies the build context
  # and nothing else. Sent after `clean`, which would otherwise remove them.
  tar -cf - -C "$(git rev-parse --show-toplevel)" \
    infra/preview/compose.yml infra/docker/metro.Dockerfile \
    | on_host "tar -xf - -C \"\$HOME/$ROOT/pr-$pr\""

  echo "→ building (the first build installs the whole workspace, so it is slow)"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    dir=\"\$root/pr-$pr\"

    # Minted once per preview and kept, so redeploying a PR does not sign you
    # out of it mid-test.
    secret_file=\"\$root/pr-$pr.secret\"
    if [ ! -f \"\$secret_file\" ]; then
      openssl rand -hex 32 > \"\$secret_file\"
      chmod 600 \"\$secret_file\"
    fi

    # Outside the worktree, deliberately. server.Dockerfile does `COPY . .`
    # and .dockerignore does not exclude .env, so an env file inside the build
    # context would bake this preview's auth secret into an image layer — and
    # would bust the COPY cache on every config change, turning a 30-second
    # redeploy into a five-minute rebuild.
    cat > \"\$root/pr-$pr.env\" <<EOF
PREVIEW_SERVER_PORT=$SERVER_PORT
PREVIEW_METRO_PORT=$METRO_PORT
PREVIEW_HOSTNAME=$PUBLIC_HOST
PREVIEW_BASE_URL=http://$PUBLIC_HOST:$SERVER_PORT
PREVIEW_METRO_URL=http://$PUBLIC_HOST:$METRO_PORT
PREVIEW_AUTH_SECRET=\$(cat \"\$secret_file\")
EOF
    chmod 600 \"\$root/pr-$pr.env\"

    cd \"\$dir\"
    docker compose -p 'pr-$pr' -f infra/preview/compose.yml --env-file \"\$root/pr-$pr.env\" up -d --build"

  cat <<EOF

PR $pr is up.

  Web / API   http://$PUBLIC_HOST:$SERVER_PORT
  Expo Go     exp://$PUBLIC_HOST:$METRO_PORT

In Expo Go, enter that exp:// URL by hand — its scanner wants a QR code, which
this script has no way to put in front of your phone.
EOF
}

down() {
  local pr="$1"
  require_pr "$pr" down
  echo "→ destroying PR $pr"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    dir=\"\$root/pr-$pr\"
    if [ -e \"\$dir/infra/preview/compose.yml\" ] && [ -f \"\$root/pr-$pr.env\" ]; then
      cd \"\$dir\"
      # -v because a preview's database is disposable by definition, and
      # leaving volumes behind is how a host fills up one merged PR at a time.
      docker compose -p 'pr-$pr' -f infra/preview/compose.yml --env-file \"\$root/pr-$pr.env\" down -v --remove-orphans || true
    else
      docker compose -p 'pr-$pr' down -v --remove-orphans 2>/dev/null || true
    fi
    git -C \"\$HOME/$BARE\" worktree remove --force \"\$dir\" 2>/dev/null || rm -rf \"\$dir\"
    git -C \"\$HOME/$BARE\" update-ref -d 'refs/preview/pr-$pr' 2>/dev/null || true
    rm -f \"\$root/pr-$pr.secret\" \"\$root/pr-$pr.env\""
}

list() {
  echo "deployed on $SSH_TARGET:"
  on_host "docker compose ls --format json 2>/dev/null" \
    | PUBLIC_HOST="$PUBLIC_HOST" python3 -c '
import json, os, sys

host = os.environ["PUBLIC_HOST"]
raw = sys.stdin.read().strip()
rows = [r for r in (json.loads(raw) if raw else []) if r.get("Name", "").startswith("pr-")]
if not rows:
    print("  (none)")
for row in sorted(rows, key=lambda r: int(r["Name"][3:])):
    pr = int(row["Name"][3:])
    server = 42000 + (pr % 200) * 2
    print("  PR {:<5} {:<26} http://{}:{}   exp://{}:{}".format(
        pr, row.get("Status", "?"), host, server, host, server + 1))
'
}

# The other half of "destroy it once the PR is merged". Run it from a timer and
# a merged PR's environment goes away on its own — GitHub is only ever asked a
# read-only question, from here, over your existing auth.
sync() {
  local open_prs deployed gone=0
  open_prs="$(gh pr list --state open --json number --jq '.[].number' | sort -n)"
  deployed="$(on_host "ls -1 \"\$HOME/$ROOT\" 2>/dev/null" \
    | sed -n 's/^pr-\([0-9]\{1,\}\)$/\1/p' | sort -n)"

  for pr in $deployed; do
    if ! grep -qx "$pr" <<<"$open_prs"; then
      echo "PR $pr is no longer open"
      down "$pr"
      gone=$((gone + 1))
    fi
  done
  [ "$gone" -eq 0 ] && echo "nothing to clean up"
  return 0
}

logs() {
  local pr="${1:-}"
  require_pr "$pr" logs
  shift
  on_host -t "cd \"\$HOME/$ROOT/pr-$pr\" && docker compose -p 'pr-$pr' -f infra/preview/compose.yml --env-file \"\$HOME/$ROOT/pr-$pr.env\" logs -f ${*:-}"
}

case "${1:-}" in
  up)   shift; up "${1:-}" ;;
  down) shift; down "${1:-}" ;;
  list) list ;;
  sync) sync ;;
  logs) shift; logs "$@" ;;
  *)    die "usage: $0 {up|down|logs} <pr-number> | $0 {list|sync}" ;;
esac
