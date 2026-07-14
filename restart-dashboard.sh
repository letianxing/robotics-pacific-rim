#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="${ROOT_DIR}/dashboard"
DASHBOARD_WEB_DIR="${DASHBOARD_DIR}/apps/web"
RUNTIME_DIR="${DASHBOARD_DIR}/tmp"
PID_FILE="${RUNTIME_DIR}/dashboard.pid"
LOG_FILE="${RUNTIME_DIR}/dashboard.log"
HOST="${DASHBOARD_HOST:-127.0.0.1}"
PORT="${DASHBOARD_PORT:-13630}"
NEXT_DEV_LOCK_FILE="${DASHBOARD_WEB_DIR}/.next/dev/lock"

DAEMON_MODE=0
OPEN_BROWSER="${DASHBOARD_OPEN_BROWSER:-1}"
EXTRA_ARGS=()
NEXT_EXTRA_ARGS=()

usage() {
    cat <<'EOF'
Usage: ./restart-dashboard.sh [options] [-- extra Next.js args]

Options:
  -d, --daemon       Run in background mode
  -f, --foreground   Run in foreground mode (default)
      --open         Open the dashboard URL in the default browser (default)
      --no-open      Do not open the browser
  -h, --help         Show this help message

Examples:
  ./restart-dashboard.sh
  ./restart-dashboard.sh -d
EOF
}

while (($# > 0)); do
    case "$1" in
        -d|--daemon)
            DAEMON_MODE=1
            shift
            ;;
        -f|--foreground)
            DAEMON_MODE=0
            shift
            ;;
        --open)
            OPEN_BROWSER=1
            shift
            ;;
        --no-open)
            OPEN_BROWSER=0
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            EXTRA_ARGS+=("$@")
            break
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

update_address_from_extra_args() {
    local index
    local value
    local next

    for ((index = 0; index < ${#EXTRA_ARGS[@]}; index++)); do
        value="${EXTRA_ARGS[$index]}"

        case "${value}" in
            --hostname=*)
                HOST="${value#--hostname=}"
                ;;
            -H=*)
                HOST="${value#-H=}"
                ;;
            --hostname|-H)
                next="${EXTRA_ARGS[$((index + 1))]:-}"
                if [[ -n "${next}" ]]; then
                    HOST="${next}"
                    index=$((index + 1))
                fi
                ;;
            --port=*)
                PORT="${value#--port=}"
                ;;
            -p=*)
                PORT="${value#-p=}"
                ;;
            --port|-p)
                next="${EXTRA_ARGS[$((index + 1))]:-}"
                if [[ -n "${next}" ]]; then
                    PORT="${next}"
                    index=$((index + 1))
                fi
                ;;
            *)
                NEXT_EXTRA_ARGS+=("${value}")
                ;;
        esac
    done
}

display_host() {
    if [[ "${HOST}" == "0.0.0.0" ]] || [[ "${HOST}" == "::" ]]; then
        printf 'localhost'
        return
    fi

    printf '%s' "${HOST}"
}

dashboard_url() {
    printf 'http://%s:%s' "$(display_host)" "${PORT}"
}

browser_open_enabled() {
    case "${OPEN_BROWSER}" in
        0|false|False|FALSE|no|No|NO|off|Off|OFF)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

wait_for_dashboard() {
    local url="$1"

    if ! command -v curl >/dev/null 2>&1; then
        sleep 1
        return
    fi

    for _ in {1..80}; do
        if curl -fsS -o /dev/null "${url}" 2>/dev/null; then
            return
        fi
        sleep 0.25
    done
}

open_url() {
    local url="$1"

    if command -v open >/dev/null 2>&1; then
        open "${url}"
        return
    fi

    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${url}"
        return
    fi

    if command -v wslview >/dev/null 2>&1; then
        wslview "${url}"
        return
    fi

    return 1
}

schedule_browser_open() {
    if ! browser_open_enabled; then
        return
    fi

    local url
    url="$(dashboard_url)"
    echo "Opening browser: ${url}"
    (
        wait_for_dashboard "${url}"
        if ! open_url "${url}" >/dev/null 2>&1; then
            echo "WARN: could not open browser for ${url}" >&2
        fi
    ) &
}

update_address_from_extra_args

