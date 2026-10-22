#!/usr/bin/env bash
# loxaic-test (#320): runs Loxaic's own test lanes inside a Loxaic sandbox.
#
# A lane outlives the agent's 60-second tool call by running detached: `start`
# returns at once with an id, and `wait` prints what the lane has written
# since the last look, returning when it ends or after --seconds. One lane at
# a time — they share Postgres, port 4055 and the emulator, as on a laptop.
set -uo pipefail

STATE="${LOXAIC_TEST_HOME:-$HOME/.loxaic-test}"
REPO="${LOXAIC_REPO:-$HOME/repo}"
PGDATA="${LOXAIC_PG_DATA:-$HOME/.local/share/loxaic-pg}"
PGBIN="${LOXAIC_PG_BIN:-/usr/lib/postgresql/17/bin}"
BROWSERS="$HOME/.cache/loxaic-e2e/browsers"
E2E_PORT="${E2E_PORT:-4055}"
export E2E_PORT
# Each lane's log, pid, exit code and read offset, named by its id.
LANES="$STATE/lanes"
mkdir -p "$LANES"

usage() {
  cat <<'USAGE'
loxaic-test: run Loxaic's tests in this sandbox.

  loxaic-test start <lane> [-- args]   start a lane in the background; prints its id
  loxaic-test wait [id] [--seconds N]  print new output; return when it ends or after N s (default 50)
  loxaic-test status                   recent lanes and how they ended
  loxaic-test stop [id]                stop a running lane
  loxaic-test pg                       start Postgres (every lane does this itself)

Lanes (from the checkout in $LOXAIC_REPO, default ~/repo):
  install     pnpm install, Electron's binary, and web_fetch's Chromium (needs the network)
  server      apps/server vitest              mobile, desktop   their vitest suites
  lint        pnpm lint                       typecheck         pnpm typecheck
  web         the web e2e lane                electron          the Electron e2e lane
  android     the Android e2e lane (needs KVM: an admin turns it on for this image)
  shell       any command:  loxaic-test start shell -- <command...>

Arguments after -- go to the lane: vitest file paths, or `--spec ./src/specs/x.spec.ts` for wdio.
Set LOXAIC_TEST_REBUILD=1 to rebuild the Electron package or the Android APK.
USAGE
}

die() {
  echo "loxaic-test: $*" >&2
  exit 1
}

# The sandbox's egress proxy settings (apps/server/src/egress/env.ts), dropped
# for a test run: everything a test touches is on this machine, and a proxy
# in the environment would be handed to every browser and server the run
# starts. Lanes that download keep them.
without_egress() {
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u NO_PROXY -u no_proxy \
    -u SSL_CERT_FILE -u GIT_SSL_CAINFO -u CURL_CA_BUNDLE -u REQUESTS_CA_BUNDLE -u NODE_EXTRA_CA_CERTS \
    -u GH_TOKEN "$@"
}

pg_start() {
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$(dirname "$PGDATA")"
    "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >"$STATE/initdb.log" 2>&1 || die "initdb failed: see $STATE/initdb.log"
  fi
  if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    # A paused sandbox loses its processes but keeps postmaster.pid; pg_ctl
    # starts over a stale one once the process it names is gone.
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$STATE/postgres.log" -w \
      -o "-k /tmp -c listen_addresses=localhost -p 5432" start >/dev/null || die "Postgres did not start: see $STATE/postgres.log"
  fi
  local exists
  exists="$("$PGBIN/psql" -h localhost -U postgres -tAc "select 1 from pg_database where datname = 'loxaic'" postgres)" || die "Postgres is not answering"
  if [ "$exists" != "1" ]; then
    "$PGBIN/createdb" -h localhost -U postgres loxaic || die "could not create the loxaic database"
  fi
}

migrate() {
  (cd "$REPO" && pnpm --filter @loxaic/db db:migrate)
}

in_repo() {
  [ -f "$REPO/package.json" ] || die "no checkout at $REPO (set LOXAIC_REPO)"
  cd "$REPO" || exit 1
}

# An e2e lane starts its own server on E2E_PORT and refuses one already
# there; a server a stopped lane left behind would otherwise fail every spec.
port_free() {
  local holder
  holder="$(lsof -nP -iTCP:"$E2E_PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2)"
  [ -z "$holder" ] && return 0
  die "port $E2E_PORT is already in use, so the lane can't start its own server:
$holder
A server left by an earlier run? Stop it (kill <PID>) and start the lane again."
}

