#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

INSTALL_GOLANG="${INSTALL_GOLANG:-0}"
DEPLOY_DOMAIN_ID="${ROS_DOMAIN_ID:-}"
DEPLOY_ALL_JOBS="${DEPLOY_ALL_JOBS:-4}"
DEPLOY_ALL_PROGRESS_INTERVAL="${DEPLOY_ALL_PROGRESS_INTERVAL:-30}"
DEPLOY_ALL_PROGRESS_TAIL="${DEPLOY_ALL_PROGRESS_TAIL:-5}"
DEPLOY_ALL_LOCK_DIR="${DEPLOY_ALL_LOCK_DIR:-${ROOT_DIR}/.cache/deploy-all.lock}"
SKIP_REASON="matched --skip"
DEPLOY_HOST_VALUE="${DEPLOY_HOST:-}"
DEPLOY_USER_VALUE="${DEPLOY_USER:-jetson}"
DEPLOY_PASSWORD_VALUE="${DEPLOY_PASSWORD:-}"
DEPLOY_PORT_VALUE="${DEPLOY_PORT:-22}"
DEPLOY_PLATFORM_EXPLICIT=0
DEPLOY_DRY_RUN=0

cleanup_deploy_lock() {
  rm -rf "${DEPLOY_ALL_LOCK_DIR}"
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

contains_value() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
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

handle_deploy_signal() {
  trap - EXIT INT TERM
  if [[ "${BATCH_PIDS+x}" == "x" && "${#BATCH_PIDS[@]}" -gt 0 ]]; then
    stop_process_trees "${BATCH_PIDS[@]}"
  fi
  cleanup_deploy_lock
  exit 130
}

acquire_deploy_lock() {
  mkdir -p "${ROOT_DIR}/.cache"

  if mkdir "${DEPLOY_ALL_LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" >"${DEPLOY_ALL_LOCK_DIR}/pid"
    : >"${DEPLOY_ALL_LOCK_DIR}/children"
    trap cleanup_deploy_lock EXIT
    trap handle_deploy_signal INT TERM
    return 0
  fi

  local lock_pid=""
  if [[ -f "${DEPLOY_ALL_LOCK_DIR}/pid" ]]; then
    lock_pid="$(cat "${DEPLOY_ALL_LOCK_DIR}/pid" 2>/dev/null || true)"
  fi

  local child_pids=()
  local child_pid
  if [[ -n "${lock_pid}" ]] && [[ "${lock_pid}" =~ ^[0-9]+$ ]] && kill -0 "${lock_pid}" 2>/dev/null && pid_matches_script "${lock_pid}" "deploy-all.sh"; then
    echo "Stopping previous deploy-all.sh run with pid ${lock_pid}."
    if [[ -f "${DEPLOY_ALL_LOCK_DIR}/children" ]]; then
      while IFS= read -r child_pid; do
        [[ "${child_pid}" =~ ^[0-9]+$ ]] && child_pids+=("${child_pid}")
      done <"${DEPLOY_ALL_LOCK_DIR}/children"
    fi
    if [[ "${#child_pids[@]}" -gt 0 ]]; then
      stop_process_trees "${lock_pid}" "${child_pids[@]}"
    else
      stop_process_trees "${lock_pid}"
    fi
  else
    echo "Removing stale deploy-all lock: ${DEPLOY_ALL_LOCK_DIR}" >&2
  fi

  rm -rf "${DEPLOY_ALL_LOCK_DIR}"
  if ! mkdir "${DEPLOY_ALL_LOCK_DIR}" 2>/dev/null; then
    echo "Could not acquire deploy-all lock: ${DEPLOY_ALL_LOCK_DIR}" >&2
    exit 3
  fi
  printf '%s\n' "$$" >"${DEPLOY_ALL_LOCK_DIR}/pid"
  : >"${DEPLOY_ALL_LOCK_DIR}/children"
  trap cleanup_deploy_lock EXIT
  trap handle_deploy_signal INT TERM
}

usage() {
  cat <<'USAGE'
Usage:
  ./deploy-all.sh --jobs <n> --host <ip-or-host> --user <ssh-user> --password <ssh-password> --domain-id <id> [options]
  ./deploy-all.sh --parallel <n> --host <ip-or-host> --user <ssh-user> --password <ssh-password> --domain-id <id> [options]
  ./deploy-all.sh --host <ip-or-host> --username <ssh-user> --password <ssh-password> --domain-id <id> [options]
  ./deploy-all.sh --install-golang --host <ip-or-host> --user <ssh-user> --password <ssh-password> --domain-id <id> [options]
  ./deploy-all.sh --skip <service[,service...]> --host <ip-or-host> --user <ssh-user> --password <ssh-password> --domain-id <id> [options]
  ./deploy-all.sh --list

Deploys every module/service entry that has a ROS2 package.xml, one package at
a time, through ./pr ros2:deploy. Do not pass --packages-select here; this
script supplies it for each service.

Most ./pr ros2:deploy options are accepted and passed through unchanged.
DEPLOY_USER and DEPLOY_PASSWORD are also supported by the underlying deploy
command. Go is not installed in deploy images by default; use --install-golang
or INSTALL_GOLANG=1 when deploying Go ROS2 services. ROS_DOMAIN_ID or
--domain-id must be specified explicitly. Use --jobs, --parallel, or
DEPLOY_ALL_JOBS to run multiple service deploys in parallel.

Options handled by deploy-all.sh:
  --skip <value>              Skip service(s). Value may be comma-separated.
  --skip-service <value>      Alias for --skip.
  --exclude <value>           Alias for --skip.

Skip values match ROS package name, full service directory, or service directory
basename, for example: --skip robo_brain,robo_follow_service.
USAGE
}

list_services() {
  load_ros2_targets
  echo "All module services:"
  local row service_dir package_name ros_distro service_env
  for row in "${ROS2_DEPLOY_TARGETS[@]}"; do
    IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"
    printf '  %s\n' "${service_dir}"
  done
  echo
  echo "Deploy targets:"
  for row in "${ROS2_DEPLOY_TARGETS[@]}"; do
    IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"
    printf '  %s -> %s [%s] %s\n' "${service_dir}" "${package_name}" "${ros_distro}" "${service_env}"
  done
}

load_ros2_targets() {
  ROS2_DEPLOY_TARGETS=()
  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] && ROS2_DEPLOY_TARGETS+=("${line}")
  done < <(node bin/ros2-projects.mjs --format=tsv)
}

