#!/usr/bin/env bash
# Creates a Proxmox VE container running Loxaic as a headless host. Run it on
# the Proxmox host, as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CyberCyclone/Loxaic/master/infra/proxmox/create-lxc.sh)"
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CyberCyclone/Loxaic/beta/infra/proxmox/create-lxc.sh)" -- --channel beta
#
# It makes an unprivileged Ubuntu 24.04 container that can run Docker (agent
# sandboxes need it), passes the host's GPUs through for local models, and
# runs install.sh inside it. Upgrade later with: pct exec <ctid> -- /usr/local/sbin/loxaic-install
set -euo pipefail

REPO="${LOXAIC_REPO:-CyberCyclone/Loxaic}"
# Test seam: host paths this script inspects (/dev) go through it.
ROOT="${LOXAIC_TEST_ROOT:-}"
NETWORK_TIMEOUT="${LOXAIC_NETWORK_TIMEOUT:-90}"

CHANNEL=stable
CTID=""
CT_HOSTNAME=loxaic
STORAGE=local-lvm
TEMPLATE_STORAGE=""
BRIDGE=vmbr0
DISK=64
CORES=4
MEMORY=8192
IP=dhcp
GATEWAY=""
GPU=auto
YES=0
INSTALL_ARGS=()
TMP=""

die() { echo "create-lxc: $*" >&2; exit 1; }
log() { echo "==> $*"; }

usage() {
  cat <<'EOF'
Usage: create-lxc.sh [options]

Creates a Proxmox container with Loxaic installed as a headless host.

  --channel stable|beta    Loxaic (default) or Loxaic Beta.
  --version <x.y.z>        Install that release instead of the newest.
  --ctid <n>               Container ID (default: the next free one).
  --hostname <name>        Container hostname (default: loxaic).
  --storage <id>           Storage for the root disk (default: local-lvm).
  --template-storage <id>  Storage for the Ubuntu template (default: the
                           first that holds templates).
  --disk <GB>              Root disk size; models are large (default: 64).
  --cores <n>              CPU cores (default: 4).
  --memory <MB>            Memory (default: 8192).
  --bridge <name>          Network bridge (default: vmbr0).
  --ip dhcp|<cidr>         Address (default: dhcp); a CIDR needs --gateway.
  --gateway <ip>           Gateway for a static address.
  --gpu auto|dri|nvidia|none
                           GPUs to pass through (default: auto, every one found).
                           dri = AMD/Intel (/dev/dri, /dev/kfd).
  --port <n>               Loxaic's port inside the container (default: 4100).
  --advertise-url <url>    Address other machines should use, e.g. a reverse proxy.
  -y, --yes                Do not ask before creating the container.
  --help                   Show this help.
EOF
}

# The branch this channel's scripts are published on: a release moves it, so
# a host only ever runs a released installer. Never `dev`.
script_ref() {
  if [ -n "${LOXAIC_SCRIPT_REF:-}" ]; then echo "$LOXAIC_SCRIPT_REF"; return; fi
  case $1 in stable) echo master ;; beta) echo beta ;; esac
}

