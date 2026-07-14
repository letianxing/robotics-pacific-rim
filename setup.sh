#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
ROOT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
DASHBOARD_DIR="${ROOT_DIR}/dashboard"
MONITOR_DIR="${ROOT_DIR}/monitor/pr-monitor"
DASHBOARD_POSTGRES_PORT="${DASHBOARD_POSTGRES_PORT:-10532}"
GO_VERSION="${GO_VERSION:-1.26.4}"
GO_INSTALL_DIR="${GO_INSTALL_DIR:-/usr/local/go}"
NODE_MAJOR_VERSION="22"

required_failures=0
warnings=0
install_system=1
skip_install=0
skip_dashboard=0
skip_db=0
ci_mode=0
assume_yes=0

supports_color() {
  [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]]
}

print_status() {
  local level="$1"
  local message="$2"

  if supports_color; then
    case "${level}" in
      OK) printf '\033[32m[OK]\033[0m %s\n' "${message}" ;;
      WARN) printf '\033[33m[WARN]\033[0m %s\n' "${message}" ;;
      FAIL) printf '\033[31m[FAIL]\033[0m %s\n' "${message}" ;;
      INFO) printf '\033[36m[INFO]\033[0m %s\n' "${message}" ;;
      *) printf '[%s] %s\n' "${level}" "${message}" ;;
    esac
    return
  fi

  printf '[%s] %s\n' "${level}" "${message}"
}

ok() {
  print_status "OK" "$1"
}

info() {
  print_status "INFO" "$1"
}

warn() {
  warnings=$((warnings + 1))
  print_status "WARN" "$1"
}

fail() {
  required_failures=$((required_failures + 1))
  print_status "FAIL" "$1"
}

usage() {
  cat <<'USAGE'
Usage:
  ./setup.sh [options]

Options:
  --install-system     Install missing system tools when supported. This is the default outside CI.
  --no-install-system  Only check system tools; do not install missing ones.
  --skip-install       Do not run npm install/npm ci.
  --skip-dashboard     Skip dashboard dependency and env setup.
  --skip-db            Do not start/push the optional dashboard Postgres database.
  --ci                 Non-interactive mode; implies --skip-db.
  -y, --yes            Answer yes to supported prompts.
  -h, --help           Show this help.

Default behavior:
  - installs missing system tools when supported,
  - installs Node.js 22 from NodeSource on apt-based Linux when missing,
  - installs Go 1.26.4 from official Go downloads only when Go is missing,
  - checks required tools,
  - installs root npm dependencies,
  - installs dashboard npm dependencies,
  - updates ./pr and ./pr.cmd,
  - writes local dashboard env files only when missing.
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --install-system)
        install_system=1
        ;;
      --no-install-system)
        install_system=0
        ;;
      --skip-install)
        skip_install=1
        ;;
      --skip-dashboard)
        skip_dashboard=1
        ;;
      --skip-db)
        skip_db=1
        ;;
      --ci)
        ci_mode=1
        skip_db=1
        install_system=0
        ;;
      -y|--yes)
        assume_yes=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        printf 'Unknown option: %s\n\n' "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

restore_sudo_workspace_ownership() {
  if [[ "${setup_ran_with_sudo:-0}" -ne 1 ]] || [[ -z "${sudo_workspace_user:-}" ]]; then
    return
  fi

  print_status "INFO" "Restoring workspace ownership to ${sudo_workspace_user}:${sudo_workspace_group}"
  if ! chown -R "${sudo_workspace_user}:${sudo_workspace_group}" "${ROOT_DIR}"; then
    print_status "WARN" "Failed to restore workspace ownership. Run: sudo chown -R ${sudo_workspace_user}:${sudo_workspace_group} \"${ROOT_DIR}\""
  fi
}

setup_sudo_workspace_ownership_restore() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]] || [[ -z "${SUDO_USER:-}" ]]; then
    return
  fi

  setup_ran_with_sudo=1
  sudo_workspace_user="${SUDO_USER}"
  sudo_workspace_group="$(id -gn "${SUDO_USER}" 2>/dev/null || printf '%s' "${SUDO_USER}")"

  info "Running under sudo; workspace files will be restored to ${sudo_workspace_user}:${sudo_workspace_group} on exit."
  trap 'setup_exit_code=$?; restore_sudo_workspace_ownership; exit "${setup_exit_code}"' EXIT
}

