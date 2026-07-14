#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

INSTALL_GOLANG="${INSTALL_GOLANG:-0}"
BUILD_ALL_JOBS="${BUILD_ALL_JOBS:-4}"
BUILD_ALL_PREPARE_IMAGE="${BUILD_ALL_PREPARE_IMAGE:-1}"
BUILD_ALL_LOCK_DIR="${BUILD_ALL_LOCK_DIR:-${ROOT_DIR}/.cache/build-all.lock}"

cleanup_build_lock() {
  rm -rf "${BUILD_ALL_LOCK_DIR}"
}

pid_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

pid_matches_script() {
  local pid="$1"
  local script_name="$2"
  local command_line
  command_line="$(pid_command "${pid}")"
  [[ "${command_line}" == *"${script_name}"* ]]
}

collect_descendant_pids() {
  local parent_pid="$1"
  local child_pid

  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi

  while IFS= read -r child_pid; do
    [[ "${child_pid}" =~ ^[0-9]+$ ]] || continue
    printf '%s\n' "${child_pid}"
    collect_descendant_pids "${child_pid}"
  done < <(pgrep -P "${parent_pid}" 2>/dev/null || true)
}

stop_process_trees() {
  local pid descendant existing attempts
  local pids=()
  local alive=()

  for pid in "$@"; do
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    [[ "${pid}" == "$$" ]] && continue
    if [[ "${#pids[@]}" -eq 0 ]] || ! contains_value "${pid}" "${pids[@]}"; then
      pids+=("${pid}")
    fi
    while IFS= read -r descendant; do
      [[ "${descendant}" =~ ^[0-9]+$ ]] || continue
      [[ "${descendant}" == "$$" ]] && continue
      if [[ "${#pids[@]}" -eq 0 ]] || ! contains_value "${descendant}" "${pids[@]}"; then
        pids+=("${descendant}")
      fi
    done < <(collect_descendant_pids "${pid}")
  done

  [[ "${#pids[@]}" -gt 0 ]] || return 0

  kill -TERM "${pids[@]}" 2>/dev/null || true
  for attempts in 1 2 3 4 5; do
    alive=()
    for existing in "${pids[@]}"; do
      if kill -0 "${existing}" 2>/dev/null; then
        alive+=("${existing}")
      fi
    done
    [[ "${#alive[@]}" -eq 0 ]] && return 0
    sleep 1
  done

  kill -KILL "${alive[@]}" 2>/dev/null || true
}

handle_build_signal() {
  trap - EXIT INT TERM
  if [[ "${BATCH_PIDS+x}" == "x" && "${#BATCH_PIDS[@]}" -gt 0 ]]; then
    stop_process_trees "${BATCH_PIDS[@]}"
  fi
  cleanup_build_lock
  exit 130
}

acquire_build_lock() {
  mkdir -p "${ROOT_DIR}/.cache"

  if mkdir "${BUILD_ALL_LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" >"${BUILD_ALL_LOCK_DIR}/pid"
    : >"${BUILD_ALL_LOCK_DIR}/children"
    trap cleanup_build_lock EXIT
    trap handle_build_signal INT TERM
    return 0
  fi

  local lock_pid=""
  local child_pids=()
  local child_pid
  if [[ -f "${BUILD_ALL_LOCK_DIR}/pid" ]]; then
    lock_pid="$(cat "${BUILD_ALL_LOCK_DIR}/pid" 2>/dev/null || true)"
  fi

  if [[ -n "${lock_pid}" ]] && [[ "${lock_pid}" =~ ^[0-9]+$ ]] && kill -0 "${lock_pid}" 2>/dev/null && pid_matches_script "${lock_pid}" "build-all.sh"; then
    echo "Stopping previous build-all.sh run with pid ${lock_pid}."
    if [[ -f "${BUILD_ALL_LOCK_DIR}/children" ]]; then
      while IFS= read -r child_pid; do
        [[ "${child_pid}" =~ ^[0-9]+$ ]] && child_pids+=("${child_pid}")
      done <"${BUILD_ALL_LOCK_DIR}/children"
    fi
    if [[ "${#child_pids[@]}" -gt 0 ]]; then
      stop_process_trees "${lock_pid}" "${child_pids[@]}"
    else
      stop_process_trees "${lock_pid}"
    fi
  else
    echo "Removing stale build-all lock: ${BUILD_ALL_LOCK_DIR}" >&2
  fi

  rm -rf "${BUILD_ALL_LOCK_DIR}"
  if ! mkdir "${BUILD_ALL_LOCK_DIR}" 2>/dev/null; then
    echo "Could not acquire build-all lock: ${BUILD_ALL_LOCK_DIR}" >&2
    exit 3
  fi
  printf '%s\n' "$$" >"${BUILD_ALL_LOCK_DIR}/pid"
  : >"${BUILD_ALL_LOCK_DIR}/children"
  trap cleanup_build_lock EXIT
  trap handle_build_signal INT TERM
}

