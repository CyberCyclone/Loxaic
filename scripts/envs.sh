#!/usr/bin/env bash
# The two environments that run on the box: a preview slot and the dev stack.
#
#   preview   whichever pull request is being reviewed right now. One slot on
#             fixed ports, so the Expo Go link never changes — `preview up`
#             for a different PR replaces what is there rather than standing
#             a second one up beside it.
#   dev       the trunk. Redeployed as `dev` moves, kept between deploys, and
#             what the dev app build talks to.
#
# The direction of travel is deliberate: this runs on *your* workstation,
# which is already authenticated to GitHub, and pushes to the box over an SSH
# key you already have. Nothing in GitHub Actions holds a credential to the
# box, the box opens no inbound port to the internet, and the box needs no
# GitHub access of its own. A pull request's code is still *run* on that
# machine — that is what a preview is — so the isolation that matters is in
# infra/envs/compose.yml: containers with no Docker socket and their own
# database.
#
#   ./scripts/envs.sh preview up 136     # review PR 136 (replaces the slot)
#   ./scripts/envs.sh preview down       # destroy it, volumes and all
#   ./scripts/envs.sh preview sync       # destroy it if its PR has closed
#   ./scripts/envs.sh dev up             # deploy origin/dev; no-op if current
#   ./scripts/envs.sh dev down           # stop, keeping the database
#   ./scripts/envs.sh list               # both slots: what, which commit, URLs
#   ./scripts/envs.sh sync               # preview sync + dev up (the timer)
#   ./scripts/envs.sh <slot> logs [svc]  # follow logs
#
# Configuration lives in scripts/envs.local, which is gitignored (`*.local`)
# because this repository is going public and the box's address is nobody
# else's business:
#
#   ENVS_SSH=you@192.168.1.13                 # where the environments run
#   ENVS_HOSTNAME=yourbox.tailXXXX.ts.net     # what a phone dials to reach it
#   ENVS_ROOT=loxaic-envs                     # where they live, under $HOME
#   DEV_INFERENCE_URL=http://192.168.1.13:1234  # LM Studio for the dev slot
#
# ENVS_HOSTNAME is separate from ENVS_SSH on purpose: the deploy goes over the
# LAN address, which is fast and needs nothing, while the URL baked into the
# app bundle and advertised by Metro is the tailnet one that resolves from
# anywhere.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The environment wins over the file, which is the precedence every other
# configurable thing in this repo uses (env > stored > default) and the only
# one that allows a one-off: `ENVS_HOSTNAME=192.168.1.13 envs.sh preview up 7`
# for a device with no Tailscale, say. Sourcing the file last would silently
# ignore that — it did, and the first thing it cost was a test of this script
# that quietly ran against the real box instead of the unreachable address it
# was given.
_env_ssh="${ENVS_SSH:-}"
_env_hostname="${ENVS_HOSTNAME:-}"
_env_root="${ENVS_ROOT:-}"
# shellcheck source=/dev/null
[ -f "$REPO_ROOT/scripts/envs.local" ] && . "$REPO_ROOT/scripts/envs.local"

SSH_TARGET="${_env_ssh:-${ENVS_SSH:-}}"
PUBLIC_HOST="${_env_hostname:-${ENVS_HOSTNAME:-}}"
ROOT="${_env_root:-${ENVS_ROOT:-loxaic-envs}}"
BARE="$ROOT/repo.git"

die() { printf '%s\n' "$*" >&2; exit 1; }

[ -n "$SSH_TARGET" ] || die "set ENVS_SSH in scripts/envs.local (see the header of this script)"
[ -n "$PUBLIC_HOST" ] || die "set ENVS_HOSTNAME in scripts/envs.local (see the header of this script)"

on_host() { ssh -o BatchMode=yes "$SSH_TARGET" "$@"; }