detect_os() {
  local kernel
  kernel="$(uname -s 2>/dev/null || printf 'unknown')"

  case "${kernel}" in
    Darwin*) printf 'mac' ;;
    Linux*)
      if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
        printf 'windows-wsl'
      else
        printf 'linux'
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
    *) printf 'unknown' ;;
  esac
}

command_version() {
  local command_name="$1"
  shift

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    return 1
  fi

  "${command_name}" "$@" 2>/dev/null | head -n 1
}

ask_yes_no() {
  local prompt="$1"

  if [[ "${assume_yes}" -eq 1 ]]; then
    return 0
  fi

  if [[ "${ci_mode}" -eq 1 ]] || [[ ! -t 0 ]]; then
    return 1
  fi

  local answer
  read -r -p "${prompt} [y/N] " answer
  case "${answer}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

prepend_path_if_dir() {
  local dir="$1"
  if [[ -d "${dir}" ]]; then
    case ":${PATH}:" in
      *":${dir}:"*) ;;
      *) export PATH="${dir}:${PATH}" ;;
    esac
  fi
}

apt_package_available() {
  local package_name="$1"
  apt-cache show "${package_name}" >/dev/null 2>&1
}

append_apt_package_if_available() {
  local package_name="$1"
  shift
  local -n target_packages="$1"

  if apt_package_available "${package_name}"; then
    target_packages+=("${package_name}")
    return 0
  fi

  return 1
}

go_version_matches() {
  local expected="go${GO_VERSION}"
  local current=""

  if ! command -v go >/dev/null 2>&1; then
    return 1
  fi

  current="$(go version 2>/dev/null | awk '{print $3}')"
  [[ "${current}" == "${expected}" ]]
}

go_download_os() {
  case "$(detect_os)" in
    mac) printf 'darwin' ;;
    linux|windows-wsl) printf 'linux' ;;
    windows) printf 'windows' ;;
    *)
      return 1
      ;;
  esac
}

go_download_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *)
      return 1
      ;;
  esac
}

go_download_ext() {
  case "$1" in
    linux) printf 'tar.gz' ;;
    darwin) printf 'pkg' ;;
    windows) printf 'msi' ;;
    *)
      return 1
      ;;
  esac
}

go_download_filename() {
  local go_os="$1"
  local go_arch="$2"
  local ext="$3"
  printf 'go%s.%s-%s.%s' "${GO_VERSION}" "${go_os}" "${go_arch}" "${ext}"
}

go_download_sha256() {
  local go_os="$1"
  local go_arch="$2"

  case "${GO_VERSION}:${go_os}:${go_arch}" in
    1.26.4:linux:amd64) printf '1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f' ;;
    1.26.4:linux:arm64) printf 'ef758ae7c6cf9267c9c0ef080b8965f453d89ab2d25d9eb22de4405925238768' ;;
    1.26.4:darwin:amd64) printf '47b07b6e7515ec724f6d5015d7d5339e2b6467a9667d4029c8b7077b83f3fafe' ;;
    1.26.4:darwin:arm64) printf '9d35ecdcc142f3f2b9010b495ee0051e64ccd7bcf340d3c1258fe2ceb1026c87' ;;
    1.26.4:windows:amd64) printf '55902c036634c7ab3159cf259af692abc86989aaefcc7f75bef888f3263031c4' ;;
    1.26.4:windows:arm64) printf 'b87863733cd87624387ee61307a5ebaf405351bf4035a3aa7744c26a785a3d3e' ;;
    *)
      return 1
      ;;
  esac
}

verify_sha256() {
  local expected="$1"
  local path="$2"

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${expected}" "${path}" | sha256sum -c -
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    local actual
    actual="$(shasum -a 256 "${path}" | awk '{print $1}')"
    [[ "${actual}" == "${expected}" ]]
    return
  fi

  warn "No SHA256 verifier found; install sha256sum or shasum before automatic Go installation."
  return 1
}

windows_path() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "${path}"
  else
    printf '%s' "${path}"
  fi
}

prepend_windows_go_path() {
  prepend_path_if_dir "/c/Program Files/Go/bin"
  prepend_path_if_dir "/cygdrive/c/Program Files/Go/bin"
}