if [[ ! "${PORT}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: invalid dashboard port: ${PORT}" >&2
    exit 1
fi

mkdir -p "${RUNTIME_DIR}"

stop_pid_file_process() {
    if [[ ! -f "${PID_FILE}" ]]; then
        return
    fi

    local pid
    pid="$(cat "${PID_FILE}")"
    if [[ -z "${pid}" ]]; then
        rm -f "${PID_FILE}"
        return
    fi

    if kill -0 "${pid}" 2>/dev/null; then
        echo "Stopping existing dashboard process: ${pid}"
        kill "${pid}" 2>/dev/null || true

        for _ in {1..20}; do
            if ! kill -0 "${pid}" 2>/dev/null; then
                break
            fi
            sleep 0.25
        done

        if kill -0 "${pid}" 2>/dev/null; then
            echo "Force killing unresponsive dashboard process: ${pid}"
            kill -9 "${pid}" 2>/dev/null || true
        fi
    fi

    rm -f "${PID_FILE}"
}

stop_port_listener() {
    local port="$1"

    if ! command -v lsof >/dev/null 2>&1; then
        echo "WARN: lsof not found; skipping listener cleanup for port ${port}"
        return
    fi

    local pids
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [[ -z "${pids}" ]]; then
        return
    fi

    for pid in ${pids}; do
        if ! kill -0 "${pid}" 2>/dev/null; then
            continue
        fi

        echo "Stopping process ${pid} using port ${port}"
        kill "${pid}" 2>/dev/null || true

        for _ in {1..20}; do
            if ! kill -0 "${pid}" 2>/dev/null; then
                break
            fi
            sleep 0.25
        done

        if kill -0 "${pid}" 2>/dev/null; then
            echo "Force killing process ${pid} using port ${port}"
            kill -9 "${pid}" 2>/dev/null || true
        fi
    done
}

stop_next_dev_lock_process() {
    if [[ ! -f "${NEXT_DEV_LOCK_FILE}" ]]; then
        return
    fi

    local pid
    pid="$(node -e '
const fs = require("node:fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (Number.isInteger(data.pid)) {
    process.stdout.write(String(data.pid));
  }
} catch {}
' "${NEXT_DEV_LOCK_FILE}")"

    if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
        return
    fi

    local command_line
    command_line="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if [[ "${command_line}" != *"next"* ]]; then
        return
    fi

    echo "Stopping existing dashboard Next dev process: ${pid}"
    kill "${pid}" 2>/dev/null || true

    for _ in {1..20}; do
        if ! kill -0 "${pid}" 2>/dev/null; then
            break
        fi
        sleep 0.25
    done

    if kill -0 "${pid}" 2>/dev/null; then
        echo "Force killing dashboard Next dev process: ${pid}"
        kill -9 "${pid}" 2>/dev/null || true
    fi
}

set_next_dev_command_args() {
    NEXT_DEV_COMMAND_ARGS=("npm" "exec" "--" "next" "dev" "--hostname" "${HOST}" "--port" "${PORT}")
    if ((${#NEXT_EXTRA_ARGS[@]} > 0)); then
        NEXT_DEV_COMMAND_ARGS+=("${NEXT_EXTRA_ARGS[@]}")
    fi
}

start_foreground() {
    echo "Starting dashboard in foreground mode"
    echo "Dashboard URL: $(dashboard_url)"
    cd "${DASHBOARD_WEB_DIR}"
    set_next_dev_command_args
    schedule_browser_open
    exec "${NEXT_DEV_COMMAND_ARGS[@]}"
}

start_background() {
    echo "Starting dashboard in background mode"
    echo "Dashboard URL: $(dashboard_url)"
    echo "Log file: ${LOG_FILE}"
    cd "${DASHBOARD_WEB_DIR}"
    set_next_dev_command_args
    nohup "${NEXT_DEV_COMMAND_ARGS[@]}" >"${LOG_FILE}" 2>&1 &
    local pid=$!
    echo "${pid}" > "${PID_FILE}"
    echo "Started dashboard with PID ${pid}"

    sleep 0.5
    if ! kill -0 "${pid}" 2>/dev/null; then
        rm -f "${PID_FILE}"
        echo "ERROR: dashboard process exited during startup. See ${LOG_FILE}" >&2
        return 1
    fi

    schedule_browser_open
}

if [[ ! -d "${DASHBOARD_DIR}" ]]; then
    echo "ERROR: dashboard directory not found: ${DASHBOARD_DIR}" >&2
    exit 1
fi

if [[ ! -d "${DASHBOARD_WEB_DIR}" ]]; then
    echo "ERROR: dashboard web app directory not found: ${DASHBOARD_WEB_DIR}" >&2
    exit 1
fi

stop_pid_file_process
stop_port_listener "${PORT}"
stop_next_dev_lock_process

if ((DAEMON_MODE)); then
    start_background
else
    start_foreground
fi
