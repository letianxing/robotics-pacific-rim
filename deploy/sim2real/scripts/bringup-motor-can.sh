#!/usr/bin/env bash
set -euo pipefail

BITRATE="${BITRATE:-1000000}"
SAMPLE_POINT="${SAMPLE_POINT:-0.875}"
SJW="${SJW:-4}"
RESTART_MS="${RESTART_MS:-500}"
TXQUEUELEN="${TXQUEUELEN:-1000}"
FD_DBITRATE="${FD_DBITRATE:-5000000}"
FD_SAMPLE_POINT="${FD_SAMPLE_POINT:-0.8}"
FD_DSAMPLE_POINT="${FD_DSAMPLE_POINT:-0.75}"
FD_DSJW="${FD_DSJW:-2}"
FD_TXQUEUELEN="${FD_TXQUEUELEN:-2000}"
UPPER_FD_IFACE="${UPPER_FD_IFACE:-can4}"

LOWER_IFACES=(can2 can3 can6)
UPPER_CLASSIC_IFACES=(can5 can7)
# Both arms. NOTE: this board enumerates CAN +1 vs the logical bus numbering
# (kcan monitor shows can2..can7), so the right arm lands on can7 and the left
# arm on can5 (motor_driver/config/motor.toml uses chan=7 / chan=5 to match).
# Same HT motors on both buses, so both are classic CAN.
ARM_IFACES=(can5 can7)
# Every motor CAN bus on the USB hub (kcan monitor shows can2..can7). `all`
# brings the whole set up classic in one shot (lower + arms + spare can4).
ALL_IFACES=(can2 can3 can4 can5 can6 can7)

usage() {
  cat <<EOF
Usage:
  bash deploy/sim2real/scripts/bringup-motor-can.sh [lower|upper|arms|all|can_iface...]

Defaults:
  lower -> can2 can3 can6
  upper -> can5 can7 plus CAN-FD ${UPPER_FD_IFACE}
  arms  -> lower (can2 can3 can6) + arms (can5 can7), all classic CAN
  all   -> can2 can3 can4 can5 can6 can7 (every motor bus, classic CAN)

Environment:
  BITRATE=${BITRATE}
  SAMPLE_POINT=${SAMPLE_POINT}
  SJW=${SJW}
  RESTART_MS=${RESTART_MS}
  TXQUEUELEN=${TXQUEUELEN}
  FD_DBITRATE=${FD_DBITRATE}
  FD_SAMPLE_POINT=${FD_SAMPLE_POINT}
  FD_DSAMPLE_POINT=${FD_DSAMPLE_POINT}
  FD_DSJW=${FD_DSJW}
  FD_TXQUEUELEN=${FD_TXQUEUELEN}
  UPPER_FD_IFACE=${UPPER_FD_IFACE}
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v ip >/dev/null 2>&1; then
  echo "error: 'ip' command not found" >&2
  exit 1
fi

ensure_iface() {
  local iface="$1"
  if ! ip link show "${iface}" >/dev/null 2>&1; then
    echo "error: interface '${iface}' not found" >&2
    exit 1
  fi
}

bringup_classic_can() {
  local iface="$1"
  ensure_iface "${iface}"
  echo
  echo "==> ${iface} classic CAN bitrate=${BITRATE} sample-point=${SAMPLE_POINT} sjw=${SJW} txqueuelen=${TXQUEUELEN}"
  sudo ip link set "${iface}" down || true
  sudo ip link set "${iface}" txqueuelen "${TXQUEUELEN}"
  sudo ip link set "${iface}" type can bitrate "${BITRATE}" sample-point "${SAMPLE_POINT}" sjw "${SJW}" restart-ms "${RESTART_MS}" berr-reporting on
  sudo ip link set "${iface}" up
  ip -details -statistics link show dev "${iface}"
}

bringup_fd_can() {
  local iface="$1"
  ensure_iface "${iface}"
  echo
  echo "==> ${iface} CAN-FD bitrate=${BITRATE} dbitrate=${FD_DBITRATE} txqueuelen=${FD_TXQUEUELEN}"
  sudo ip link set "${iface}" down || true
  sudo ip link set "${iface}" txqueuelen "${FD_TXQUEUELEN}"
  sudo ip link set "${iface}" type can bitrate "${BITRATE}" sample-point "${FD_SAMPLE_POINT}" sjw "${SJW}" dbitrate "${FD_DBITRATE}" dsample-point "${FD_DSAMPLE_POINT}" dsjw "${FD_DSJW}" fd on restart-ms "${RESTART_MS}" berr-reporting on
  sudo ip link set "${iface}" up
  ip -details -statistics link show dev "${iface}"
}

mode="${1:-lower}"
case "${mode}" in
  lower)
    echo "Bringing up lower-body motor CAN interfaces: ${LOWER_IFACES[*]}"
    for iface in "${LOWER_IFACES[@]}"; do
      bringup_classic_can "${iface}"
    done
    ;;
  upper)
    echo "Bringing up upper-body motor CAN interfaces: ${UPPER_CLASSIC_IFACES[*]} ${UPPER_FD_IFACE}"
    for iface in "${UPPER_CLASSIC_IFACES[@]}"; do
      bringup_classic_can "${iface}"
    done
    bringup_fd_can "${UPPER_FD_IFACE}"
    ;;
  arms)
    echo "Bringing up lower + arm motor CAN interfaces: ${LOWER_IFACES[*]} ${ARM_IFACES[*]}"
    for iface in "${LOWER_IFACES[@]}" "${ARM_IFACES[@]}"; do
      bringup_classic_can "${iface}"
    done
    ;;
  all)
    echo "Bringing up ALL motor CAN interfaces: ${ALL_IFACES[*]}"
    for iface in "${ALL_IFACES[@]}"; do
      bringup_classic_can "${iface}"
    done
    ;;
  *)
    if [[ "$#" -lt 1 ]]; then
      usage >&2
      exit 2
    fi
    echo "Bringing up custom motor CAN interfaces: $*"
    for iface in "$@"; do
      bringup_classic_can "${iface}"
    done
    ;;
esac

echo
echo "Motor CAN bringup complete."
