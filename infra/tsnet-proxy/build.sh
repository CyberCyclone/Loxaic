#!/usr/bin/env bash
# Cross-compiles the tsnet-proxy sidecar for every OS/arch Electron ships on
# (electron-builder's mac/win/linux targets) and writes them into the given
# output directory, named so apps/desktop/src/main.js's getTsnetProxyPath()
# can find them by process.platform/process.arch at runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve to an absolute path *before* cd-ing into SCRIPT_DIR below — a
# relative $1 (the normal case: callers pass "resources/tsnet-proxy" from
# apps/desktop) must stay anchored to the caller's cwd, not this script's.
RAW_OUT_DIR="${1:-$SCRIPT_DIR/../../apps/desktop/resources/tsnet-proxy}"
mkdir -p "$RAW_OUT_DIR"
OUT_DIR="$(cd "$RAW_OUT_DIR" && pwd)"
cd "$SCRIPT_DIR"

# GOOS/GOARCH pairs, mapped to Electron's process.platform/process.arch naming.
TARGETS=(
  "darwin arm64 darwin arm64"
  "darwin amd64 darwin x64"
  "windows amd64 win32 x64"
  "linux amd64 linux x64"
  "linux arm64 linux arm64"
)

# Each of these binaries is ~30MB, and a release only ever runs on the platform
# it was built for — so a CI job packaging one platform ships one sidecar
# rather than four, where the other three would be dead weight inside the
# bundle (and, on macOS, three more foreign binaries for codesign to walk).
# Local builds keep cross-compiling everything: that is what makes a
# `pnpm package` on this machine able to produce any target.
if [ "${TSNET_PROXY_HOST_ONLY:-}" = "1" ]; then
  case "$(uname -s)" in
    Darwin) host_platform="darwin" ;;
    Linux) host_platform="linux" ;;
    MINGW*|MSYS*|CYGWIN*) host_platform="win32" ;;
    *) echo "TSNET_PROXY_HOST_ONLY=1 but $(uname -s) is not a platform this ships to" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) host_arch="arm64" ;;
    x86_64|amd64) host_arch="x64" ;;
    *) echo "TSNET_PROXY_HOST_ONLY=1 but $(uname -m) is not an architecture this ships to" >&2; exit 1 ;;
  esac
  echo "TSNET_PROXY_HOST_ONLY=1: building only ${host_platform}/${host_arch}"
  filtered=()
  for entry in "${TARGETS[@]}"; do
    read -r _ _ platform arch <<< "$entry"
    [ "$platform" = "$host_platform" ] && [ "$arch" = "$host_arch" ] && filtered+=("$entry")
  done
  if [ ${#filtered[@]} -eq 0 ]; then
    echo "no target matches ${host_platform}/${host_arch}" >&2
    exit 1
  fi
  TARGETS=("${filtered[@]}")
fi

for entry in "${TARGETS[@]}"; do
  read -r goos goarch platform arch <<< "$entry"
  ext=""
  [ "$platform" = "win32" ] && ext=".exe"
  out="$OUT_DIR/tsnet-proxy-${platform}-${arch}${ext}"
  echo "building $out (GOOS=$goos GOARCH=$goarch)"
  GOOS="$goos" GOARCH="$goarch" go build -o "$out" .
done

echo "done: $OUT_DIR"
ls -la "$OUT_DIR"
