#!/bin/sh
# Entrypoint for the llama.cpp sidecar in Docker Compose (LLAMA_MODE=attach).
#
# The Loxaic server owns the models directory and the preset file: it downloads
# GGUFs into the shared volume and writes models.ini, and asks this router to
# re-read it (GET /models?reload=1) whenever an admin enables a model or
# changes its settings. This script only starts llama-server in router mode
# against that file, once it exists.
#
# It also records what `--list-devices` finds, into the shared volume, so the
# admin screen can say when this container sees no GPU at all — models would
# then run on the CPU, and that must never happen without saying so.
set -eu

DIR="${LLAMA_DIR:-/data/llama}"
PRESET="$DIR/models.ini"
KEYFILE="$DIR/router.key"
BIN="${LLAMA_SERVER_BIN:-/app/llama-server}"

"$BIN" --list-devices > "$DIR/router-devices.txt" 2>&1 || true

# The router never runs unauthenticated: llama.cpp allows every CORS origin,
# so without a key any page in the operator's browser could unload models or
# reload the list. The server mints the key into the shared volume (0600)
# unless LLAMA_API_KEY is set for both processes.
while [ ! -f "$PRESET" ] || { [ -z "${LLAMA_API_KEY:-}" ] && [ ! -s "$KEYFILE" ]; }; do
  echo "llama-router: waiting for $PRESET and $KEYFILE (the Loxaic server writes them when it starts)"
  sleep 2
done
if [ -z "${LLAMA_API_KEY:-}" ]; then
  LLAMA_API_KEY="$(tr -d '[:space:]' < "$KEYFILE")"
  export LLAMA_API_KEY
fi

exec "$BIN" \
  --host 0.0.0.0 \
  --port 8080 \
  --models-preset "$PRESET" \
  --models-max "${LLAMA_MODELS_MAX:-1}" \
  "$@"