print_summary() {
  local row status service_dir package_name exit_code

  echo
  echo "Deploy summary:"
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
        printf '  [SKIPPED] %s (%s), %s\n' "${service_dir}" "${package_name}" "${exit_code}"
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

add_skip_selectors() {
  local value="$1"
  local part
  local parts=()

  IFS=',' read -r -a parts <<< "${value}"
  for part in "${parts[@]}"; do
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    [[ -n "${part}" ]] && SKIP_SELECTORS+=("${part}")
  done
}

should_skip_service() {
  local service_dir="$1"
  local package_name="$2"
  local service_basename="${service_dir##*/}"
  local selector

  [[ "${#SKIP_SELECTORS[@]}" -gt 0 ]] || return 1
  for selector in "${SKIP_SELECTORS[@]}"; do
    if [[ "${package_name}" == ${selector} || "${service_dir}" == ${selector} || "${service_basename}" == ${selector} ]]; then
      return 0
    fi
  done

  return 1
}

deploy_all_ssh_exec() {
  local user_host="$1"
  local port="$2"
  local command="$3"

  if [[ -n "${DEPLOY_PASSWORD_VALUE:-}" ]]; then
    if ! command -v sshpass >/dev/null 2>&1; then
      echo "sshpass is required when using --password or DEPLOY_PASSWORD." >&2
      exit 127
    fi
    SSHPASS="${DEPLOY_PASSWORD_VALUE}" sshpass -e ssh \
      -o StrictHostKeyChecking=accept-new \
      -o PubkeyAuthentication=no \
      -o PreferredAuthentications=password \
      -o NumberOfPasswordPrompts=1 \
      -p "${port}" "${user_host}" "${command}"
    return
  fi

  ssh -p "${port}" "${user_host}" "${command}"
}

deploy_all_remote_arch_from_output() {
  local output="$1"

  printf '%s\n' "${output}" | tr -d '\r' | awk '
    {
      for (idx = 1; idx <= NF; idx += 1) {
        token = tolower($idx)
        gsub(/^[^a-z0-9_]+|[^a-z0-9_]+$/, "", token)
        if (token ~ /^(amd64|x86_64|aarch64|arm64)$/) {
          print token
          exit
        }
      }
    }
  '
}

deploy_all_remote_arch_to_platform() {
  local arch
  arch="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

  case "${arch}" in
    amd64|x86_64)
      printf 'linux/amd64\n'
      ;;
    aarch64|arm64)
      printf 'linux/arm64\n'
      ;;
    *)
      return 1
      ;;
  esac
}