usage() {
  cat <<'USAGE'
Usage:
  ./build-all.sh [--jobs <n>|--parallel <n>] [--install-golang|--no-install-golang] [--skip-build-image] [extra ./pr ros2:build args...]
  ./build-all.sh --list

Builds every module/service entry that has a ROS2 package.xml, one package at a
time, through ./pr ros2:build.

Go is not installed in ROS2 images by default. Use --install-golang or
INSTALL_GOLANG=1 when building Go ROS2 services.
Use --jobs, --parallel, or BUILD_ALL_JOBS to run multiple service builds in parallel.
By default, build-all prepares the shared ROS2 image once before parallel package
builds. Use --skip-build-image or BUILD_ALL_PREPARE_IMAGE=0 only when the image
is already available locally.
USAGE
}

list_services() {
  load_ros2_targets
  echo "All module services:"
  local row service_dir package_name ros_distro service_env
  for row in "${ROS2_BUILD_TARGETS[@]}"; do
    IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"
    printf '  %s\n' "${service_dir}"
  done
  echo
  echo "Build targets:"
  for row in "${ROS2_BUILD_TARGETS[@]}"; do
    IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"
    printf '  %s -> %s [%s] %s\n' "${service_dir}" "${package_name}" "${ros_distro}" "${service_env}"
  done
}

load_ros2_targets() {
  ROS2_BUILD_TARGETS=()
  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] && ROS2_BUILD_TARGETS+=("${line}")
  done < <(node bin/ros2-projects.mjs --format=tsv)
}

print_summary() {
  local row status service_dir package_name exit_code

  echo
  echo "Build summary:"
  for row in "${RESULT_ROWS[@]}"; do
    IFS='|' read -r status service_dir package_name exit_code <<< "${row}"
    case "${status}" in
      SUCCESS)
        printf '  [SUCCESS] %s (%s)\n' "${service_dir}" "${package_name}"
        ;;
      FAILED)
        printf '  [FAILED]  %s (%s), exit=%s\n' "${service_dir}" "${package_name}" "${exit_code}"
        ;;
      SKIPPED)
        printf '  [SKIPPED] %s (%s)\n' "${service_dir}" "${exit_code}"
        ;;
    esac
  done

  echo
  printf 'Totals: success=%s failed=%s skipped=%s total=%s\n' \
    "${#SUCCESS_RESULTS[@]}" \
    "${#FAILED_RESULTS[@]}" \
    "${#SKIPPED_RESULTS[@]}" \
    "${#RESULT_ROWS[@]}"
}

validate_jobs() {
  if [[ ! "$1" =~ ^[1-9][0-9]*$ ]]; then
    echo "--jobs must be a positive integer: $1" >&2
    exit 2
  fi
}

resolve_ros2_image() {
  local service_env="${1:-}"
  (
    local assignment
    for assignment in ${service_env}; do
      export "${assignment}"
    done

    if [[ -n "${ROS2_IMAGE:-}" ]]; then
      printf '%s\n' "${ROS2_IMAGE}"
      return 0
    fi

    local ros_distro="${ROS_DISTRO:-humble}"
    local enable_vision_stack="${ENABLE_VISION_STACK:-0}"
    local vision_target="${VISION_TARGET:-none}"
    local image_tag="${ros_distro}"

    if [[ "${vision_target}" == "auto" ]]; then
      case "$(uname -m)" in
        amd64|x86_64)
          vision_target="pc-nvidia"
          ;;
        arm64|aarch64)
          vision_target="jetson"
          ;;
        *)
          echo "Cannot auto-detect VISION_TARGET from architecture \"$(uname -m)\". Use pc-nvidia or jetson explicitly." >&2
          return 2
          ;;
      esac
    fi

    if [[ "${enable_vision_stack}" == "1" || "${vision_target}" != "none" ]]; then
      image_tag="${ros_distro}-vision"
      if [[ "${vision_target}" != "none" ]]; then
        image_tag="${image_tag}-${vision_target}"
      fi
    fi

    printf 'pacific-rim-ros2:%s\n' "${image_tag}"
  )
}

