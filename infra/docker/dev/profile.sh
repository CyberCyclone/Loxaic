# shellcheck shell=sh
# loxaic-dev (#320): the test toolchain on PATH in a login shell, which is how
# an agent's bash commands run. The image's ENV sets the same for other execs.
export PATH="/usr/lib/postgresql/17/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:$PATH"
# A reminder for the agent, shown once per login shell that is interactive.
case $- in
  *i*) echo "loxaic-dev: run Loxaic's tests with loxaic-test (loxaic-test help)." ;;
esac
