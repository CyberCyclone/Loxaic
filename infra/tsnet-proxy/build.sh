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
)

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