install_go() {
  local current_go_version=""
  if current_go_version="$(command_version go version)"; then
    ok "Go already installed: ${current_go_version}"
    return
  fi

  local go_os go_arch ext archive checksum tmp_dir archive_path
  if ! go_os="$(go_download_os)" ||
     ! go_arch="$(go_download_arch)" ||
     ! ext="$(go_download_ext "${go_os}")" ||
     ! checksum="$(go_download_sha256 "${go_os}" "${go_arch}")"; then
    warn "Automatic Go ${GO_VERSION} install supports Linux, macOS, and Windows on amd64 and arm64 only."
    return
  fi

  archive="$(go_download_filename "${go_os}" "${go_arch}" "${ext}")"
  tmp_dir="$(mktemp -d)"
  archive_path="${tmp_dir}/${archive}"
  info "Installing Go ${GO_VERSION} from https://go.dev/dl/${archive}."
  curl -fsSL "https://go.dev/dl/${archive}" -o "${archive_path}"
  verify_sha256 "${checksum}" "${archive_path}"

  case "${go_os}" in
    linux)
      sudo rm -rf "${GO_INSTALL_DIR}"
      sudo tar -C "$(dirname "${GO_INSTALL_DIR}")" -xzf "${archive_path}"
      sudo ln -sf "${GO_INSTALL_DIR}/bin/go" /usr/local/bin/go
      sudo ln -sf "${GO_INSTALL_DIR}/bin/gofmt" /usr/local/bin/gofmt
      prepend_path_if_dir "${GO_INSTALL_DIR}/bin"
      ;;
    darwin)
      sudo installer -pkg "${archive_path}" -target /
      prepend_path_if_dir "${GO_INSTALL_DIR}/bin"
      ;;
    windows)
      if ! command -v msiexec.exe >/dev/null 2>&1; then
        warn "msiexec.exe was not found. Install ${archive} manually from https://go.dev/dl/."
        rm -rf "${tmp_dir}"
        return
      fi
      MSYS2_ARG_CONV_EXCL="*" msiexec.exe /i "$(windows_path "${archive_path}")" /qn /norestart
      prepend_windows_go_path
      ;;
  esac

  rm -rf "${tmp_dir}"
  if go_version_matches; then
    ok "Go installed: $(go version)"
  else
    warn "Go installer finished, but go${GO_VERSION} is not first on PATH yet. Open a new shell or update PATH."
  fi
}

use_homebrew_node22() {
  local node22_prefix=""
  node22_prefix="$(brew --prefix node@22 2>/dev/null || true)"
  if [[ -n "${node22_prefix}" ]]; then
    prepend_path_if_dir "${node22_prefix}/bin"
    info "Using Homebrew node@22 from ${node22_prefix}/bin for this setup run."
  fi
}

install_mac_tools() {
  if command -v brew >/dev/null 2>&1; then
    local packages=()
    local node_major=""
    command -v git >/dev/null 2>&1 || packages+=(git)
    if command -v node >/dev/null 2>&1; then
      node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    fi
    [[ "${node_major}" == "22" ]] || packages+=(node@22)
    command -v bun >/dev/null 2>&1 || packages+=(bun)

    if [[ "${#packages[@]}" -gt 0 ]]; then
      info "Installing Homebrew packages: ${packages[*]}"
      brew install "${packages[@]}"
    fi

    use_homebrew_node22
  else
    warn "Homebrew was not found. Skipping automatic install for Git, Node.js, Bun, and Docker Desktop."
    printf '      Install Homebrew from https://brew.sh, then rerun ./setup.sh for full macOS auto-install.\n'
  fi

  install_go

  if command -v brew >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
    info "Installing Docker Desktop with Homebrew Cask."
    brew install --cask docker
    warn "Start Docker Desktop after setup finishes, then rerun './setup.sh' if Docker daemon checks still warn."
  fi
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || return 1
}

node22_available() {
  local node_major=""
  if node_major="$(node_major_version)"; then
    [[ "${node_major}" == "${NODE_MAJOR_VERSION}" ]]
    return
  fi

  return 1
}

