#!/usr/bin/env bash
# Layer 2 / upper: motion_control_padding PI velocity compensator.
# Requires Layer 1 (start-sim2real-layer.sh) already running in another terminal.
# Safe to Ctrl-C and re-run this freely to reload params.yaml without disturbing
# the sim2real layer / balance policy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ROS_SETUP="${ROS_SETUP:-/opt/ros/humble/setup.bash}"
PACIFIC_SETUP="${PACIFIC_SETUP:-${REPO_ROOT}/.ros_local_ws/install/setup.bash}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-77}"

VELOCITY_TOPIC="${VELOCITY_TOPIC:-/robot/velocity_estimate}"
MUX_SOURCE_TOPIC="${MUX_SOURCE_TOPIC:-/cmd_vel_mux/source}"
DEP_CHECK_TIMEOUT_SEC="${DEP_CHECK_TIMEOUT_SEC:-4}"

log()  { printf '[motion-control-layer] %s\n' "$*"; }
fail() { printf '[motion-control-layer] error: %s\n' "$*" >&2; exit 1; }
source_setup() { set +u; source "$1"; set -u; }
check_file() { [[ -f "$1" ]] || fail "missing file: $1"; }
topic_once() { timeout "${2}s" ros2 topic echo --once --qos-reliability best_effort "$1" >/dev/null 2>&1; }

check_layer1() {
  # Soft checks only: warn if the bottom layer doesn't look up, but still start
  # (the compensator handles stale feedback and just waits).
  if topic_once "${VELOCITY_TOPIC}" "${DEP_CHECK_TIMEOUT_SEC}"; then
    log "layer 1 OK: ${VELOCITY_TOPIC} publishing"
  else
    log "WARNING: no ${VELOCITY_TOPIC} — is start-sim2real-layer.sh running? starting anyway"
  fi
  local src
  src="$(timeout "${DEP_CHECK_TIMEOUT_SEC}s" ros2 topic echo --once --field data "${MUX_SOURCE_TOPIC}" 2>/dev/null || true)"
  if [[ "${src}" == "auto" ]]; then
    log "cmd_vel_mux source = auto"
  else
    log "WARNING: cmd_vel_mux source = '${src:-<none>}' (expected auto). Output won't reach the robot until auto."
  fi
}

kill_stale() {
  # Avoid two compensators fighting if this script is re-run.
  local pids
  # Match the padding PI node (and any old compensator) so neither is left fighting
  # on /cmd_vel_auto when this script is re-run / after a layer switch.
  pids="$(pgrep -f 'velocity_.*compensator_node' || true)"
  if [[ -n "${pids}" ]]; then
    log "killing stale compensator node(s): ${pids}"
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
    sleep 1
  fi
}

print_pi_tune_help() {
  cat <<'EOF'

────────────────────────────────────────────────────────────────────────
PI 速度补偿调参速查(padding, 运行中可 ros2 param set 热调)
  闭环：/cmd_vel_vision(期望) + /robot/velocity_estimate(反馈) → PI 校正
        → /cmd_vel_auto(给底层 mux)。节点名 = velocity_pi_compensator。
    · 起步慢、跟不上  → 加 kp:  ros2 param set /velocity_pi_compensator vx_kp 1.0
    · 稳态差一点      → 加 ki:  ros2 param set /velocity_pi_compensator vx_ki 0.8
    · 抖 / 过冲       → 降 kp:  ros2 param set /velocity_pi_compensator vx_kp 0.6
    · 跑久了越冲、切速度后拖尾 → 降 ki: ros2 param set /velocity_pi_compensator vx_ki 0.4
  角速度同理用 wz_kp / wz_ki。满意后写回固化:
  module/service/motion_control_padding_service/config/params.yaml
  状态话题: /motion_control_padding/velocity_pi_compensator/status
────────────────────────────────────────────────────────────────────────
EOF
}

main() {
  [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { echo "Layer 2: motion_control_padding PI velocity compensator. Needs Layer 1 up. Ctrl-C to stop; re-run to reload params."; exit 0; }
  check_file "${ROS_SETUP}"; check_file "${PACIFIC_SETUP}"
  cd "${REPO_ROOT}"
  source_setup "${ROS_SETUP}"; source_setup "${PACIFIC_SETUP}"; export ROS_DOMAIN_ID
  log "repo=${REPO_ROOT} ROS_DOMAIN_ID=${ROS_DOMAIN_ID}"
  check_layer1
  kill_stale
  print_pi_tune_help
  log "starting motion_control_padding PI velocity compensator (Ctrl-C to stop)"
  # exec → the launch is the foreground process; Ctrl-C stops it cleanly.
  exec ros2 launch motion_control_padding motion_control_padding.launch.py
}

main "$@"