# Fixed per slot rather than derived from the pull request number, which is
# the whole point: the Expo Go link is typed into a phone by hand, so it has
# to be the same one every time.
slot_ports() {
  case "$1" in
    preview) SERVER_PORT=42000; METRO_PORT=42001 ;;
    dev)     SERVER_PORT=43000; METRO_PORT=43001 ;;
    *) die "unknown slot: $1 (expected preview or dev)" ;;
  esac
}

# One-time host setup, idempotent so every deploy can just call it rather than
# making you remember whether you have run it.
bootstrap() {
  on_host "set -e
    command -v docker >/dev/null || {
      echo 'docker is not installed on this host — see docs/ENVIRONMENTS.md' >&2
      exit 1
    }
    # Ubuntu Server and the Debian cloud images do not ship git, and without it
    # the failure is a bare "git: command not found" from the middle of a
    # multi-line remote command — or, worse, a push that fails for want of
    # git-receive-pack after the bare repo appears to exist.
    command -v git >/dev/null || {
      echo 'git is not installed on this host — see docs/ENVIRONMENTS.md' >&2
      exit 1
    }
    docker version >/dev/null 2>&1 || {
      echo 'cannot reach the docker daemon as this user — after usermod -aG docker you need a fresh login' >&2
      exit 1
    }
    mkdir -p \"\$HOME/$ROOT\"
    [ -d \"\$HOME/$BARE\" ] || git init --quiet --bare \"\$HOME/$BARE\""
}

# Prints the slot's state file, or nothing when the slot is empty. Exits
# non-zero when the *question* could not be asked — a dropped connection, sshd
# throttling, a permissions problem — which callers have to tell apart from an
# empty answer, because "I do not know what is deployed" and "nothing is
# deployed" lead to opposite decisions about someone's database.
slot_state() {
  local out
  out="$(on_host "cat \"\$HOME/$ROOT/$1.state\" 2>/dev/null; exit 0")" || return 1
  printf '%s' "$out"
}

slot_running() {
  on_host "docker compose -p '$1' ps --status running --quiet 2>/dev/null" | grep -q . && return 0
  return 1
}