install_linux_node22() {
  if node22_available; then
    ok "Node.js already installed: $(node -v)"
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    sudo apt-get install -y ca-certificates curl gnupg
  fi

  info "Installing Node.js ${NODE_MAJOR_VERSION} from NodeSource."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_VERSION}.x" | sudo -E bash -
  sudo apt-get install -y nodejs

  if node22_available; then
    ok "Node.js installed: $(node -v)"
  else
    warn "Node.js installer finished, but Node.js ${NODE_MAJOR_VERSION} is not first on PATH yet. Open a new shell or update PATH."
  fi
}

install_linux_tools() {
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "Automatic Linux system install currently supports apt-get only."
    return
  fi

  info "Refreshing apt package metadata."
  sudo apt-get update

  local packages=()
  command -v git >/dev/null 2>&1 || packages+=(git)
  command -v curl >/dev/null 2>&1 || packages+=(curl)
  command -v docker >/dev/null 2>&1 || packages+=(docker.io)

  local compose_version=""
  if command -v docker >/dev/null 2>&1; then
    compose_version="$(docker compose version 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "${compose_version}" ]]; then
    if ! append_apt_package_if_available docker-compose-plugin packages &&
       ! append_apt_package_if_available docker-compose-v2 packages &&
       ! append_apt_package_if_available docker-compose packages; then
      warn "No apt Docker Compose v2 package was found. Install Docker Compose v2 manually if 'docker compose' is still unavailable."
    fi
  fi

  if [[ "${#packages[@]}" -gt 0 ]]; then
    info "Installing missing apt packages: ${packages[*]}"
    sudo apt-get install -y ca-certificates gnupg "${packages[@]}"
  fi

  install_linux_node22

  install_go

  if ! command -v bun >/dev/null 2>&1; then
    info "Installing Bun with the official installer."
    curl -fsSL https://bun.sh/install | bash
    prepend_path_if_dir "${HOME}/.bun/bin"
    if command -v bun >/dev/null 2>&1; then
      ok "Bun installed: $(bun --version)"
    else
      warn "Bun installer finished, but bun is not on PATH yet. Open a new shell or add ${HOME}/.bun/bin to PATH."
    fi
  fi
}

install_windows_notes() {
  install_go
  warn "Automatic Windows shell setup only installs Go. Install Git, Node.js 22, Bun, and Docker Desktop manually, then rerun ./setup.sh."
}

install_system_tools() {
  local os_name
  os_name="$(detect_os)"

  case "${os_name}" in
    mac) install_mac_tools ;;
    linux|windows-wsl) install_linux_tools ;;
    windows) install_windows_notes ;;
    *) warn "Unknown OS. Install Git, Node.js 22, npm, Bun, Go, and Docker manually." ;;
  esac
}

check_os() {
  local os_name
  os_name="$(detect_os)"

  case "${os_name}" in
    mac) ok "OS: macOS" ;;
    linux) ok "OS: Linux" ;;
    windows) ok "OS: Windows shell" ;;
    windows-wsl) ok "OS: Windows via WSL" ;;
    *) warn "OS: unknown. setup.sh supports macOS, Linux, WSL, Git Bash, MSYS, and Cygwin." ;;
  esac
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    warn "Node.js ${NODE_MAJOR_VERSION} was not found. npm-backed commands need Node."
    return
  fi

  local node_version
  node_version="$(node -p 'process.versions.node' 2>/dev/null || node -v | sed 's/^v//')"
  local node_major="${node_version%%.*}"

  if [[ "${node_major}" == "${NODE_MAJOR_VERSION}" ]]; then
    ok "Node.js: v${node_version}"
  else
    warn "Node.js ${NODE_MAJOR_VERSION} is expected for project commands; found v${node_version}."
  fi
}

check_npm() {
  local npm_version
  if npm_version="$(command_version npm --version)"; then
    ok "npm: ${npm_version}"
  else
    fail "npm was not found. Install Node.js/npm, then rerun ./setup.sh."
  fi
}

check_bun() {
  local bun_version
  if bun_version="$(command_version bun --version)"; then
    ok "Bun: ${bun_version}"
  else
    fail "Bun is required to compile ./pr. Install Bun, then rerun ./setup.sh."
  fi
}

check_git() {
  local git_version
  if git_version="$(command_version git --version)"; then
    ok "${git_version}"
  else
    warn "git was not found. Repository workflows will be limited."
  fi
}