add_shared_deploy_platform_if_needed() {
  if [[ "${DEPLOY_PLATFORM_EXPLICIT}" == "1" || "${DEPLOY_DRY_RUN}" == "1" || -z "${DEPLOY_HOST_VALUE}" ]]; then
    return 0
  fi

  local user_host="${DEPLOY_USER_VALUE}@${DEPLOY_HOST_VALUE}"
  local output status arch platform
  set +e
  output="$(deploy_all_ssh_exec "${user_host}" "${DEPLOY_PORT_VALUE}" "uname -m" 2>&1)"
  status="$?"
  set -e

  if [[ "${status}" -ne 0 ]]; then
    echo "Failed to connect to ${user_host} over SSH while detecting shared deploy platform." >&2
    if [[ -n "${output}" ]]; then
      printf '%s\n' "${output}" >&2
    fi
    exit "${status}"
  fi

  arch="$(deploy_all_remote_arch_from_output "${output}")"
  if [[ -z "${arch}" ]]; then
    echo "Failed to detect shared remote architecture for ${user_host}." >&2
    if [[ -n "${output}" ]]; then
      printf '%s\n' "${output}" >&2
    fi
    exit 1
  fi

  if ! platform="$(deploy_all_remote_arch_to_platform "${arch}")"; then
    echo "Unsupported shared remote architecture \"${arch}\" for ${user_host}. Pass --platform explicitly." >&2
    exit 1
  fi

  echo "Detected shared remote platform: ${arch} -> ${platform}"
  DEPLOY_ARGS+=(--platform "${platform}")
  DEPLOY_PLATFORM_EXPLICIT=1
}

start_deploy_job() {
  local service_dir="$1"
  local package_name="$2"
  local job_index="$3"
  local service_env="$4"
  local log_file="${LOG_ROOT}/${package_name}.log"
  local status_file="${LOG_ROOT}/${package_name}.status"
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

  local deploy_args=(--packages-select "${package_name}")
  if [[ "${#DEPLOY_ARGS[@]}" -gt 0 ]]; then
    deploy_args+=("${DEPLOY_ARGS[@]}")
  fi

  rm -f "${status_file}"
  (
    set +e
    printf '[%s/%s] deploy %s (%s)\n' "${job_index}" "${target_count}" "${service_dir}" "${package_name}"
    env "${env_args[@]}" ./pr ros2:deploy "${deploy_args[@]}"
    local exit_code="$?"
    printf '%s\n' "${exit_code}" >"${status_file}"
    exit "${exit_code}"
  ) >"${log_file}" 2>&1 &

  BATCH_PIDS+=("$!")
  printf '%s\n' "$!" >>"${DEPLOY_ALL_LOCK_DIR}/children" 2>/dev/null || true
  BATCH_SERVICES+=("${service_dir}")
  BATCH_PACKAGES+=("${package_name}")
  BATCH_LOGS+=("${log_file}")
  BATCH_STATUS_FILES+=("${status_file}")

  printf '  [RUNNING] %s (%s), log=%s\n' "${service_dir}" "${package_name}" "${log_file}"
}