# Shared by both slots. The only differences between a preview and the dev
# stack are which commit is deployed, whether the database survives, and
# whether inference is mocked — everything else is identical, so it lives
# here once.
deploy_slot() {
  local slot="$1" sha="$2" label="$3" wipe="$4"
  slot_ports "$slot"
  bootstrap

  # Read from envs.local rather than hand-edited into the slot's env file:
  # deploy_slot rewrites that file from a fixed heredoc on every deploy, so a
  # hand-added key was erased by the very redeploy the docs told you to run.
  local sandbox
  if [ "$slot" = "preview" ]; then sandbox="${PREVIEW_SANDBOX_MODE:-off}"
  else sandbox="${DEV_SANDBOX_MODE:-off}"; fi

  local mock="true" inference=""
  if [ "$slot" = "dev" ]; then
    if [ -n "${DEV_INFERENCE_URL:-}" ]; then
      mock="false"; inference="$DEV_INFERENCE_URL"
    else
      echo "→ DEV_INFERENCE_URL is unset, so the dev slot falls back to mock inference"
    fi
  fi

  echo "→ pushing ${sha:0:8} to $SSH_TARGET"
  git push --quiet --force "$SSH_TARGET:$BARE" "$sha:refs/envs/$slot"

  if [ "$wipe" = "wipe" ]; then
    echo "→ the slot held something else: dropping its database first"
    compose_down "$slot" "-v"
  fi

  echo "→ checking out"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    bare=\"\$HOME/$BARE\"
    dir=\"\$root/$slot\"

    if [ -e \"\$dir/.git\" ]; then
      git -C \"\$dir\" checkout --quiet --force --detach 'refs/envs/$slot'
      # Anything an earlier commit left behind would otherwise ride into the
      # build context and make the image disagree with the ref it claims.
      git -C \"\$dir\" clean -xdfq
    else
      rm -rf \"\$dir\"
      git -C \"\$bare\" worktree prune
      git -C \"\$bare\" worktree add --quiet --detach \"\$dir\" 'refs/envs/$slot'
    fi
    mkdir -p \"\$dir/infra/envs\""

  # The slot's own configuration comes from *this* checkout, never from the
  # commit being deployed. Two reasons, and the second is the important one:
  # a pull request opened before this tooling existed has no compose.yml at
  # all and would be undeployable, and one that did carry a compose.yml could
  # rewrite the terms it runs under — mounting the Docker socket, say. The
  # commit supplies the build context and nothing else. Sent after `clean`,
  # which would otherwise remove the untracked copies.
  # From HEAD rather than the working tree. The property wanted is "config
  # comes from the workstation, never from the commit being deployed", and
  # reading the checkout's files coupled that to whatever is open in an editor:
  # the timer fires `sync` from the same checkout, so a half-finished edit to
  # compose.yml — a new `${SLOT_FOO:?}` with nothing writing it, say — would be
  # tarred onto the dev slot and fail `docker compose up` *after* the slot had
  # been recreated, taking the standing stack down for a change nobody
  # committed.
  git -C "$REPO_ROOT" archive HEAD infra/envs/compose.yml infra/docker/metro.Dockerfile \
    | on_host "tar -xf - -C \"\$HOME/$ROOT/$slot\""

  echo "→ building ($label)"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    dir=\"\$root/$slot\"

    # Minted once per slot and kept, so a redeploy does not sign you out of
    # the environment mid-test.
    secret_file=\"\$root/$slot.secret\"
    if [ ! -f \"\$secret_file\" ]; then
      openssl rand -hex 32 > \"\$secret_file\"
      chmod 600 \"\$secret_file\"
    fi

    # Outside the worktree, deliberately. server.Dockerfile does \`COPY . .\`
    # and .dockerignore does not exclude .env, so an env file inside the build
    # context would bake this slot's auth secret into an image layer — and
    # would bust the COPY cache on every config change, turning a short
    # redeploy into a full workspace reinstall.
    cat > \"\$root/$slot.env\" <<EOF
SLOT_SERVER_PORT=$SERVER_PORT
SLOT_METRO_PORT=$METRO_PORT
SLOT_HOSTNAME=$PUBLIC_HOST
SLOT_BASE_URL=http://$PUBLIC_HOST:$SERVER_PORT
SLOT_METRO_URL=http://$PUBLIC_HOST:$METRO_PORT
SLOT_VERSION=$label
SLOT_MOCK_INFERENCE=$mock
SLOT_INFERENCE_URL=$inference
SLOT_SANDBOX_MODE=$sandbox
SLOT_AUTH_SECRET=\$(cat \"\$secret_file\")
EOF
    chmod 600 \"\$root/$slot.env\"

    cd \"\$dir\"
    docker compose -p '$slot' -f infra/envs/compose.yml --env-file \"\$root/$slot.env\" up -d --build"

  # `docker compose up -d` returning 0 proves the images built and the
  # containers were created, and nothing more. A migration that fails or a
  # server that throws at boot builds perfectly, starts, exits, and — being
  # `unless-stopped` — crash-loops, while this printed both URLs and `list`
  # reported the slot running because metro was. Ask the server itself.
  if wait_for_health "$SERVER_PORT"; then
    cat <<EOF

$label is up on the $slot slot.

  Web / API   http://$PUBLIC_HOST:$SERVER_PORT
  Expo Go     exp://$PUBLIC_HOST:$METRO_PORT

EOF
  else
    cat >&2 <<EOF

$label was built and started on the $slot slot, but its server never answered
/health. The containers are still up so the logs are readable:

  ./scripts/envs.sh $slot logs server

EOF
    return 1
  fi
}

# Polls from the box itself rather than from here: the workstation may not be
# on the tailnet, and this is a question about the container, not about the
# route to it.
wait_for_health() {
  local port="$1"
  on_host "for _ in \$(seq 1 60); do
      if curl -fsS -m 3 \"http://localhost:$port/health\" >/dev/null 2>&1; then exit 0; fi
      sleep 2
    done
    exit 1"
}

compose_down() {
  local slot="$1" volumes="${2:-}"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    dir=\"\$root/$slot\"
    if [ -e \"\$dir/infra/envs/compose.yml\" ] && [ -f \"\$root/$slot.env\" ]; then
      cd \"\$dir\"
      docker compose -p '$slot' -f infra/envs/compose.yml --env-file \"\$root/$slot.env\" down $volumes --remove-orphans || true
    else
      docker compose -p '$slot' down $volumes --remove-orphans 2>/dev/null || true
    fi"
}

preview_up() {
  local pr="${1:-}"
  [[ "$pr" =~ ^[0-9]+$ ]] || die "usage: $0 preview up <pr-number>"

  local sha
  sha="$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" \
    || die "could not read PR $pr from GitHub"
  git fetch --quiet origin "refs/pull/$pr/head" || die "could not fetch PR $pr"

  # A different pull request means a different schema: its migrations must not
  # be applied on top of the last one's database. The same pull request keeps
  # its volumes, so a redeploy leaves you signed in and your test data intact.
  #
  # Refusing when the state cannot be read is the whole point of the exit-code
  # split above: a failed ssh used to be indistinguishable from an empty slot,
  # which chose "keep" — and the very next call, a fresh connection that
  # succeeds, would then bring this PR up on the *other* PR's Postgres volume
  # and run its migrations there. Silently, and exactly the mixed-schema case
  # the paragraph above says must never happen.
  local state wipe="keep" previous
  state="$(slot_state preview)" \
    || die "could not read the preview slot's state from $SSH_TARGET — not deploying, because what is already there decides whether its database is dropped"
  previous="$(printf '%s' "$state" | sed -n 's/^pr=\([0-9]*\).*/\1/p')"
  [ -n "$previous" ] && [ "$previous" != "$pr" ] && wipe="wipe"

  deploy_slot preview "$sha" "pr-$pr@${sha:0:7}" "$wipe"
  on_host "printf 'pr=%s sha=%s\n' '$pr' '$sha' > \"\$HOME/$ROOT/preview.state\""

  cat <<EOF
In Expo Go, enter that exp:// URL by hand — its scanner wants a QR code, which
this script has no way to put in front of your phone. The link is the same for
every pull request, so once it is in Expo Go's recents it stays there.
EOF
}

preview_sync() {
  local slot_out pr
  slot_out="$(slot_state preview)" || {
    echo "preview: could not reach $SSH_TARGET — leaving the slot alone"
    return 0
  }
  pr="$(printf '%s' "$slot_out" | sed -n 's/^pr=\([0-9]*\).*/\1/p')"
  if [ -z "$pr" ]; then
    echo "preview: nothing deployed"
    return 0
  fi

  # Only a definite CLOSED or MERGED destroys anything. This runs unattended
  # every five minutes, and every other outcome — a GitHub outage, an expired
  # token, a laptop between wifi networks, a rate limit — used to collapse into
  # "not OPEN" and take the slot down with `-v`, dropping the database and
  # uploads of a pull request someone was in the middle of reviewing.
  local state
  if ! state="$(gh pr view "$pr" --json state --jq .state 2>/dev/null)"; then
    echo "preview: could not ask GitHub about PR $pr — leaving the slot alone"
    return 0
  fi
  case "$state" in
    CLOSED|MERGED) echo "preview: PR $pr is $state — tearing it down" ;;
    *) echo "preview: PR $pr is $state"; return 0 ;;
  esac
  preview_down
}

preview_down() {
  echo "→ destroying the preview slot"
  compose_down preview "-v"
  on_host "set -e
    root=\"\$HOME/$ROOT\"
    git -C \"\$HOME/$BARE\" worktree remove --force \"\$root/preview\" 2>/dev/null || rm -rf \"\$root/preview\"
    git -C \"\$HOME/$BARE\" update-ref -d 'refs/envs/preview' 2>/dev/null || true
    rm -f \"\$root/preview.secret\" \"\$root/preview.env\" \"\$root/preview.state\""
}

dev_up() {
  git fetch --quiet origin dev || die "could not fetch origin/dev"
  local sha
  sha="$(git rev-parse origin/dev)"

  # A no-op when the slot already holds this commit *and* is actually running:
  # the timer calls this every few minutes, and rebuilding an unchanged trunk
  # would keep the box busy for nothing.
  # An unreadable state here is safe to ignore: the worst case is a redeploy
  # of the commit that is already there, which is idempotent. That is the
  # opposite of the preview slot, where the same uncertainty decides whether a
  # database is dropped.
  local deployed
  deployed="$(slot_state dev 2>/dev/null | sed -n 's/^sha=\(.*\)/\1/p' || true)"
  if [ "$deployed" = "$sha" ] && slot_running dev; then
    echo "dev: already at ${sha:0:7}"
    return 0
  fi

  # Volumes are kept: the dev database is long-lived test data, and migrations
  # are forward-only, so moving the trunk forward is not a reason to drop it.
  deploy_slot dev "$sha" "dev@${sha:0:7}" "keep"
  on_host "printf 'sha=%s\n' '$sha' > \"\$HOME/$ROOT/dev.state\""
}

dev_down() {
  local volumes=""
  if [ "${1:-}" = "--volumes" ]; then
    volumes="-v"
  fi
  echo "→ stopping the dev slot${volumes:+ and dropping its database}"
  compose_down dev "$volumes"
  [ -n "$volumes" ] && on_host "rm -f \"\$HOME/$ROOT/dev.state\""
  return 0
}

list() {
  local preview_state dev_state
  preview_state="$(slot_state preview)"
  dev_state="$(slot_state dev)"
  echo "on $SSH_TARGET:"
  for slot in preview dev; do
    slot_ports "$slot"
    local state status
    state="$([ "$slot" = preview ] && echo "$preview_state" || echo "$dev_state")"
    if [ -z "$state" ]; then
      printf '  %-8s (nothing deployed)\n' "$slot"
      continue
    fi
    status="$(slot_running "$slot" && echo running || echo stopped)"
    printf '  %-8s %-28s %-8s http://%s:%s   exp://%s:%s\n' \
      "$slot" "$state" "$status" "$PUBLIC_HOST" "$SERVER_PORT" "$PUBLIC_HOST" "$METRO_PORT"
  done
}

logs() {
  local slot="$1"; shift
  on_host -t "cd \"\$HOME/$ROOT/$slot\" && docker compose -p '$slot' -f infra/envs/compose.yml --env-file \"\$HOME/$ROOT/$slot.env\" logs -f ${*:-}"
}

case "${1:-}" in
  preview)
    case "${2:-}" in
      up)   preview_up "${3:-}" ;;
      down) preview_down ;;
      sync) preview_sync ;;
      logs) shift 2; logs preview "$@" ;;
      *) die "usage: $0 preview {up <pr>|down|sync|logs}" ;;
    esac ;;
  dev)
    case "${2:-}" in
      up)   dev_up ;;
      down) dev_down "${3:-}" ;;
      logs) shift 2; logs dev "$@" ;;
      *) die "usage: $0 dev {up|down [--volumes]|logs}" ;;
    esac ;;
  list) list ;;
  # What the timer runs: retire a preview whose pull request has closed, and
  # keep the dev slot level with the trunk.
  sync) preview_sync; dev_up ;;
  *) die "usage: $0 {preview|dev} <command> | $0 {list|sync}" ;;
esac