check_go() {
  local go_version
  if go_version="$(command_version go version)"; then
    if go_version_matches; then
      ok "${go_version}"
    else
      warn "${go_version} (expected go${GO_VERSION})"
    fi
  else
    warn "Go ${GO_VERSION} was not found. ./pr test:go will not work until Go is installed."
  fi
}

check_docker() {
  local docker_version
  if ! docker_version="$(command_version docker --version)"; then
    warn "Docker CLI was not found. ROS2, observability, and optional dashboard database commands need Docker."
    return
  fi

  ok "${docker_version}"

  if docker ps >/dev/null 2>&1; then
    ok "Docker daemon: running"
  else
    warn "Docker daemon is not reachable. Start Docker Desktop or the docker service before ROS2/observability/optional dashboard database commands."
  fi

  local compose_version
  compose_version="$(docker compose version 2>/dev/null | head -n 1 || true)"
  if [[ -n "${compose_version}" ]]; then
    ok "${compose_version}"
  else
    warn "Docker Compose v2 was not found. scripts/ros2-docker.sh and optional dashboard database commands require 'docker compose'."
  fi
}

check_project_files() {
  if [[ -f "${ROOT_DIR}/package.json" ]]; then
    ok "package.json found"
  else
    fail "package.json was not found in ${ROOT_DIR}."
  fi

  if [[ -f "${ROOT_DIR}/package-lock.json" ]]; then
    ok "package-lock.json found"
  else
    warn "package-lock.json was not found. Falling back to npm install."
  fi

  if [[ "${skip_dashboard}" -eq 0 ]]; then
    if [[ -f "${DASHBOARD_DIR}/package.json" ]]; then
      ok "dashboard/package.json found"
    else
      warn "dashboard/package.json was not found. Dashboard setup will be skipped."
      skip_dashboard=1
    fi
  fi

  if [[ -f "${MONITOR_DIR}/package.json" ]]; then
    ok "monitor/pr-monitor/package.json found"
  else
    warn "monitor/pr-monitor/package.json was not found. Monitor dependency setup will be skipped."
  fi
}

npm_install_in() {
  local dir="$1"
  local label="$2"

  if ! command -v npm >/dev/null 2>&1; then
    fail "npm is required to install ${label} dependencies."
    return
  fi

  if [[ -f "${dir}/package-lock.json" ]]; then
    info "Installing ${label} dependencies with npm ci."
    (cd "${dir}" && HUSKY=0 npm ci)
  else
    info "Installing ${label} dependencies with npm install."
    (cd "${dir}" && HUSKY=0 npm install)
  fi
}

install_project_dependencies() {
  if [[ "${skip_install}" -eq 1 ]]; then
    info "Skipping npm dependency installation."
    return
  fi

  npm_install_in "${ROOT_DIR}" "root"

  if [[ -f "${MONITOR_DIR}/package.json" ]]; then
    npm_install_in "${MONITOR_DIR}" "pr-monitor"
  fi

  if [[ "${skip_dashboard}" -eq 0 ]]; then
    npm_install_in "${DASHBOARD_DIR}" "dashboard"
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  date +%s | shasum -a 256 | awk '{print $1}'
}

relative_path() {
  local path="$1"
  case "${path}" in
    "${ROOT_DIR}/"*) printf '%s' "${path#"${ROOT_DIR}/"}" ;;
    *) printf '%s' "${path}" ;;
  esac
}

write_file_if_missing() {
  local path="$1"
  local content="$2"

  if [[ -f "${path}" ]]; then
    ok "$(relative_path "${path}") exists"
    return
  fi

  mkdir -p "$(dirname "${path}")"
  printf '%s\n' "${content}" > "${path}"
  ok "Created $(relative_path "${path}")"
}

ensure_env_kv() {
  local path="$1"
  local key="$2"
  local value="$3"

  mkdir -p "$(dirname "${path}")"

  if [[ ! -f "${path}" ]]; then
    printf '%s=%s\n' "${key}" "${value}" > "${path}"
    ok "Created $(relative_path "${path}")"
    return
  fi

  if grep -qE "^${key}=" "${path}"; then
    return
  fi

  printf '%s=%s\n' "${key}" "${value}" >> "${path}"
  ok "Added ${key} to $(relative_path "${path}")"
}

