#!/usr/bin/env bash
# A stand-in for the tsnet-proxy sidecar, for the Electron e2e suite: speaks
# the same stdout line protocol without joining a tailnet — which no test
# harness can do, since approving a node needs a real Tailscale account and
# a browser.
#
# Wired in through LOXAIC_TSNET_BIN (apps/desktop/src/main.js honours it with
# a one-time warning, the same way LOXAIC_E2E_PICK_DIR stands in for the
# folder dialog). It plays the whole first-run script: an AUTH_URL first,
# then — as if a person had approved the machine — the address, so a spec can
# assert on both states the GUI has to show.
#
# The hostname decides the outcome, since that is the one thing a spec types
# into the form and the supervisor passes straight through:
#   *-fail-*   exit 1 with the certificate message, like a tailnet with HTTPS off
#   *-slow-*   wait well past the old five-second limit before coming up
#   otherwise  come up after a short pause
set -euo pipefail

mode="client"
hostname="loxaic-desktop"
funnel="false"
auth_stdin="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) mode="$2"; shift 2 ;;
    --hostname) hostname="$2"; shift 2 ;;
    --funnel) funnel="true"; shift ;;
    --auth-key-stdin) auth_stdin="true"; shift ;;
    --target|--upstream|--state-dir|--control-url) shift 2 ;;
    --tls=*) shift ;;
    *) shift ;;
  esac
done

# Report where the auth key arrived, so a spec can assert it was stdin and
# nowhere else. Never printed unless one was actually sent.
if [ "$auth_stdin" = "true" ]; then
  IFS= read -r key || key=""
  in_env="false"
  if [ -n "$key" ] && env | grep -qF -- "$key"; then in_env="true"; fi
  echo "FAKE_AUTH_KEY_SEEN len=${#key} in_env=${in_env}" >&2
fi

echo "tsnet-proxy: [tsnet] tsnet starting with hostname \"$hostname\"" >&2

case "$hostname" in
  *-fail-*)
    echo "tsnet-proxy: [backend] health(warnable=tls-cert): error: certificate not available" >&2
    echo "2026/01/01 00:00:00 tsnet-proxy: listening on the tailnet at :443: no certificate for this node" >&2
    echo "tsnet-proxy: this usually means MagicDNS and HTTPS certificates are not enabled for this tailnet" >&2
    exit 1
    ;;
esac

echo "AUTH_URL https://login.tailscale.com/a/fake0123456789"

case "$hostname" in
  *-slow-*) sleep 7 ;;
  *) sleep 1.5 ;;
esac

if [ "$mode" = "serve" ]; then
  url="https://${hostname}.tail1234.ts.net"
  echo "SERVING $url"
  echo "STATUS {\"mode\":\"serve\",\"hostname\":\"$hostname\",\"ips\":[\"100.101.102.103\"],\"certDomain\":\"${hostname}.tail1234.ts.net\",\"url\":\"$url\",\"funnel\":$funnel}"
else
  # A real client binds an ephemeral loopback port; the fake has no proxy
  # behind it, so it points at whatever the spec wants probed through it.
  port="${FAKE_TSNET_CLIENT_PORT:-1}"
  echo "LISTENING 127.0.0.1:${port}"
  echo "STATUS {\"mode\":\"client\",\"hostname\":\"$hostname\",\"ips\":[\"100.101.102.104\"],\"funnel\":false}"
fi

# Stay up like the real one until told to stop. A foreground one-second
# sleep, not a backgrounded long one: a background child would inherit the
# stdout/stderr pipes and hold them open after this script is killed, which
# leaves whoever spawned it waiting on EOF — a real sidecar has no children.
trap 'exit 0' TERM INT
while true; do sleep 1; done