kvm_ready() {
  [ -c /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]
}

emulator_up() {
  local booted
  booted="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  [ "$booted" = "1" ]
}

boot_emulator() {
  emulator_up && return 0
  echo "booting the emulator (a few minutes the first time)"
  setsid nohup emulator -avd loxaic -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot-save \
    >"$STATE/emulator.log" 2>&1 </dev/null &
  local deadline=$((SECONDS + 600))
  until emulator_up; do
    [ $SECONDS -lt $deadline ] || die "the emulator did not finish booting in 10 minutes: see $STATE/emulator.log"
    sleep 5
  done
  adb shell settings put global window_animation_scale 0 >/dev/null 2>&1 || true
  adb shell settings put global transition_animation_scale 0 >/dev/null 2>&1 || true
  adb shell settings put global animator_duration_scale 0 >/dev/null 2>&1 || true
}

# Runs one lane in the foreground. Called detached, by `start`.
run_lane() {
  local lane="$1"
  shift
  case "$lane" in
    install)
      in_repo
      pnpm install --frozen-lockfile || return $?
      # pnpm skips Electron's install script; the Electron lane needs its binary.
      node apps/desktop/node_modules/electron/install.js || return $?
      PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" node apps/server/node_modules/playwright-core/cli.js install chromium-headless-shell
      ;;
    server)
      in_repo
      pg_start && migrate || return $?
      # BROWSER_NO_SANDBOX: Chromium's own sandbox needs user namespaces this
      # sandbox does not grant, and the sandbox is the boundary here
      # (apps/server/src/browser/AGENTS.md allows exactly this case).
      cd apps/server && without_egress env MOCK_INFERENCE=true \
        BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-loxaic-test-secret-not-for-production}" \
        BROWSER_DIR="$BROWSERS" BROWSER_NO_SANDBOX=1 npx vitest run "$@"
      ;;
    mobile | desktop)
      in_repo
      cd "apps/$lane" && without_egress npx vitest run "$@"
      ;;
    lint)
      in_repo
      without_egress pnpm lint
      ;;
    typecheck)
      in_repo
      without_egress pnpm typecheck
      ;;
    web)
      in_repo
      pg_start || return $?
      port_free
      cd apps/e2e && without_egress env E2E_FRESH_WEB="${E2E_FRESH_WEB:-1}" npx wdio run ./wdio.web.ts "$@"
      ;;
    electron)
      in_repo
      pg_start || return $?
      port_free
      if [ ! -d apps/desktop/dist/linux-unpacked ] || [ "${LOXAIC_TEST_REBUILD:-}" = "1" ]; then
        pnpm --filter @loxaic/desktop package:dir || return $?
      fi
      # package:dir rewrote the web export; the lane serves the packaged app's own.
      cd apps/e2e && without_egress xvfb-run -a npx wdio run ./wdio.electron.ts "$@"
      ;;
    android)
      in_repo
      kvm_ready || die "this sandbox has no usable /dev/kvm, which the Android emulator needs. An admin turns on \
Hardware virtualisation (KVM) for this image in Settings → Container Images, on a host that has KVM."
      pg_start || return $?
      port_free
      boot_emulator || return $?
      local apk=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
      if [ ! -f "$apk" ] || [ "${LOXAIC_TEST_REBUILD:-}" = "1" ]; then
        (cd apps/mobile && pnpm prebuild:android) || return $?
        # The API address is baked into the bundle: the emulator reaches this
        # machine's port as 10.0.2.2 (apps/e2e/README.md, Android).
        (cd apps/mobile/android && rm -rf app/build/generated/assets &&
          EXPO_PUBLIC_API_URL="http://10.0.2.2:$E2E_PORT" ./gradlew assembleRelease) || return $?
      fi
      if [ ! -d apps/e2e/.appium ]; then
        (cd apps/e2e && APPIUM_HOME=./.appium npx appium driver install uiautomator2) || return $?
      fi
      cd apps/e2e && without_egress npx wdio run ./wdio.android.ts "$@"
      ;;
    shell)
      [ $# -gt 0 ] || die "shell needs a command: loxaic-test start shell -- <command...>"
      "$@"
      ;;
    *)
      die "no lane '$lane' (loxaic-test help)"
      ;;
  esac
}

current_id() {
  [ -f "$STATE/current" ] || return 1
  local id
  id="$(cat "$STATE/current")"
  [ -f "$LANES/$id.pid" ] && kill -0 "$(cat "$LANES/$id.pid")" 2>/dev/null || return 1
  echo "$id"
}