replace_env_value_if_exact() {
  local path="$1"
  local key="$2"
  local old_value="$3"
  local new_value="$4"

  if [[ ! -f "${path}" ]]; then
    return 1
  fi

  if ! grep -q "^${key}=${old_value}$" "${path}"; then
    return 1
  fi

  local tmp
  tmp="$(mktemp)"
  sed "s#^${key}=${old_value}\$#${key}=${new_value}#" "${path}" > "${tmp}"
  mv "${tmp}" "${path}"
  return 0
}

ensure_dashboard_database_url() {
  local path="${DASHBOARD_DIR}/apps/web/.env"
  local default_url="postgresql://postgres:password@localhost:${DASHBOARD_POSTGRES_PORT}/dashboard"

  if [[ ! -f "${path}" ]]; then
    return
  fi

  if replace_env_value_if_exact "${path}" "DATABASE_URL" "postgres://postgres:password@localhost:5432/dashboard" "${default_url}"; then
    ok "Updated dashboard DATABASE_URL to localhost:${DASHBOARD_POSTGRES_PORT}"
    return
  fi

  if replace_env_value_if_exact "${path}" "DATABASE_URL" "postgresql://postgres:password@localhost:5432/dashboard" "${default_url}"; then
    ok "Updated dashboard DATABASE_URL to localhost:${DASHBOARD_POSTGRES_PORT}"
    return
  fi

  ensure_env_kv "${path}" "DATABASE_URL" "${default_url}"
}

ensure_dashboard_db_compose_env() {
  local path="${DASHBOARD_DIR}/packages/db/.env"

  write_file_if_missing "${path}" "DASHBOARD_POSTGRES_PORT=${DASHBOARD_POSTGRES_PORT}"

  if replace_env_value_if_exact "${path}" "DASHBOARD_POSTGRES_PORT" "5432" "${DASHBOARD_POSTGRES_PORT}"; then
    ok "Updated dashboard Postgres port to ${DASHBOARD_POSTGRES_PORT}"
    return
  fi

  ensure_env_kv "${path}" "DASHBOARD_POSTGRES_PORT" "${DASHBOARD_POSTGRES_PORT}"
}

setup_dashboard_env() {
  if [[ "${skip_dashboard}" -eq 1 ]]; then
    return
  fi

  local secret
  secret="$(random_secret)"

  write_file_if_missing "${DASHBOARD_DIR}/apps/web/.env" "BETTER_AUTH_SECRET=${secret}
BETTER_AUTH_URL=http://localhost:13630
CORS_ORIGIN=http://localhost:13630
DATABASE_URL=postgresql://postgres:password@localhost:${DASHBOARD_POSTGRES_PORT}/dashboard"
  ensure_dashboard_database_url

  ensure_dashboard_db_compose_env

  write_file_if_missing "${DASHBOARD_DIR}/apps/native/.env" "EXPO_PUBLIC_SERVER_URL=http://localhost:13630"
}

setup_dashboard_database() {
  if [[ "${skip_dashboard}" -eq 1 ]] || [[ "${skip_db}" -eq 1 ]]; then
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    warn "Skipping dashboard database setup because Docker CLI was not found."
    return
  fi

  if ask_yes_no "Start optional dashboard Postgres and push the local schema now?"; then
    info "Starting dashboard Postgres."
    local db_start_log
    db_start_log="$(mktemp)"
    if ! "${ROOT_DIR}/pr" dashboard:db:start >"${db_start_log}" 2>&1; then
      cat "${db_start_log}"
      warn_dashboard_database_start_failure "${db_start_log}"
      rm -f "${db_start_log}"
      return
    fi
    rm -f "${db_start_log}"

    info "Pushing dashboard database schema."
    if ! "${ROOT_DIR}/pr" dashboard:db:push; then
      warn "Dashboard schema push failed. Run './pr dashboard:db:push' after Postgres is ready."
      return
    fi
  else
    info "Skipping optional dashboard database setup. Run './pr dashboard:db:start' and './pr dashboard:db:push' when the Dashboard needs local auth/database features."
  fi
}

