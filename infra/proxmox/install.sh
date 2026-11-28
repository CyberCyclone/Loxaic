#!/usr/bin/env bash
# Installs or upgrades Loxaic on a Debian/Ubuntu machine, as a headless host
# under systemd. Written for the Proxmox LXC that create-lxc.sh makes (which
# pushes this file to /usr/local/sbin/loxaic-install), and works on any
# Debian/Ubuntu amd64 box with systemd.
#
#   loxaic-install                    # install, or upgrade to the newest release
#   loxaic-install --channel beta     # Loxaic Beta instead of Loxaic
#   loxaic-install --version 1.2.0    # a specific release (rollback)
#
# The .deb comes from this repository's GitHub releases and is checked against
# the sha512 in the release's own update feed before it is installed. Running
# it again upgrades in place: the data directory is never touched, and the
# server applies its migrations on start.
set -euo pipefail

REPO="${LOXAIC_REPO:-CyberCyclone/Loxaic}"
# Test seam: every absolute path this script reads or writes goes through it.
ROOT="${LOXAIC_TEST_ROOT:-}"
HEALTH_TIMEOUT="${LOXAIC_HEALTH_TIMEOUT:-180}"
GITHUB="https://github.com/${REPO}"
API="https://api.github.com/repos/${REPO}"

CHANNEL=""
VERSION=""
PORT=4100
ADVERTISE_URL=""
HOST_NAME=""
TMP=""

die() { echo "loxaic-install: $*" >&2; exit 1; }
log() { echo "==> $*"; }

usage() {
  cat <<'EOF'
Usage: loxaic-install [options]

Installs Loxaic as a headless host (systemd unit, embedded Postgres, Docker
for agent sandboxes), or upgrades an existing install to the newest release.

  --channel stable|beta  Which app: Loxaic (stable) or Loxaic Beta. Default:
                         the one already installed here, else stable.
  --version <x.y.z>      Install that release instead of the newest.
  --port <n>             Server port (default 4100).
  --advertise-url <url>  Address other machines should use (a reverse proxy
                         or domain), instead of this machine's LAN address.
  --host-name <name>     Name shown against this host's models.
  --help                 Show this help.
EOF
}

# ── Channel facts ────────────────────────────────────────────────────────────
# Each channel is a separate application with its own install directory,
# service and data directory, exactly as on the desktop: two apps on one data
# directory would be two servers on one embedded Postgres.
product_name() { case $1 in stable) echo "Loxaic" ;; beta) echo "Loxaic Beta" ;; esac; }
service_name() { case $1 in stable) echo "loxaic" ;; beta) echo "loxaic-beta" ;; esac; }
feed_name() { case $1 in stable) echo "latest-linux.yml" ;; beta) echo "beta-linux.yml" ;; esac; }
other_channel() { case $1 in stable) echo "beta" ;; beta) echo "stable" ;; esac; }
unit_path() { echo "${ROOT}/etc/systemd/system/$(service_name "$1").service"; }

# The channel already installed here, so a bare `loxaic-install` upgrades it.
installed_channel() {
  if [ -e "$(unit_path beta)" ]; then echo beta
  elif [ -e "$(unit_path stable)" ]; then echo stable
  fi
}

valid_version() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]]; }

# ── Feed parsing ─────────────────────────────────────────────────────────────
# electron-builder's update feed, e.g.
#   version: 1.2.0
#   files:
#     - url: Loxaic-1.2.0-linux-amd64.deb
#       sha512: <base64>
feed_version() {
  awk -v q="'" '/^version:/ { v = $2; gsub(/"/, "", v); gsub(q, "", v); print v; exit }' "$1"
}

