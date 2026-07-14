#!/usr/bin/env bash
# Layer 1 / bottom: lhframework sim2real + policy + cmd_vel_mux auto.
# Start this ONCE in its own terminal and leave it running. The motion-control
# layer (start-motion-control-layer.sh) runs separately and can be restarted
# freely without disturbing this layer / the balance policy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ROS_SETUP="${ROS_SETUP:-/opt/ros/humble/setup.bash}"
# This repo (pr layout) builds every package into one merge-install overlay.
PACIFIC_SETUP="${PACIFIC_SETUP:-${REPO_ROOT}/.ros_local_ws/install/setup.bash}"
ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-77}"

# Readiness is taken from the runner's own log (it prints imu_fresh=<bool> every
# second). That is the ground truth — a `ros2 topic echo` CLI check gives false
# negatives on this Tegra's slow discovery and just wastes 40s spewing warnings.
RUNNER_READY_TIMEOUT_SEC="${RUNNER_READY_TIMEOUT_SEC:-30}"
# Per-attempt timeout and retry count for the policy/auto service calls. The
# call blocks until the service is discovered, so a generous per-attempt timeout
# plus several retries rides out slow DDS discovery without hard-failing.
SERVICE_CALL_TIMEOUT_SEC="${SERVICE_CALL_TIMEOUT_SEC:-15}"
SERVICE_CALL_RETRIES="${SERVICE_CALL_RETRIES:-12}"
LOG_DIR="${LOG_DIR:-/tmp/sim2real_layer_$(date +%Y%m%d_%H%M%S)}"

sim2real_pid=""
policy_started=0

log()  { printf '[sim2real-layer] %s\n' "$*"; }
fail() { printf '[sim2real-layer] error: %s\n' "$*" >&2; exit 1; }
source_setup() { set +u; source "$1"; set -u; }
check_file() { [[ -f "$1" ]] || fail "missing file: $1"; }
process_alive() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }

stop_process_group() {
  local pid="$1" name="$2"
  if process_alive "${pid}"; then
    log "stopping ${name} pid=${pid}"
    kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    sleep 2
  fi
  if process_alive "${pid}"; then
    kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  fi
  wait "${pid}" 2>/dev/null || true
}

cleanup() {
  local code=$?
  [[ -n "${sim2real_pid}" ]] && stop_process_group "${sim2real_pid}" "sim2real"
  exit "${code}"
}

# Call a service with retries. We do NOT gate on `ros2 service list` first:
# on this Tegra the CLI's DDS discovery is flaky and frequently fails to list a
# service that is actually up (same false-negative that plagued the IMU check),
# which used to hard-fail the whole layer before the user ever saw the Enter
# prompt. `ros2 service call` does its own discovery and blocks until the
# service is available, so we just retry the call itself until it succeeds.
call_service_retry() {
  local service="$1" srv_type="$2" request="$3" label="$4" i
  for (( i = 1; i <= SERVICE_CALL_RETRIES; i++ )); do
    if timeout "${SERVICE_CALL_TIMEOUT_SEC}s" \
         ros2 service call "${service}" "${srv_type}" "${request}" >/dev/null 2>&1; then
      log "${label}: OK"
      return 0
    fi
    log "${label}: attempt ${i}/${SERVICE_CALL_RETRIES} did not complete, retrying..."
  done
  return 1
}

start_sim2real() {
  mkdir -p "${LOG_DIR}"
  local hw_dir rt_dir log_file
  hw_dir="$(ros2 pkg prefix lhframework_hw)/share/lhframework_hw/config"
  rt_dir="$(ros2 pkg prefix lhframework_ros)/share/lhframework_ros/runtime_resources/config"
  log_file="${LOG_DIR}/sim2real.log"
  log "starting sim2real launch, log=${log_file}"
  setsid ros2 launch lhframework_ros lhframework_sim2real.launch.py \
    hw_params_file:="${hw_dir}/lhframework_hw_leg_wheel_zn.yaml" \
    runtime_config_file:="${rt_dir}/runtime_nemov3_519_stand_drive_wheel8.yaml" \
    physical_joint_disable_override:=true \
    start_policy_control_service:=true \
    cmd_mux_require_remote_alive:=false \
    start_cmd_mux:=true \
    start_velocity_estimator:=true \
    start_imu_node:=true \
    >"${log_file}" 2>&1 &
  sim2real_pid=$!
}