warn_dashboard_database_start_failure() {
  local log_path="$1"

  if grep -qiE 'tls: failed to verify certificate|x509: certificate|certificate is valid for' "${log_path}"; then
    warn "Dashboard Postgres did not start because Docker could not verify the registry TLS certificate while pulling the image."
    printf '  This affects only local Dashboard database features; module, communication, IDL generation, and ROS2 workflows can continue.\n'
    printf '  If image/postgres-17-alpine.tar exists, ./pr dashboard:db:start will import it automatically.\n'
    printf '  Otherwise create it on a machine that can pull Docker images with: ./pr dashboard:db:save-image\n'
    printf '  Then copy it to image/postgres-17-alpine.tar and run:\n'
    printf '    ./pr dashboard:db:start\n'
    printf '    ./pr dashboard:db:push\n'
    return
  fi

  if grep -qiE 'Cannot connect to the Docker daemon|docker daemon|daemon is not running|Is the docker daemon running' "${log_path}"; then
    warn "Dashboard Postgres did not start because the Docker daemon is not reachable."
    printf '  This affects only local Dashboard database features. Start Docker, then run:\n'
    printf '    ./pr dashboard:db:start\n'
    printf '    ./pr dashboard:db:push\n'
    return
  fi

  warn "Dashboard Postgres did not start. This affects only local Dashboard database features; run './pr dashboard:db:start' after Docker can pull images or after image/postgres-17-alpine.tar is available."
}

build_pr() {
  if [[ ! -f "${ROOT_DIR}/bin/pr.mjs" ]]; then
    fail "Missing pr source: bin/pr.mjs"
    return 1
  fi

  if ! command -v bun >/dev/null 2>&1; then
    fail "Bun is required to compile ./pr."
    return 1
  fi

  bun build "${ROOT_DIR}/bin/pr.mjs" --compile --outfile "${ROOT_DIR}/pr"
  chmod +x "${ROOT_DIR}/pr"
  ok "Updated ./pr"
}

generate_pr_cmd() {
cat > "${ROOT_DIR}/pr.cmd" <<'PR_CMD'
@echo off
setlocal
set "ROOT=%~dp0"
if exist "%ROOT%pr.exe" (
  "%ROOT%pr.exe" %*
) else (
  "%ROOT%pr" %*
)
exit /b %ERRORLEVEL%
PR_CMD

  ok "Updated ./pr.cmd"
}

update_pr_commands() {
  generate_pr_cmd
  build_pr
}

print_next_steps() {
  printf '\n'
  printf 'Try:\n'
  printf '  ./pr check\n'
  printf '  ./pr check:all\n'
  printf '  ./pr test:go\n'
  printf '  ./pr ros2:build-image\n'
  printf '  ./pr ros2:build --packages-select smoke_test1\n'

  if [[ "${skip_dashboard}" -eq 0 ]]; then
    printf '\n'
    printf 'Dashboard:\n'
    printf '  ./pr dashboard:db:start\n'
    printf '  ./pr dashboard:db:push\n'
    printf '  ./pr dashboard\n'
  fi
}

main() {
  parse_args "$@"
  cd "${ROOT_DIR}"
  setup_sudo_workspace_ownership_restore

  printf 'Pacific-Rim setup\n'
  printf 'Workspace: %s\n\n' "${ROOT_DIR}"

  if [[ "$(detect_os)" == "mac" ]] && command -v brew >/dev/null 2>&1; then
    use_homebrew_node22
    printf '\n'
  fi

  if [[ "${install_system}" -eq 1 ]]; then
    install_system_tools
    printf '\n'
  else
    info "System tool auto-install is disabled."
    printf '\n'
  fi

  check_os
  check_project_files
  check_bun
  check_node
  check_npm
  check_git
  check_go
  check_docker

  printf '\n'
  if [[ "${required_failures}" -gt 0 ]]; then
    print_status "FAIL" "Setup stopped with ${required_failures} required failure(s) and ${warnings} warning(s)."
    printf 'Fix the required failures, then rerun ./setup.sh.\n'
    printf 'To skip automatic system package installation, use: ./setup.sh --no-install-system\n'
    exit 1
  fi

  update_pr_commands
  install_project_dependencies
  setup_dashboard_env
  setup_dashboard_database

  printf '\n'
  if [[ "${warnings}" -gt 0 ]]; then
    print_status "WARN" "Setup finished with ${warnings} warning(s)."
  else
    ok "Setup finished without warnings."
  fi

  print_next_steps
}

main "$@"
