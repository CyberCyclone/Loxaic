#!/usr/bin/env bash
# The dev image's own test (#320): run inside a built image under the
# restrictions Loxaic gives every sandbox — CI does this before pushing:
#
#   docker run --rm --cap-drop ALL --security-opt no-new-privileges --network none \
#     --shm-size 64m -v "$PWD/infra/docker/dev/selftest.sh:/selftest.sh:ro" \
#     loxaic-dev:local bash /selftest.sh
#
# Each check prints one line and the script stops at the first that fails.
set -euo pipefail

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# Loxaic's tools need these, and the custom-image check refuses an image
# without them (apps/server/src/images/check.ts); inherited from the sandbox image.
for tool in bash tail setsid git gh rg; do
  command -v "$tool" >/dev/null || fail "missing $tool"
done
setsid -w true || fail "setsid -w"
pass "Loxaic's own tools are here"

[ "$(id -u)" = "1001" ] || fail "runs as uid $(id -u), not loxaic (1001)"
pass "runs as loxaic"

loxaic-test pg >/dev/null || fail "loxaic-test pg"
answer="$(psql -h localhost -U postgres -tAc 'select 1' loxaic)"
[ "$answer" = "1" ] || fail "Postgres answered '$answer'"
loxaic-test pg >/dev/null || fail "loxaic-test pg, run twice"
pass "Postgres starts as loxaic, and starting it again is harmless"

chrome="$("$CHROME_BIN" --version)"
driver="$("$CHROMEDRIVER_BIN" --version)"
chrome_build="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' <<<"$chrome")"
driver_build="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' <<<"$driver" | head -n 1)"
if [ -z "$chrome_build" ] || [ "$chrome_build" != "$driver_build" ]; then
  fail "Chrome $chrome_build, chromedriver $driver_build"
fi
page="$("$CHROME_BIN" --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --dump-dom 'data:text/html,<p>rendered</p>' 2>/dev/null)"
grep -q 'rendered' <<<"$page" || fail "headless Chrome did not render a page"
pass "Chrome and chromedriver are build $chrome_build, and Chrome renders headless"

xvfb-run -a true || fail "xvfb-run"
pass "Xvfb runs"

installed="$(sdkmanager --list_installed 2>&1)" || fail "sdkmanager --list_installed: $installed"
for pkg in "platform-tools" "emulator" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1" \
  "system-images;android-35;google_apis;x86_64"; do
  grep -qF "$pkg" <<<"$installed" || fail "Android SDK lacks $pkg"
done
avds="$(avdmanager list avd 2>&1)" || fail "avdmanager list avd: $avds"
grep -q 'Name: loxaic' <<<"$avds" || fail "no loxaic AVD"
java -version >/dev/null 2>&1 || fail "no JDK"
pass "the Android SDK, the loxaic AVD and a JDK are here"

# The detached runner: a lane outlives the call that started it, a second is
# refused while it runs, and wait reports how it ended.
id="$(loxaic-test start shell -- bash -c 'echo started; sleep 3; echo finished')"
refusal="$(loxaic-test start shell -- true 2>&1 || true)"
grep -q 'one lane at a time' <<<"$refusal" || fail "a second lane was not refused: $refusal"
result="$(loxaic-test wait "$id" --seconds 30)"
grep -q 'finished' <<<"$result" || fail "wait did not print the lane's output"
grep -q 'status: passed (exit 0)' <<<"$result" || fail "wait did not report a pass: $result"
failing="$(loxaic-test start shell -- bash -c 'exit 7')"
result="$(loxaic-test wait "$failing" --seconds 30)"
grep -q 'status: failed (exit 7)' <<<"$result" || fail "wait did not report the exit code: $result"
pass "lanes run detached, one at a time, and report how they ended"

# Without /dev/kvm the Android lane says what is missing and who can fix it.
mkdir -p /tmp/fake-repo && echo '{}' >/tmp/fake-repo/package.json
android="$(LOXAIC_REPO=/tmp/fake-repo loxaic-test start android)"
result="$(loxaic-test wait "$android" --seconds 30)"
grep -q 'no usable /dev/kvm' <<<"$result" || fail "the Android lane did not explain the missing KVM: $result"
grep -q 'status: failed' <<<"$result" || fail "the Android lane did not fail without KVM"
pass "the Android lane explains a missing /dev/kvm"

echo "selftest passed"