# Wait until the runner reports it is alive with a fresh IMU. The runner prints a
# status line every second containing imu_fresh=<bool>; the first imu_fresh=true
# is the real readiness signal (no flaky CLI discovery involved).
wait_for_runner_ready() {
  local log_file="${LOG_DIR}/sim2real.log" start; start="$(date +%s)"
  log "waiting for runner (imu_fresh=true)..."
  while true; do
    if ! process_alive "${sim2real_pid}"; then
      fail "sim2real launch exited during startup; see ${log_file}"
    fi
    if grep -q "imu_fresh=true" "${log_file}" 2>/dev/null; then
      log "runner ready: imu_fresh=true"
      return 0
    fi
    (( "$(date +%s)" - start >= RUNNER_READY_TIMEOUT_SEC )) && {
      log "runner not confirmed ready after ${RUNNER_READY_TIMEOUT_SEC}s; continuing (check ${log_file})"
      return 1
    }
    sleep 0.5
  done
}

confirm_policy_start() {
  cat <<EOF

Safety checkpoint before policy inference.
  - robot supported or clear space?  E-stop ready?  IMU/velocity checks OK above?
Press Enter to start policy inference, or Ctrl-C to abort.

EOF
  read -r _
}

enable_policy_and_auto() {
  # Human safety gate FIRST, before any (potentially slow) service discovery, so
  # a flaky CLI can never strand the operator without an Enter prompt.
  confirm_policy_start
  log "starting policy inference (retrying until the service answers)"
  call_service_retry "/policy_control_service/set_policy_control" \
    "lhframework_interfaces/srv/SetPolicyControl" \
    "{start: true, joint_disable: false, policy_id: ''}" "policy start" \
    || fail "policy control service never answered after ${SERVICE_CALL_RETRIES} attempts"
  policy_started=1
  log "switching cmd_vel_mux to auto"
  call_service_retry "/cmd_vel_mux/set_auto" "std_srvs/srv/SetBool" \
    "{data: true}" "cmd_vel_mux auto" \
    || log "WARNING: could not switch mux to auto. Do it manually when ready: ros2 service call /cmd_vel_mux/set_auto std_srvs/srv/SetBool \"{data: true}\""
}

print_ready() {
  cat <<EOF

Layer 1 (sim2real + policy + auto) is up and holding.
Now start the motion-control layer in ANOTHER terminal:
  bash deploy/sim2real/scripts/start-motion-control-layer.sh

Log: ${LOG_DIR}/sim2real.log
Ctrl-C here stops the sim2real layer.

EOF
}

monitor() {
  print_ready
  while true; do
    if ! process_alive "${sim2real_pid}"; then
      (( policy_started != 0 )) && fail "sim2real exited after policy start; not auto-restarting"
      log "sim2real exited before policy; restarting"
      start_sim2real; wait_for_runner_ready; enable_policy_and_auto
    fi
    sleep 2
  done
}

main() {
  [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { echo "Layer 1: sim2real + policy + cmd_vel_mux auto. Run once, leave running."; exit 0; }
  check_file "${ROS_SETUP}"; check_file "${PACIFIC_SETUP}"
  cd "${REPO_ROOT}"
  source_setup "${ROS_SETUP}"; source_setup "${PACIFIC_SETUP}"; export ROS_DOMAIN_ID
  trap cleanup EXIT INT TERM
  log "repo=${REPO_ROOT} ROS_DOMAIN_ID=${ROS_DOMAIN_ID} LOG_DIR=${LOG_DIR}"
  start_sim2real
  wait_for_runner_ready
  enable_policy_and_auto
  monitor
}

main "$@"