flush_deploy_batch() {
  local i pid service_dir package_name log_file status_file exit_code remaining now last_progress
  local batch_done=()

  remaining="${#BATCH_PIDS[@]}"
  last_progress=0
  for i in "${!BATCH_PIDS[@]}"; do
    batch_done[$i]=0
  done

  while [[ "${remaining}" -gt 0 ]]; do
    for i in "${!BATCH_PIDS[@]}"; do
      [[ "${batch_done[$i]}" == "1" ]] && continue

      pid="${BATCH_PIDS[$i]}"
      service_dir="${BATCH_SERVICES[$i]}"
      package_name="${BATCH_PACKAGES[$i]}"
      log_file="${BATCH_LOGS[$i]}"
      status_file="${BATCH_STATUS_FILES[$i]}"

      if [[ ! -f "${status_file}" ]]; then
        continue
      fi

      exit_code="$(cat "${status_file}")"
      wait "${pid}" 2>/dev/null || true
      batch_done[$i]=1
      remaining=$((remaining - 1))

      if [[ "${exit_code}" == "0" ]]; then
        SUCCESS_RESULTS+=("${service_dir}")
        RESULT_ROWS+=("SUCCESS|${service_dir}|${package_name}|0")
        printf '  [SUCCESS] %s (%s), log=%s\n' "${service_dir}" "${package_name}" "${log_file}"
      else
        FAILED_RESULTS+=("${service_dir}")
        RESULT_ROWS+=("FAILED|${service_dir}|${package_name}|${exit_code}")
        printf '  [FAILED]  %s (%s), exit=%s, log=%s\n' "${service_dir}" "${package_name}" "${exit_code}" "${log_file}"
      fi
    done

    if [[ "${remaining}" -le 0 ]]; then
      break
    fi

    now="$(date +%s)"
    if [[ $((now - last_progress)) -ge "${DEPLOY_ALL_PROGRESS_INTERVAL}" ]]; then
      last_progress="${now}"
      print_running_deploys "${batch_done[@]}"
    fi

    sleep 2
  done

  BATCH_PIDS=()
  BATCH_SERVICES=()
  BATCH_PACKAGES=()
  BATCH_LOGS=()
  BATCH_STATUS_FILES=()
}

print_running_deploys() {
  local batch_done=("$@")
  local i service_dir package_name log_file

  for i in "${!BATCH_PIDS[@]}"; do
    [[ "${batch_done[$i]}" == "1" ]] && continue

    service_dir="${BATCH_SERVICES[$i]}"
    package_name="${BATCH_PACKAGES[$i]}"
    log_file="${BATCH_LOGS[$i]}"
    printf '  [RUNNING] %s (%s), log=%s\n' "${service_dir}" "${package_name}" "${log_file}"
    if [[ -s "${log_file}" ]]; then
      tail -n "${DEPLOY_ALL_PROGRESS_TAIL}" "${log_file}" | sed 's/^/    | /'
    fi
  done
}

case "${1:-}" in
  -h|--help|"")
    usage
    exit 0
    ;;
  --list)
    list_services
    exit 0
    ;;
esac

DEPLOY_ARGS=()
SKIP_SELECTORS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --packages-select|--packages-select=*|--package|--package=*)
      echo "deploy-all.sh supplies --packages-select for each service; remove $1." >&2
      exit 2
      ;;
    --user|--username)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "$1 requires a value." >&2
        exit 2
      fi
      DEPLOY_USER_VALUE="$2"
      DEPLOY_ARGS+=(--user "$2")
      shift 2
      ;;
    --user=*)
      DEPLOY_USER_VALUE="${1#--user=}"
      DEPLOY_ARGS+=(--user "${DEPLOY_USER_VALUE}")
      shift
      ;;
    --username=*)
      DEPLOY_USER_VALUE="${1#--username=}"
      DEPLOY_ARGS+=(--user "${DEPLOY_USER_VALUE}")
      shift
      ;;
    --host)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--host requires a value." >&2
        exit 2
      fi
      DEPLOY_HOST_VALUE="$2"
      DEPLOY_ARGS+=(--host "$2")
      shift 2
      ;;
    --host=*)
      DEPLOY_HOST_VALUE="${1#--host=}"
      DEPLOY_ARGS+=(--host "${DEPLOY_HOST_VALUE}")
      shift
      ;;
    --password)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--password requires a value." >&2
        exit 2
      fi
      DEPLOY_PASSWORD_VALUE="$2"
      DEPLOY_ARGS+=(--password "$2")
      shift 2
      ;;
    --password=*)
      DEPLOY_PASSWORD_VALUE="${1#--password=}"
      DEPLOY_ARGS+=(--password "${DEPLOY_PASSWORD_VALUE}")
      shift
      ;;
    --port)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--port requires a value." >&2
        exit 2
      fi
      DEPLOY_PORT_VALUE="$2"
      DEPLOY_ARGS+=(--port "$2")
      shift 2
      ;;
    --port=*)
      DEPLOY_PORT_VALUE="${1#--port=}"
      DEPLOY_ARGS+=(--port "${DEPLOY_PORT_VALUE}")
      shift
      ;;
    --platform)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--platform requires a value." >&2
        exit 2
      fi
      DEPLOY_PLATFORM_EXPLICIT=1
      DEPLOY_ARGS+=(--platform "$2")
      shift 2
      ;;
    --platform=*)
      DEPLOY_PLATFORM_EXPLICIT=1
      DEPLOY_ARGS+=(--platform "${1#--platform=}")
      shift
      ;;
    --dry-run)
      DEPLOY_DRY_RUN=1
      DEPLOY_ARGS+=(--dry-run)
      shift
      ;;
    --domain-id|--ros-domain-id)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "$1 requires a value." >&2
        exit 2
      fi
      DEPLOY_DOMAIN_ID="$2"
      shift 2
      ;;
    --domain-id=*)
      DEPLOY_DOMAIN_ID="${1#--domain-id=}"
      shift
      ;;
    --ros-domain-id=*)
      DEPLOY_DOMAIN_ID="${1#--ros-domain-id=}"
      shift
      ;;
    --jobs|-j|--parallel)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "$1 requires a value." >&2
        exit 2
      fi
      DEPLOY_ALL_JOBS="$2"
      shift 2
      ;;
    --jobs=*|-j=*|--parallel=*)
      DEPLOY_ALL_JOBS="${1#*=}"
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
    --skip|--skip-service|--skip-services|--exclude|--exclude-service|--exclude-services)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "$1 requires a value." >&2
        exit 2
      fi
      add_skip_selectors "$2"
      shift 2
      ;;
    --skip=*|--skip-service=*|--skip-services=*|--exclude=*|--exclude-service=*|--exclude-services=*)
      add_skip_selectors "${1#*=}"
      shift
      ;;
    *)
      DEPLOY_ARGS+=("$1")
      shift
      ;;
  esac
