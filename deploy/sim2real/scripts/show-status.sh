#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ROS_SETUP="${ROS_SETUP:-/opt/ros/humble/setup.bash}"
PACIFIC_SETUP="${PACIFIC_SETUP:-${REPO_ROOT}/.ros_local_ws/install/setup.bash}"
DEFAULT_CONFIG="${REPO_ROOT}/pkg/driver/motor/khcan_native/config/motor_leg_wheel.toml"
KHCAN_CONFIG="${KHCAN_CONFIG:-${DEFAULT_CONFIG}}"

source_setup() {
  set +u
  source "$1"
  set -u
}

usage() {
  cat <<EOF
Usage:
  bash deploy/sim2real/scripts/show-status.sh [show_status options]

Default behavior only queries status. It does not set zero, clear errors,
enable, or disable unless you pass those options through to show_status.

Environment:
  ROS_SETUP=${ROS_SETUP}
  PACIFIC_SETUP=${PACIFIC_SETUP}
  KHCAN_CONFIG=${KHCAN_CONFIG}

Examples:
  bash deploy/sim2real/scripts/show-status.sh --hz 10
  bash deploy/sim2real/scripts/show-status.sh --resolve-config-only
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "${ROS_SETUP}" ]]; then
  echo "error: ROS setup file not found: ${ROS_SETUP}" >&2
  exit 1
fi

if [[ ! -f "${PACIFIC_SETUP}" ]]; then
  echo "error: Pacific-Rim setup file not found: ${PACIFIC_SETUP}" >&2
  echo "       Build first: bash deploy/sim2real/scripts/build-runtime.sh" >&2
  exit 1
fi

if [[ ! -f "${KHCAN_CONFIG}" ]]; then
  echo "error: khcan motor config not found: ${KHCAN_CONFIG}" >&2
  exit 1
fi

source_setup "${ROS_SETUP}"
source_setup "${PACIFIC_SETUP}"

khcan_prefix="$(ros2 pkg prefix khcan 2>/dev/null || true)"
khcan_exe=""
if [[ -n "${khcan_prefix}" && -x "${khcan_prefix}/lib/khcan/show_status" ]]; then
  khcan_exe="${khcan_prefix}/lib/khcan/show_status"
elif [[ -x "${REPO_ROOT}/build/khcan/show_status" ]]; then
  khcan_exe="${REPO_ROOT}/build/khcan/show_status"
fi

if [[ -z "${khcan_exe}" ]]; then
  echo "error: show_status executable not found" >&2
  echo "       Build first with khcan included in colcon base-paths." >&2
  exit 2
fi

export KHCAN_CONFIG_PATH="${KHCAN_CONFIG}"
exec "${khcan_exe}" "$@" "${KHCAN_CONFIG}"