latest_id() {
  local newest
  # Lane ids are made here (a timestamp and a lane name), so ls is safe.
  # shellcheck disable=SC2012
  newest="$(ls -1t "$LANES"/*.log 2>/dev/null | head -n 1)"
  [ -n "$newest" ] || return 1
  basename "$newest" .log
}

status_of() {
  local id="$1"
  if [ -f "$LANES/$id.exit" ]; then
    local code
    code="$(cat "$LANES/$id.exit")"
    if [ "$code" = "0" ]; then echo "passed (exit 0)"; else echo "failed (exit $code)"; fi
  elif [ -f "$LANES/$id.pid" ] && kill -0 "$(cat "$LANES/$id.pid")" 2>/dev/null; then
    echo "running"
  else
    echo "ended without a result"
  fi
}

cmd_start() {
  [ $# -ge 1 ] || die "start needs a lane (loxaic-test help)"
  local lane="$1"
  shift
  [ "${1:-}" = "--" ] && shift
  local running
  if running="$(current_id)"; then
    die "$running is still running; one lane at a time (loxaic-test wait $running, or loxaic-test stop $running)"
  fi
  local id
  id="$(date +%Y%m%d-%H%M%S)-$lane"
  echo "$id" >"$STATE/current"
  # setsid: its own process group, so `stop` can end all of it, and so the
  # tool call that started it can return without taking it down.
  setsid nohup "$0" __run "$id" "$lane" "$@" >"$LANES/$id.log" 2>&1 </dev/null &
  echo $! >"$LANES/$id.pid"
  echo "$id"
}

cmd_run() {
  local id="$1" lane="$2"
  shift 2
  echo "== $lane started $(date -u +%FT%TZ)"
  # A subshell, so a lane that dies (die exits) still has its exit recorded.
  (run_lane "$lane" "$@")
  local code=$?
  echo "== $lane ended $(date -u +%FT%TZ), exit $code"
  echo "$code" >"$LANES/$id.exit"
  exit "$code"
}

cmd_wait() {
  local id="" seconds=50
  while [ $# -gt 0 ]; do
    case "$1" in
      --seconds) seconds="${2:-50}"; shift 2 ;;
      *) id="$1"; shift ;;
    esac
  done
  [ -n "$id" ] || id="$(current_id || latest_id)" || die "no lane has run yet"
  [ -f "$LANES/$id.log" ] || die "no lane $id"
  local offset_file="$LANES/$id.offset" deadline=$((SECONDS + seconds))
  local offset
  offset="$(cat "$offset_file" 2>/dev/null || echo 0)"
  while :; do
    local size
    size="$(wc -c <"$LANES/$id.log" | tr -d ' ')"
    if [ "$size" -gt "$offset" ]; then
      tail -c +"$((offset + 1))" "$LANES/$id.log" | head -c "$((size - offset))"
      offset="$size"
      echo "$offset" >"$offset_file"
    fi
    local state
    state="$(status_of "$id")"
    if [ "$state" != "running" ] || [ $SECONDS -ge $deadline ]; then
      echo
      echo "status: $state ($id)"
      return 0
    fi
    sleep 2
  done
}

cmd_status() {
  local any=0 log id
  # shellcheck disable=SC2012
  for log in $(ls -1t "$LANES"/*.log 2>/dev/null | head -n 10); do
    id="$(basename "$log" .log)"
    echo "$id: $(status_of "$id")"
    any=1
  done
  [ $any = 1 ] || echo "no lanes have run yet"
}

cmd_stop() {
  local id="${1:-}"
  [ -n "$id" ] || id="$(current_id)" || die "nothing is running"
  [ -f "$LANES/$id.pid" ] || die "no lane $id"
  local pid
  pid="$(cat "$LANES/$id.pid")"
  kill -TERM -- "-$pid" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-$pid" 2>/dev/null || true
  [ -f "$LANES/$id.exit" ] || echo 143 >"$LANES/$id.exit"
  echo "stopped $id"
}

case "${1:-help}" in
  start) shift; cmd_start "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  status) cmd_status ;;
  stop) shift; cmd_stop "$@" ;;
  pg) pg_start && echo "Postgres is running on localhost:5432 (database loxaic)" ;;
  __run) shift; cmd_run "$@" ;;
  help | -h | --help) usage ;;
  *) usage; exit 1 ;;
esac