prepare_ros2_images() {
  if [[ "${BUILD_ALL_PREPARE_IMAGE}" != "1" ]]; then
    echo "Skipping ROS2 image preparation."
    return 0
  fi

  local row service_dir package_name ros_distro service_env image log_file exit_code key
  local prepared_keys=()

  for row in "${ROS2_BUILD_TARGETS[@]}"; do
    IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"
    image="$(resolve_ros2_image "${service_env}")"
    key="${image}|${service_env}"
    if [[ "${#prepared_keys[@]}" -gt 0 ]] && contains_value "${key}" "${prepared_keys[@]}"; then
      continue
    fi
    prepared_keys+=("${key}")
    log_file="${LOG_ROOT}/build-image-${package_name}.log"

    if [[ "${INSTALL_GOLANG}" != "1" ]] && [[ "${service_env}" != *"INSTALL_GOLANG=1"* ]] && docker image inspect "${image}" >/dev/null 2>&1; then
      echo "ROS2 image ready: ${image}"
      continue
    fi

    local env_args=()
    if [[ -n "${service_env}" ]]; then
      read -r -a env_args <<< "${service_env}"
    fi
    if [[ "${service_env}" != *"INSTALL_GOLANG="* ]]; then
      if [[ "${#env_args[@]}" -gt 0 ]]; then
        env_args=("INSTALL_GOLANG=${INSTALL_GOLANG}" "${env_args[@]}")
      else
        env_args=("INSTALL_GOLANG=${INSTALL_GOLANG}")
      fi
    fi

    echo "Preparing ROS2 image: ${image}, log=${log_file}"
    set +e
    env "${env_args[@]}" ./pr ros2:build-image >"${log_file}" 2>&1
    exit_code="$?"
    set -e

    if [[ "${exit_code}" -eq 0 ]]; then
      echo "  [SUCCESS] ROS2 image ready: ${image}, log=${log_file}"
      continue
    fi

    echo "  [FAILED]  ROS2 image prepare failed: ${image}, exit=${exit_code}, log=${log_file}" >&2
    return "${exit_code}"
  done
}

contains_value() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
}

start_build_job() {
  local service_dir="$1"
  local package_name="$2"
  local job_index="$3"
  local service_env="$4"
  local log_file="${LOG_ROOT}/${package_name}.log"
  local cmd_args=(--packages-select "${package_name}")
  local env_args=()
  local base_suffix

  if [[ -n "${service_env}" ]]; then
    read -r -a env_args <<< "${service_env}"
  fi
  if [[ "${service_env}" != *"INSTALL_GOLANG="* ]]; then
    if [[ "${#env_args[@]}" -gt 0 ]]; then
      env_args=("INSTALL_GOLANG=${INSTALL_GOLANG}" "${env_args[@]}")
    else
      env_args=("INSTALL_GOLANG=${INSTALL_GOLANG}")
    fi
  fi
  base_suffix="$(base_suffix_for_env "${service_env}")"

  if [[ "${BUILD_ALL_JOBS}" -gt 1 ]]; then
    cmd_args+=(
      --build-base "build/build-all/${package_name}${base_suffix}"
      --install-base "install/build-all/${package_name}${base_suffix}"
      --log-base "log/build-all/${package_name}${base_suffix}"
    )
  fi
  if [[ "${#BUILD_ARGS[@]}" -gt 0 ]]; then
    cmd_args+=("${BUILD_ARGS[@]}")
  fi

  (
    printf '[%s/%s] build %s (%s)\n' "${job_index}" "${target_count}" "${service_dir}" "${package_name}"
    env "${env_args[@]}" ./pr ros2:build "${cmd_args[@]}"
  ) >"${log_file}" 2>&1 &

  BATCH_PIDS+=("$!")
  printf '%s\n' "$!" >>"${BUILD_ALL_LOCK_DIR}/children" 2>/dev/null || true
  BATCH_SERVICES+=("${service_dir}")
  BATCH_PACKAGES+=("${package_name}")
  BATCH_LOGS+=("${log_file}")
}