# "pve-manager/8.2.4/faa83925 (running kernel: ...)" → succeeds when ≥ 8.1,
# the first release with `devN:` passthrough for unprivileged containers.
pve_version_ok() {
  local v major minor
  v=$(printf '%s\n' "$1" | sed -n 's#^pve-manager/\([0-9][0-9]*\)\.\([0-9][0-9]*\).*#\1 \2#p' | head -n 1)
  [ -n "$v" ] || return 1
  major=${v% *}
  minor=${v#* }
  [ "$major" -gt 8 ] || { [ "$major" -eq 8 ] && [ "$minor" -ge 1 ]; }
}

# The newest Ubuntu 24.04 template in `pveam available --section system` output.
pick_template() {
  awk '{ print $2 }' | grep -E '^ubuntu-24\.04-standard_' | sort -V | tail -n 1 || true
}

dri_devices() {
  local d
  for d in "${ROOT}"/dev/dri/renderD* "${ROOT}/dev/kfd"; do
    [ -e "$d" ] && echo "${d#"$ROOT"}"
  done
  return 0
}

nvidia_devices() {
  local d
  for d in "${ROOT}"/dev/nvidia[0-9]* "${ROOT}/dev/nvidiactl" "${ROOT}/dev/nvidia-uvm" \
           "${ROOT}/dev/nvidia-uvm-tools" "${ROOT}"/dev/nvidia-caps/*; do
    [ -e "$d" ] && echo "${d#"$ROOT"}"
  done
  return 0
}

# The `pct set` value for one device: DRI nodes keep the container's render
# group, so only it can open them; NVIDIA's nodes are world-usable on the host
# too, and their user-space driver expects that.
device_spec() {
  case $1 in
    /dev/nvidia*) echo "$1,mode=0666" ;;
    *) echo "$1,gid=$2,mode=0660" ;;
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --channel) CHANNEL=${2:-}; shift 2 ;;
      --version|--port|--advertise-url) INSTALL_ARGS+=("$1" "${2:-}"); shift 2 ;;
      --ctid) CTID=${2:-}; shift 2 ;;
      --hostname) CT_HOSTNAME=${2:-}; shift 2 ;;
      --storage) STORAGE=${2:-}; shift 2 ;;
      --template-storage) TEMPLATE_STORAGE=${2:-}; shift 2 ;;
      --disk) DISK=${2:-}; shift 2 ;;
      --cores) CORES=${2:-}; shift 2 ;;
      --memory) MEMORY=${2:-}; shift 2 ;;
      --bridge) BRIDGE=${2:-}; shift 2 ;;
      --ip) IP=${2:-}; shift 2 ;;
      --gateway) GATEWAY=${2:-}; shift 2 ;;
      --gpu) GPU=${2:-}; shift 2 ;;
      -y|--yes) YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
  case $CHANNEL in stable|beta) ;; *) die "--channel must be stable or beta" ;; esac
  case $GPU in auto|dri|nvidia|none) ;; *) die "--gpu must be auto, dri, nvidia or none" ;; esac
  local n
  for n in "$DISK" "$CORES" "$MEMORY"; do [[ $n =~ ^[0-9]+$ ]] || die "--disk, --cores and --memory take whole numbers"; done
  [[ $CT_HOSTNAME =~ ^[A-Za-z0-9-]+$ ]] || die "--hostname may contain only letters, digits and dashes"
  if [ "$IP" != dhcp ]; then
    [[ $IP =~ ^[0-9.]+/[0-9]+$ ]] || die "--ip must be dhcp or an IPv4 CIDR such as 192.168.1.50/24"
    [ -n "$GATEWAY" ] || die "a static --ip needs --gateway"
  fi
  return 0
}

check_host() {
  [ "$(id -u)" = 0 ] || die "run this as root on the Proxmox host"
  local cmd
  for cmd in pct pveam pvesh pvesm pveversion; do
    command -v "$cmd" >/dev/null || die "this is not a Proxmox VE host (no ${cmd})"
  done
  [ "$(uname -m)" = x86_64 ] || die "Loxaic publishes Linux builds for x86_64 only"
  pve_version_ok "$(pveversion)" || die "Proxmox VE 8.1 or newer is needed (found: $(pveversion))"
}

# Fills DRI and NVIDIA (newline-separated device paths) from --gpu.
select_gpus() {
  DRI=""
  NVIDIA=""
  if [ "$GPU" = auto ] || [ "$GPU" = dri ]; then DRI=$(dri_devices); fi
  if [ "$GPU" = auto ] || [ "$GPU" = nvidia ]; then
    if nvidia-smi -L >/dev/null 2>&1; then
      # The UVM node appears only once something has used CUDA since boot.
      if [ ! -e "${ROOT}/dev/nvidia-uvm" ] && command -v nvidia-modprobe >/dev/null; then
        nvidia-modprobe -u -c=0 || true
      fi
      NVIDIA=$(nvidia_devices)
    elif [ "$GPU" = nvidia ]; then
      die "--gpu nvidia needs a working NVIDIA driver on this host (nvidia-smi failed)"
    fi
  fi
  if [ "$GPU" = dri ] && [ -z "$DRI" ]; then die "--gpu dri, but this host has no /dev/dri/renderD* device"; fi
  return 0
}

resolve_defaults() {
  if [ -z "$CTID" ]; then CTID=$(pvesh get /cluster/nextid); fi
  [[ $CTID =~ ^[0-9]+$ ]] || die "--ctid must be a number"
  if pct status "$CTID" >/dev/null 2>&1; then die "container ${CTID} already exists"; fi

  local rootdir
  rootdir=$(pvesm status -content rootdir | awk 'NR > 1 { print $1 }')
  printf '%s\n' "$rootdir" | grep -Fx -- "$STORAGE" >/dev/null || die "storage '${STORAGE}' cannot hold containers here; choose one of: $(printf '%s\n' "$rootdir" | tr '\n' ' ')"
  if [ -z "$TEMPLATE_STORAGE" ]; then
    TEMPLATE_STORAGE=$(pvesm status -content vztmpl | awk 'NR > 1 { print $1; exit }')
    [ -n "$TEMPLATE_STORAGE" ] || die "no storage here holds container templates; pass --template-storage"
  fi
}

confirm() {
  local gpus
  gpus=$(printf '%s\n%s\n' "$DRI" "$NVIDIA" | sed '/^$/d' | tr '\n' ' ')
  cat <<EOF
About to create container ${CTID}:
  Loxaic channel   ${CHANNEL}
  hostname         ${CT_HOSTNAME}
  root disk        ${STORAGE}, ${DISK} GB
  cores / memory   ${CORES} / ${MEMORY} MB
  network          ${BRIDGE}, ${IP}
  GPUs             ${gpus:-none}
EOF
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then return 0; fi
  local answer
  read -r -p "Create it? [Y/n] " answer
  case $answer in ""|[Yy]*) ;; *) die "cancelled" ;; esac
}

ensure_template() {
  log "Finding the Ubuntu 24.04 template"
  pveam update >/dev/null || true
  TEMPLATE=$(pveam available --section system | pick_template)
  [ -n "$TEMPLATE" ] || die "pveam lists no ubuntu-24.04-standard template"
  if ! pveam list "$TEMPLATE_STORAGE" | grep -F -- "$TEMPLATE" >/dev/null; then
    log "Downloading ${TEMPLATE}"
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi
}

create_container() {
  local net="name=eth0,bridge=${BRIDGE},ip=${IP}"
  [ "$IP" = dhcp ] || net="${net},gw=${GATEWAY}"
  log "Creating container ${CTID}"
  # nesting + keyctl: what Docker needs inside an unprivileged container.
  pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" --memory "$MEMORY" --swap 512 \
    --rootfs "${STORAGE}:${DISK}" \
    --net0 "$net" \
    --unprivileged 1 \
    --features nesting=1,keyctl=1 \
    --onboot 1 \
    --ostype ubuntu \
    --description "Loxaic (${CHANNEL}). Upgrade: pct exec ${CTID} -- /usr/local/sbin/loxaic-install"
  pct start "$CTID"
}

pass_through_gpus() {
  [ -n "$DRI$NVIDIA" ] || return 0
  local gid="" idx=0 dev
  if [ -n "$DRI" ]; then
    # The container's own render group, so the service user opens the node
    # through its group membership rather than through a world-writable mode.
    gid=$(pct exec "$CTID" -- getent group render | cut -d: -f3 || true)
    [ -n "$gid" ] || gid=$(pct exec "$CTID" -- getent group video | cut -d: -f3 || true)
    [ -n "$gid" ] || die "the container has neither a render nor a video group"
  fi
  log "Passing GPUs through"
  pct stop "$CTID"
  for dev in $DRI $NVIDIA; do
    pct set "$CTID" "--dev${idx}" "$(device_spec "$dev" "$gid")"
    idx=$((idx + 1))
  done
  pct start "$CTID"
  if [ -n "$NVIDIA" ]; then
    echo "Note: the container will not start after a host reboot until /dev/nvidia-uvm exists."
    echo "      Load it at boot on this host, e.g. with nvidia-persistenced, or a unit that runs: nvidia-modprobe -u -c=0"
  fi
}

wait_for_network() {
  local deadline=$(( $(date +%s) + NETWORK_TIMEOUT ))
  log "Waiting for the container's network"
  until pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "container ${CTID} cannot resolve github.com after ${NETWORK_TIMEOUT}s; check bridge ${BRIDGE} and DHCP"
    sleep 2
  done
}

run_installer() {
  local script
  if [ -n "${LOXAIC_INSTALL_SCRIPT:-}" ]; then
    script=$LOXAIC_INSTALL_SCRIPT
  else
    script="${TMP}/install.sh"
    local url
    url="https://raw.githubusercontent.com/${REPO}/$(script_ref "$CHANNEL")/infra/proxmox/install.sh"
    curl -fsSL --retry 3 -o "$script" "$url" || die "could not download ${url}"
  fi
  pct push "$CTID" "$script" /usr/local/sbin/loxaic-install --perms 0755
  log "Installing Loxaic inside container ${CTID}"
  pct exec "$CTID" -- /usr/local/sbin/loxaic-install --channel "$CHANNEL" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} \
    || die "the install inside container ${CTID} failed (above). Fix the cause and run: pct exec ${CTID} -- /usr/local/sbin/loxaic-install, or remove it with: pct destroy ${CTID}"
}

main() {
  parse_args "$@"
  check_host
  select_gpus
  resolve_defaults
  confirm
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  ensure_template
  create_container
  pass_through_gpus
  wait_for_network
  run_installer
  echo
  echo "Container ${CTID} is ready. Shell: pct enter ${CTID}. Upgrade: pct exec ${CTID} -- /usr/local/sbin/loxaic-install"
}

[ "${LOXAIC_SOURCE_ONLY:-}" = 1 ] || main "$@"