done

validate_jobs "${DEPLOY_ALL_JOBS}"
load_ros2_targets
acquire_deploy_lock

if [[ -z "${DEPLOY_DOMAIN_ID}" ]]; then
  echo "deploy-all.sh requires --domain-id <id> or ROS_DOMAIN_ID=<id>." >&2
  exit 2
fi

if [[ ! "${DEPLOY_DOMAIN_ID}" =~ ^[0-9]+$ ]]; then
  echo "--domain-id must be a non-negative integer: ${DEPLOY_DOMAIN_ID}" >&2
  exit 2
fi

DEPLOY_ARGS+=(--domain-id "${DEPLOY_DOMAIN_ID}")
add_shared_deploy_platform_if_needed

target_count="${#ROS2_DEPLOY_TARGETS[@]}"
index=1
SUCCESS_RESULTS=()
FAILED_RESULTS=()
SKIPPED_RESULTS=()
RESULT_ROWS=()
BATCH_PIDS=()
BATCH_SERVICES=()
BATCH_PACKAGES=()
BATCH_LOGS=()
BATCH_STATUS_FILES=()
LOG_ROOT="log/deploy-all/$(date +%Y%m%d-%H%M%S)"
mkdir -p "${LOG_ROOT}"
echo "Deploy jobs: ${DEPLOY_ALL_JOBS}"
echo "Deploy logs: ${LOG_ROOT}"
if [[ "${#SKIP_SELECTORS[@]}" -gt 0 ]]; then
  printf 'Skip services: %s\n' "${SKIP_SELECTORS[*]}"
fi

for row in "${ROS2_DEPLOY_TARGETS[@]}"; do
  IFS=$'\t' read -r service_dir package_name ros_distro service_env <<< "${row}"

  if should_skip_service "${service_dir}" "${package_name}"; then
    SKIPPED_RESULTS+=("${service_dir}")
    RESULT_ROWS+=("SKIPPED|${service_dir}|${package_name}|${SKIP_REASON}")
    printf '  [SKIPPED] %s (%s), %s\n' "${service_dir}" "${package_name}" "${SKIP_REASON}"
    index=$((index + 1))
    continue
  fi

  start_deploy_job "${service_dir}" "${package_name}" "${index}" "${service_env}"
  if [[ "${#BATCH_PIDS[@]}" -ge "${DEPLOY_ALL_JOBS}" ]]; then
    flush_deploy_batch
  fi
  index=$((index + 1))
done

flush_deploy_batch
print_summary

if [[ "${#FAILED_RESULTS[@]}" -gt 0 ]]; then
  exit 1
fi