base_suffix_for_env() {
  local service_env="$1"
  local assignment key value suffix=""

  for assignment in ${service_env}; do
    key="${assignment%%=*}"
    value="${assignment#*=}"
    case "${key}" in
      ROS_DISTRO)
        [[ "${value}" == "humble" ]] && continue
        ;;
      VISION_TARGET|DOCKER_DEFAULT_PLATFORM)
        ;;
      *)
        continue
        ;;
    esac
    value="${value//\//-}"
    value="${value//[^A-Za-z0-9_.-]/-}"
    suffix="${suffix}-${value}"
  done

  printf '%s\n' "${suffix}"
}

flush_build_batch() {
  local i pid service_dir package_name log_file exit_code

  for i in "${!BATCH_PIDS[@]}"; do
    pid="${BATCH_PIDS[$i]}"
    service_dir="${BATCH_SERVICES[$i]}"
    package_name="${BATCH_PACKAGES[$i]}"
    log_file="${BATCH_LOGS[$i]}"

    if wait "${pid}"; then
      SUCCESS_RESULTS+=("${service_dir}")
      RESULT_ROWS+=("SUCCESS|${service_dir}|${package_name}|0")
      printf '  [SUCCESS] %s (%s), log=%s\n' "${service_dir}" "${package_name}" "${log_file}"
    else
      exit_code="$?"
      FAILED_RESULTS+=("${service_dir}")
      RESULT_ROWS+=("FAILED|${service_dir}|${package_name}|${exit_code}")
      printf '  [FAILED]  %s (%s), exit=%s, log=%s\n' "${service_dir}" "${package_name}" "${exit_code}" "${log_file}"
    fi
  done

  BATCH_PIDS=()
  BATCH_SERVICES=()
  BATCH_PACKAGES=()
  BATCH_LOGS=()
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --list)
    list_services
    exit 0
    ;;
esac

BUILD_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --packages-select|--packages-select=*|--packages-up-to|--packages-up-to=*|--package|--package=*)
      echo "build-all.sh supplies package selection for each service; remove $1." >&2
      exit 2
      ;;
    --build-base|--build-base=*|--install-base|--install-base=*|--log-base|--log-base=*)
      echo "build-all.sh supplies isolated build/install/log bases when running in parallel; remove $1." >&2
      exit 2
      ;;
    --jobs|-j|--parallel)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "$1 requires a value." >&2
        exit 2
      fi
      BUILD_ALL_JOBS="$2"
      shift 2
      ;;
    --jobs=*|-j=*|--parallel=*)
      BUILD_ALL_JOBS="${1#*=}"
      shift
      ;;
    --install-golang)
      INSTALL_GOLANG=1
      shift
      ;;
    --no-install-golang)
      INSTALL_GOLANG=0
      shift
      ;;
    --install-golang=*)
      INSTALL_GOLANG="${1#--install-golang=}"
      shift
      ;;
    --prepare-image|--build-image)
      BUILD_ALL_PREPARE_IMAGE=1
      shift
      ;;
    --skip-build-image|--no-prepare-image)
      BUILD_ALL_PREPARE_IMAGE=0
      shift
      ;;
    *)
      BUILD_ARGS+=("$1")
      shift
      ;;
  esac
done

validate_jobs "${BUILD_ALL_JOBS}"
load_ros2_targets
acquire_build_lock

target_count="${#ROS2_BUILD_TARGETS[@]}"
index=1
SUCCESS_RESULTS=()
FAILED_RESULTS=()
SKIPPED_RESULTS=()
RESULT_ROWS=()
BATCH_PIDS=()
BATCH_SERVICES=()
BATCH_PACKAGES=()
BATCH_LOGS=()
LOG_ROOT="log/build-all/$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_ROOT}"
echo "Build jobs: ${BUILD_ALL_JOBS}"
echo "Build logs: ${LOG_ROOT}"
prepare_ros2_images

for row in "${ROS2_BUILD_TARGETS[@]}"; do
  IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"

  start_build_job "${service_dir}" "${package_name}" "${index}" "${service_env}"
  if [[ "${#BATCH_PIDS[@]}" -ge "${BUILD_ALL_JOBS}" ]]; then
    flush_build_batch
  fi
  index=$((index + 1))
done

flush_build_batch
print_summary

if [[ "${#FAILED_RESULTS[@]}" -gt 0 ]]; then
  exit 1
fi