# Prints "<file> <sha512>" for the feed's .deb entry.
feed_deb_entry() {
  awk -v q="'" '
    /^  - url: / { url = $3; gsub(/"/, "", url); gsub(q, "", url); want = (url ~ /\.deb$/); next }
    want && /^    sha512: / { print url, $2; exit }
  ' "$1"
}

installed_version() {
  local pkg="${ROOT}/opt/$(product_name "$1")/resources/app/package.json"
  [ -f "$pkg" ] || return 0
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -n 1
}

# Downloads $1 to $2; prints the HTTP status (000 when nothing answered).
fetch() {
  curl -sSL --retry 3 -o "$2" -w '%{http_code}' "$1" 2>/dev/null || true
}

sha512_b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }

# The NVIDIA driver version the host kernel runs, from /proc/driver/nvidia/version:
#   NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.95.05  Release Build ...
nvidia_driver_version() {
  [ -f "$1" ] || return 0
  head -n 1 "$1" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true
}

unit_text() {
  local channel=$1 product service exe dir
  product=$(product_name "$channel")
  service=$(service_name "$channel")
  exe="/opt/${product}/${service}"
  dir="/var/lib/${service}"
  local extra=""
  [ -n "$HOST_NAME" ] && extra+=" \"--host-name=${HOST_NAME}\""
  [ -n "$ADVERTISE_URL" ] && extra+=" --advertise-url=${ADVERTISE_URL}"
  cat <<EOF
# Written by loxaic-install; re-running it rewrites this file.
[Unit]
Description=${product} (headless host)
Documentation=${GITHUB}/blob/dev/docs/DEPLOY.md
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
User=${service}
Group=${service}
StateDirectory=${service}
StateDirectoryMode=0700
Environment=ELECTRON_RUN_AS_NODE=1
Environment=HOME=${dir}
ExecStart="${exe}" "/opt/${product}/resources/app/src/headless.js" --data-dir=${dir} --port=${PORT} --as-host --bind lan${extra}
# headless.js stops the server and Postgres itself on SIGTERM; only it gets the signal.
KillMode=mixed
TimeoutStopSec=60
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

# ── Steps ────────────────────────────────────────────────────────────────────
check_system() {
  [ "$(id -u)" = 0 ] || die "run this as root"
  local os
  os=$(grep -E '^(ID|ID_LIKE)=' "${ROOT}/etc/os-release" 2>/dev/null | grep -E 'debian|ubuntu' || true)
  [ -n "$os" ] || die "this installer supports Debian and Ubuntu only"
  [ "$(dpkg --print-architecture)" = amd64 ] || die "Loxaic publishes Linux builds for amd64 only"
  local other
  other=$(other_channel "$CHANNEL")
  if [ -e "$(unit_path "$other")" ]; then
    die "this machine already runs $(product_name "$other"); install $(product_name "$CHANNEL") in a separate container"
  fi
}

pkg_available() { apt-cache show "$1" >/dev/null 2>&1; }

install_prerequisites() {
  log "Installing prerequisites"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  local pkgs=(ca-certificates curl jq openssl docker.io libgbm1)
  # Electron links against ALSA even when it runs as plain Node, and the
  # .deb does not declare it. Ubuntu 24.04 renamed it for the 64-bit time_t move.
  if pkg_available libasound2t64; then pkgs+=(libasound2t64); else pkgs+=(libasound2); fi
  # llama.cpp's Vulkan build: AMD and Intel GPUs (and NVIDIA without CUDA).
  if [ -d "${ROOT}/dev/dri" ]; then pkgs+=(libvulkan1 mesa-vulkan-drivers); fi
  apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
}

check_docker() {
  log "Checking Docker (agent sandboxes)"
  systemctl enable --now docker >/dev/null
  local out
  if ! out=$(docker run --rm hello-world 2>&1); then
    echo "$out" >&2
    die "Docker cannot run containers here. A host needs it for agent sandboxes and will not start without it. In a Proxmox LXC, check that the container has features nesting=1,keyctl=1."
  fi
}

install_nvidia_userspace() {
  [ -e "${ROOT}/dev/nvidiactl" ] || return 0
  local want have
  want=$(nvidia_driver_version "${ROOT}/proc/driver/nvidia/version")
  [ -n "$want" ] || die "an NVIDIA GPU is passed through, but /proc/driver/nvidia/version gives no driver version"
  have=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 || true)
  if [ "$have" = "$want" ]; then
    log "NVIDIA driver ${want} libraries already installed"
    return 0
  fi
  # The container shares the host's kernel module, so it needs the user-space
  # half of exactly that driver version and no kernel module of its own.
  log "Installing NVIDIA driver ${want} libraries (no kernel module)"
  local run="NVIDIA-Linux-x86_64-${want}.run"
  local url="https://download.nvidia.com/XFree86/Linux-x86_64/${want}/${run}"
  [ "$(fetch "$url" "${TMP}/${run}")" = 200 ] || die "could not download ${url}"
  if [ "$(fetch "${url}.sha256sum" "${TMP}/${run}.sha256sum")" = 200 ]; then
    local expected actual
    expected=$(awk '{ print $1; exit }' "${TMP}/${run}.sha256sum")
    actual=$(openssl dgst -sha256 "${TMP}/${run}" | awk '{ print $NF }')
    [ "$expected" = "$actual" ] || die "${run} does not match NVIDIA's published sha256"
  else
    log "NVIDIA publishes no checksum for ${run}; relying on HTTPS from download.nvidia.com"
  fi
  sh "${TMP}/${run}" --silent --no-kernel-modules --no-questions --ui=none
}

# Sets RELEASE_VERSION, DEB_FILE, DEB_SHA512.
resolve_release() {
  local feed tag="" url code
  feed="${TMP}/$(feed_name "$CHANNEL")"
  if [ -n "$VERSION" ]; then
    tag="v${VERSION}"
  elif [ "$CHANNEL" = beta ]; then
    # The newest published release carrying the beta app's feed. A stable tag
    # builds the beta app too, so this is never older than the newest stable.
    [ "$(fetch "${API}/releases?per_page=30" "${TMP}/releases.json")" = 200 ] || die "could not list releases from ${API}"
    tag=$(jq -r '[.[] | select(.draft | not) | select(any(.assets[]; .name == "beta-linux.yml"))][0].tag_name // empty' "${TMP}/releases.json")
    [ -n "$tag" ] || die "no release of ${REPO} has a Loxaic Beta Linux build"
  fi
  if [ -n "$tag" ]; then
    url="${GITHUB}/releases/download/${tag}/$(feed_name "$CHANNEL")"
  else
    url="${GITHUB}/releases/latest/download/$(feed_name "$CHANNEL")"
  fi
  code=$(fetch "$url" "$feed")
  if [ "$code" = 404 ]; then
    if [ -n "$VERSION" ]; then die "release v${VERSION} has no $(product_name "$CHANNEL") Linux build"; fi
    die "Loxaic has no stable release yet. Use --channel beta to install Loxaic Beta."
  fi
  [ "$code" = 200 ] || die "could not fetch ${url} (HTTP ${code})"

  RELEASE_VERSION=$(feed_version "$feed")
  valid_version "$RELEASE_VERSION" || die "the release feed gives an unexpected version: ${RELEASE_VERSION}"
  local entry
  entry=$(feed_deb_entry "$feed")
  DEB_FILE=${entry%% *}
  DEB_SHA512=${entry#* }
  [[ $DEB_FILE =~ ^[A-Za-z0-9._-]+\.deb$ ]] && [ -n "$DEB_SHA512" ] && [ "$DEB_SHA512" != "$entry" ] \
    || die "the release feed for ${RELEASE_VERSION} lists no .deb"
}

install_package() {
  local deb="${TMP}/${DEB_FILE}"
  local url="${GITHUB}/releases/download/v${RELEASE_VERSION}/${DEB_FILE}"
  log "Downloading ${DEB_FILE}"
  [ "$(fetch "$url" "$deb")" = 200 ] || die "could not download ${url}"
  [ "$(sha512_b64 "$deb")" = "$DEB_SHA512" ] || die "${DEB_FILE} does not match the sha512 in its release feed; not installing it"
  log "Installing $(product_name "$CHANNEL") ${RELEASE_VERSION}"
  apt-get install -y -qq "$deb"

  local bin="${ROOT}/opt/$(product_name "$CHANNEL")/$(service_name "$CHANNEL")"
  local missing
  missing=$(ldd "$bin" 2>&1 | awk '/not found/ { print $1 }' | tr '\n' ' ' || true)
  [ -z "${missing// /}" ] || die "$(product_name "$CHANNEL") needs libraries this system lacks: ${missing}"
}

ensure_user() {
  local user group
  user=$(service_name "$CHANNEL")
  if ! id -u "$user" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "/var/lib/${user}" --no-create-home --shell /usr/sbin/nologin "$user"
  fi
  # docker: agent sandboxes. render/video: the GPU nodes llama.cpp opens.
  for group in docker render video; do
    if getent group "$group" >/dev/null; then usermod -aG "$group" "$user"; fi
  done
}

# Writes the unit; returns 0 when it changed.
write_unit() {
  local path new
  path=$(unit_path "$CHANNEL")
  new="${TMP}/unit"
  unit_text "$CHANNEL" > "$new"
  if [ -f "$path" ] && cmp -s "$new" "$path"; then return 1; fi
  mkdir -p "$(dirname "$path")"
  cp "$new" "$path"
  chmod 0644 "$path"
  systemctl daemon-reload
  return 0
}

wait_for_health() {
  local service deadline
  service=$(service_name "$CHANNEL")
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  log "Waiting for the server (first start initialises its database)"
  while :; do
    if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null | jq -e '.services.database == "ok"' >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      journalctl -u "$service" -n 40 --no-pager >&2 || true
      die "the server did not become healthy within ${HEALTH_TIMEOUT}s"
    fi
    sleep 2
  done
}

print_summary() {
  local addr
  echo
  echo "$(product_name "$CHANNEL") ${1} is running."
  for addr in $(hostname -I 2>/dev/null || true); do
    case $addr in *:*) ;; *) echo "  http://${addr}:${PORT}" ;; esac
  done
  [ -n "$ADVERTISE_URL" ] && echo "  ${ADVERTISE_URL}"
  if [ "${2:-}" = fresh ]; then
    echo
    echo "Create your account now: the first account made becomes the admin,"
    echo "and anyone who can reach this address can sign up until you do."
  fi
  echo "Upgrade later by running: loxaic-install"
}

main() {
  while [ $# -gt 0 ]; do
    case $1 in
      --channel) CHANNEL=${2:-}; shift 2 ;;
      --channel=*) CHANNEL=${1#*=}; shift ;;
      --version) VERSION=${2:-}; shift 2 ;;
      --version=*) VERSION=${1#*=}; shift ;;
      --port) PORT=${2:-}; shift 2 ;;
      --port=*) PORT=${1#*=}; shift ;;
      --advertise-url) ADVERTISE_URL=${2:-}; shift 2 ;;
      --advertise-url=*) ADVERTISE_URL=${1#*=}; shift ;;
      --host-name) HOST_NAME=${2:-}; shift 2 ;;
      --host-name=*) HOST_NAME=${1#*=}; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
  [ -n "$CHANNEL" ] || CHANNEL=$(installed_channel)
  [ -n "$CHANNEL" ] || CHANNEL=stable
  case $CHANNEL in stable|beta) ;; *) die "--channel must be stable or beta" ;; esac
  VERSION=${VERSION#v}
  [ -z "$VERSION" ] || valid_version "$VERSION" || die "--version must look like 1.2.3 or 1.2.3-beta.4"
  [[ $PORT =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "--port must be between 1024 and 65535"
  [ -z "$ADVERTISE_URL" ] || [[ $ADVERTISE_URL =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die "--advertise-url must be a bare http(s) origin"
  # systemd expands % and $ in ExecStart, so the name is kept to plain characters.
  local name_re='^[A-Za-z0-9 ._-]*$'
  [[ $HOST_NAME =~ $name_re ]] || die "--host-name may contain only letters, digits, spaces, dots, dashes and underscores"

  check_system
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  install_prerequisites
  check_docker
  install_nvidia_userspace
  resolve_release

  local current installed=0 changed=0 fresh=""
  current=$(installed_version "$CHANNEL")
  [ -n "$current" ] || fresh=fresh
  if [ "$current" = "$RELEASE_VERSION" ]; then
    log "$(product_name "$CHANNEL") ${current} is already installed"
  else
    install_package
    installed=1
  fi
  ensure_user
  if write_unit; then changed=1; fi

  local service
  service=$(service_name "$CHANNEL")
  systemctl enable "$service" >/dev/null
  if [ "$installed" = 1 ] || [ "$changed" = 1 ]; then
    systemctl restart "$service"
  elif systemctl is-active --quiet "$service"; then
    echo "Already current: $(product_name "$CHANNEL") ${current}."
    return 0
  else
    systemctl start "$service"
  fi
  wait_for_health
  print_summary "$RELEASE_VERSION" "$fresh"
}

[ "${LOXAIC_SOURCE_ONLY:-}" = 1 ] || main "$@"
