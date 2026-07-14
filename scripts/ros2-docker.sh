#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_COMPOSE_FILE="${ROOT_DIR}/deploy/local/ros2/compose.yaml"
PLATFORM_FILE="${ROOT_DIR}/deploy/local/platform.yaml"

platform_value() {
  local key="$1"
  local default="$2"

  if [[ ! -f "${PLATFORM_FILE}" ]]; then
    printf '%s\n' "${default}"
    return
  fi

  local value
  value="$(awk -v key="${key}:" '
    $1 == key {
      sub(/^[^:]*:[[:space:]]*/, "", $0)
      sub(/[[:space:]]+#.*$/, "", $0)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
      gsub(/^"|"$/, "", $0)
      print $0
      exit
    }
  ' "${PLATFORM_FILE}")"

  if [[ -n "${value}" ]]; then
    printf '%s\n' "${value}"
  else
    printf '%s\n' "${default}"
  fi
}

ROS_DISTRO="${ROS_DISTRO:-humble}"
RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
if [[ -z "${USER_UID:-}" ]]; then
  if [[ "$(id -u)" == "0" && -n "${SUDO_UID:-}" && "${SUDO_UID}" != "0" ]]; then
    USER_UID="${SUDO_UID}"
  else
    USER_UID="$(id -u)"
  fi
fi
if [[ -z "${USER_GID:-}" ]]; then
  if [[ "$(id -g)" == "0" && -n "${SUDO_GID:-}" && "${SUDO_GID}" != "0" ]]; then
    USER_GID="${SUDO_GID}"
  else
    USER_GID="$(id -g)"
  fi
fi
DEFAULT_ROS_BASE_IMAGE="ros:${ROS_DISTRO}-ros-base"
HARBOR_REGISTRY="${HARBOR_REGISTRY:-}"
HARBOR_PROJECT="${HARBOR_PROJECT:-library}"
HARBOR_USERNAME="${HARBOR_USERNAME:-}"
HARBOR_PASSWORD="${HARBOR_PASSWORD:-}"
HARBOR_AUTO_LOGIN="${HARBOR_AUTO_LOGIN:-0}"
HARBOR_IMAGE_PULL="${HARBOR_IMAGE_PULL:-0}"
HARBOR_IMAGE_PUSH="${HARBOR_IMAGE_PUSH:-0}"
HARBOR_PREFER_ROS_BASE="${HARBOR_PREFER_ROS_BASE:-0}"
HARBOR_DEPLOY_BASE_IMAGE_PULL="${HARBOR_DEPLOY_BASE_IMAGE_PULL:-0}"
HARBOR_DEPLOY_BASE_IMAGE_PUSH="${HARBOR_DEPLOY_BASE_IMAGE_PUSH:-0}"
HARBOR_DEPLOY_BASE_REUSE_ROS2_IMAGE="${HARBOR_DEPLOY_BASE_REUSE_ROS2_IMAGE:-0}"
HARBOR_DEPLOY_IMAGE_PUSH="${HARBOR_DEPLOY_IMAGE_PUSH:-0}"
HARBOR_DEPLOY_IMAGE_PULL="${HARBOR_DEPLOY_IMAGE_PULL:-0}"
HARBOR_DEPLOY_IMAGE_FALLBACK_LOAD="${HARBOR_DEPLOY_IMAGE_FALLBACK_LOAD:-1}"
HARBOR_DEPLOY_AUTO_LOGIN="${HARBOR_DEPLOY_AUTO_LOGIN:-${HARBOR_AUTO_LOGIN}}"
HARBOR_ROS_BASE_IMAGE="${HARBOR_ROS_BASE_IMAGE:-}"
if [[ -z "${HARBOR_ROS_BASE_IMAGE}" && -n "${HARBOR_REGISTRY}" ]]; then
  HARBOR_ROS_BASE_IMAGE="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/ros:${ROS_DISTRO}-ros-base"
fi
HARBOR_REGISTRY_HOSTPORT="${HARBOR_REGISTRY%%/*}"
HARBOR_REGISTRY_HOST="${HARBOR_REGISTRY_HOSTPORT%%:*}"
DOCKER_LOCAL_NO_PROXY="${DOCKER_LOCAL_NO_PROXY:-${NO_PROXY:-${no_proxy:-}}}"
ROS_BASE_IMAGE_EXPLICIT="0"
if [[ -z "${ROS_BASE_IMAGE+x}" ]]; then
  if [[ "${HARBOR_PREFER_ROS_BASE}" == "1" && -n "${HARBOR_ROS_BASE_IMAGE}" ]]; then
    ROS_BASE_IMAGE="${HARBOR_ROS_BASE_IMAGE}"
  else
    ROS_BASE_IMAGE="${DEFAULT_ROS_BASE_IMAGE}"
  fi
else
  ROS_BASE_IMAGE_EXPLICIT="1"
fi
ROS_DOCKERHUB_FALLBACK="${ROS_DOCKERHUB_FALLBACK:-1}"
DEPLOY_BASE_IMAGE="${DEPLOY_BASE_IMAGE:-}"
DEPLOY_BASE_IMAGE_PREPARE="${DEPLOY_BASE_IMAGE_PREPARE:-1}"
DEPLOY_BASE_IMAGE_ARCH_TAGS="${DEPLOY_BASE_IMAGE_ARCH_TAGS:-1}"
DEPLOY_BASE_REV="${DEPLOY_BASE_REV:-runtime2}"
PYTHON_RUNTIME_REQUIREMENTS_FILE="${ROOT_DIR}/deploy/ros2/python-runtime-requirements.txt"
DEPLOY_BASE_RUNTIME_LABEL="org.pacific-rim.python-runtime-requirements-sha"
PLATFORM_OTLP_ENDPOINT="${PLATFORM_OTLP_ENDPOINT:-$(platform_value "otlp_endpoint" "http://localhost:8636")}"
PLATFORM_OTLP_HTTP_URL="${PLATFORM_OTLP_HTTP_URL:-$(platform_value "otlp_http_url" "http://localhost:8636")}"
PLATFORM_GRAFANA_URL="${PLATFORM_GRAFANA_URL:-$(platform_value "grafana_url" "http://localhost:16000")}"
PLATFORM_PROMETHEUS_URL="${PLATFORM_PROMETHEUS_URL:-$(platform_value "prometheus_url" "http://localhost:18180")}"
PLATFORM_LOKI_URL="${PLATFORM_LOKI_URL:-$(platform_value "loki_url" "http://localhost:6200")}"
PLATFORM_TEMPO_URL="${PLATFORM_TEMPO_URL:-$(platform_value "tempo_url" "http://localhost:6400")}"
PACIFIC_RIM_GO_BUILD_TAGS="${PACIFIC_RIM_GO_BUILD_TAGS:-}"
INSTALL_GOLANG="${INSTALL_GOLANG:-0}"
GO_DOWNLOAD_BASE="${GO_DOWNLOAD_BASE:-https://dl.google.com/go}"
GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
GOSUMDB="${GOSUMDB:-sum.golang.google.cn}"
GO_DEPLOY_BASE_REV="${GO_DEPLOY_BASE_REV:-alsa1}"
ENABLE_VISION_STACK="${ENABLE_VISION_STACK:-0}"
BASE_ENABLE_VISION_STACK="${ENABLE_VISION_STACK}"
REQUESTED_VISION_TARGET="${VISION_TARGET:-none}"
ONNX_VERSION="${ONNX_VERSION:-1.16.2}"
NVIDIA_VISIBLE_DEVICES="${NVIDIA_VISIBLE_DEVICES:-all}"
NVIDIA_DRIVER_CAPABILITIES="${NVIDIA_DRIVER_CAPABILITIES:-compute,utility,video}"
NVIDIA_CONTAINER_RUNTIME="${NVIDIA_CONTAINER_RUNTIME:-nvidia}"
ROS2_IMAGE_OVERRIDE="${ROS2_IMAGE:-}"

vision_target_from_arch() {
  local arch
  arch="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

  case "${arch}" in
    amd64|x86_64)
      printf 'pc-nvidia\n'
      ;;
    arm64|aarch64)
      printf 'jetson\n'
      ;;
    *)
      echo "Cannot auto-detect VISION_TARGET from architecture \"${arch}\". Use pc-nvidia or jetson explicitly." >&2
      return 2
      ;;
  esac
}

vision_target_from_platform() {
  local platform="$1"
  local arch="${platform##*/}"
  vision_target_from_arch "${arch}"
}

resolve_local_vision_target() {
  if [[ "${REQUESTED_VISION_TARGET}" == "auto" ]]; then
    vision_target_from_arch "$(uname -m)"
    return
  fi

  printf '%s\n' "${REQUESTED_VISION_TARGET}"
}

configure_vision_target() {
  local effective_target="$1"

  VISION_TARGET="${effective_target}"
  ENABLE_VISION_STACK="${BASE_ENABLE_VISION_STACK}"
  if [[ "${VISION_TARGET}" != "none" ]]; then
    ENABLE_VISION_STACK="1"
  fi

  ROS2_IMAGE_TAG="${ROS_DISTRO}"
  if [[ "${ENABLE_VISION_STACK}" == "1" || "${VISION_TARGET}" != "none" ]]; then
    ROS2_IMAGE_TAG="${ROS_DISTRO}-vision"
    if [[ "${VISION_TARGET}" != "none" ]]; then
      ROS2_IMAGE_TAG="${ROS2_IMAGE_TAG}-${VISION_TARGET}"
    fi
  fi

  if [[ -n "${ROS2_IMAGE_OVERRIDE}" ]]; then
    ROS2_IMAGE="${ROS2_IMAGE_OVERRIDE}"
  else
    ROS2_IMAGE="pacific-rim-ros2:${ROS2_IMAGE_TAG}"
  fi

  COMPOSE_ARGS=(-f "${BASE_COMPOSE_FILE}")
}

vision_runtime_compose_args() {
  case "${ROS2_VISION_RUNTIME:-1}" in
    0|false|FALSE|no|NO|off|OFF)
      return
      ;;
  esac

  case "${VISION_TARGET}" in
    pc-nvidia)
      printf '%s\n' -f "${ROOT_DIR}/deploy/local/ros2/compose.vision-pc.yaml"
      ;;
    jetson)
      printf '%s\n' -f "${ROOT_DIR}/deploy/local/ros2/compose.vision-jetson.yaml"
      ;;
  esac
}

append_vision_runtime_compose_args() {
  local arg
  while IFS= read -r arg; do
    [[ -n "${arg}" ]] && COMPOSE_RUNTIME_ARGS+=("${arg}")
  done < <(vision_runtime_compose_args)
}

colcon_default_suffix() {
  local suffix=""
  local platform="${DOCKER_DEFAULT_PLATFORM:-}"

  if [[ "${VISION_TARGET}" != "none" ]]; then
    suffix="-${VISION_TARGET}"
  fi

  case "${platform}" in
    linux/amd64|linux/x86_64)
      suffix="${suffix}-linux-amd64"
      ;;
    linux/arm64|linux/aarch64)
      suffix="${suffix}-linux-arm64"
      ;;
  esac

  printf '%s\n' "${suffix}"
}

colcon_default_base() {
  local root="$1"
  printf '%s/%s%s\n' "${root}" "${ROS_DISTRO}" "$(colcon_default_suffix)"
}

case "${REQUESTED_VISION_TARGET}" in
  none|pc-nvidia|jetson|auto)
    ;;
  *)
    echo "Unsupported VISION_TARGET=${REQUESTED_VISION_TARGET}. Use one of: none, pc-nvidia, jetson, auto." >&2
    exit 2
    ;;
esac

configure_vision_target "$(resolve_local_vision_target)"

export ROS_DISTRO RMW_IMPLEMENTATION USER_UID USER_GID ROS_BASE_IMAGE
export PLATFORM_OTLP_ENDPOINT PLATFORM_OTLP_HTTP_URL PLATFORM_GRAFANA_URL
export PLATFORM_PROMETHEUS_URL PLATFORM_LOKI_URL PLATFORM_TEMPO_URL
export PACIFIC_RIM_GO_BUILD_TAGS
export INSTALL_GOLANG GO_DOWNLOAD_BASE GOPROXY GOSUMDB
export ENABLE_VISION_STACK VISION_TARGET ONNX_VERSION ROS2_IMAGE
export NVIDIA_VISIBLE_DEVICES NVIDIA_DRIVER_CAPABILITIES NVIDIA_CONTAINER_RUNTIME

docker_local_no_proxy() {
  local defaults="127.0.0.1,localhost"
  if [[ -n "${HARBOR_REGISTRY_HOSTPORT}" ]]; then
    defaults="${HARBOR_REGISTRY_HOSTPORT},${HARBOR_REGISTRY_HOST},${defaults}"
  fi
  local existing="${DOCKER_LOCAL_NO_PROXY:-${NO_PROXY:-${no_proxy:-}}}"

  if [[ -n "${existing}" ]]; then
    printf '%s,%s\n' "${existing}" "${defaults}"
  else
    printf '%s\n' "${defaults}"
  fi
}

docker_local() {
  local no_proxy_value
  no_proxy_value="$(docker_local_no_proxy)"
  NO_PROXY="${no_proxy_value}" no_proxy="${no_proxy_value}" docker "$@"
}

docker_image_exists_local() {
  local image="$1"

  if docker_local image inspect "${image}" >/dev/null 2>&1; then
    return 0
  fi

  docker_local image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -Fxq "${image}"
}

docker_image_local_id() {
  local image="$1"
  docker_local image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null \
    | awk -v image="${image}" '$1 == image { print $2; exit }'
}

docker_image_os_arch() {
  local image="$1"
  local image_id
  image_id="$(docker_image_local_id "${image}")"
  [[ -n "${image_id}" ]] || return 1

  local os_arch
  os_arch="$(docker_local image inspect --format '{{.Os}}/{{.Architecture}}' "${image_id}" 2>/dev/null)" || return 1
  [[ -n "${os_arch}" ]] || return 1
  printf '%s\n' "${os_arch}"
}

docker_image_matches_platform() {
  local image="$1"
  local platform="${2:-}"

  if [[ -z "${platform}" ]]; then
    docker_image_exists_local "${image}"
    return
  fi

  local expected actual
  expected="$(platform_os_arch "${platform}")" || return 1
  actual="$(docker_image_os_arch "${image}")" || return 1

  [[ "${actual}" == "${expected}" ]]
}

sha256_file() {
  local path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{ print $1 }'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${path}" | awk '{ print $1 }'
    return
  fi

  echo "sha256sum or shasum is required to fingerprint ${path}" >&2
  return 1
}

deploy_base_runtime_requirements_sha() {
  sha256_file "${PYTHON_RUNTIME_REQUIREMENTS_FILE}"
}

deploy_base_runtime_fingerprint_matches() {
  local image="$1"
  local expected actual

  expected="$(deploy_base_runtime_requirements_sha)" || return 1
  actual="$(docker_local image inspect --format "{{ index .Config.Labels \"${DEPLOY_BASE_RUNTIME_LABEL}\" }}" "${image}" 2>/dev/null)" || return 1

  [[ "${actual}" == "${expected}" ]]
}

deploy_base_image_is_current() {
  local image="$1"
  local platform="${2:-}"

  docker_image_matches_platform "${image}" "${platform}" || return 1
  deploy_base_runtime_fingerprint_matches "${image}" || return 1
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/ros2-docker.sh build-image
  scripts/ros2-docker.sh deploy-base-image [options]
  scripts/ros2-docker.sh up-observability
  scripts/ros2-docker.sh logs-observability
  scripts/ros2-docker.sh down
  scripts/ros2-docker.sh shell [--network <mode>] [--device <spec>...] [--privileged]
  scripts/ros2-docker.sh monitor-container <name>
  scripts/ros2-docker.sh build [colcon args...]
  scripts/ros2-docker.sh test [colcon args...]
  scripts/ros2-docker.sh run <command...> [--network <mode>] [--device <spec>...] [--privileged]
  scripts/ros2-docker.sh deploy-image --host <ip-or-host> --packages-select <pkg> [--domain-id <id>] [options]
  scripts/ros2-docker.sh deploy --host <ip-or-host> --remote-dir <dir> [--user <user>] [--password <password>] [--port <port>] [--packages-select <pkg>]

Environment:
  ROS_DISTRO=humble|jazzy|kilted|lyrical|rolling
  RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
  PACIFIC_RIM_GO_BUILD_TAGS=pacific_rim_ros2_rclgo
  INSTALL_GOLANG=0|1
  DEPLOY_BASE_REV=runtime2
  GO_DEPLOY_BASE_REV=alsa1
  GOPROXY=https://goproxy.cn,direct
  GOSUMDB=sum.golang.google.cn
  ROS_BASE_IMAGE=ros:<distro>-ros-base or <registry>/<project>/ros:<distro>-ros-base
  ENABLE_VISION_STACK=0|1
  VISION_TARGET=none|pc-nvidia|jetson|auto
  ONNX_VERSION=1.16.2
  HARBOR_REGISTRY=<registry-host:port>
  HARBOR_PROJECT=library
  HARBOR_ROS_BASE_IMAGE=<registry>/<project>/ros:<distro>-ros-base
  HARBOR_PREFER_ROS_BASE=0
  HARBOR_IMAGE_PULL=0
  HARBOR_IMAGE_PUSH=0
  HARBOR_DEPLOY_BASE_IMAGE_PULL=0
  HARBOR_DEPLOY_BASE_IMAGE_PUSH=0
  HARBOR_DEPLOY_BASE_REUSE_ROS2_IMAGE=0
  HARBOR_DEPLOY_IMAGE_PUSH=0
  HARBOR_DEPLOY_IMAGE_PULL=0
  HARBOR_DEPLOY_IMAGE_FALLBACK_LOAD=1
  ROS_DOCKERHUB_FALLBACK=1
  ROS_RUN_NETWORK=host
  ROS_RUN_PRIVILEGED=1

deploy-image options:
  --host <ip-or-host>             Required remote Docker host over SSH.
  --user <user>                   SSH user. Defaults to DEPLOY_USER or jetson.
  --password <password>           SSH password. Prefer DEPLOY_PASSWORD env when possible.
  --port <port>                   SSH port. Defaults to DEPLOY_PORT or 22.
  --packages-select <pkg>         Required ROS2 package.xml <name>.
  --executable <name>             ROS2 executable. Defaults to <pkg>_node.
  --domain-id <id>                Remote ROS_DOMAIN_ID. Defaults to ROS_DOMAIN_ID or 42.
  --image <name:tag>              Local and remote image tag.
  --container-name <name>         Remote container name. Defaults to <pkg>.
  --platform <linux/arch>         Docker build platform. Defaults to remote architecture detection.
  --base-image <image>            ROS base image. Defaults to ROS_BASE_IMAGE or ros:<distro>-ros-base.
  --deploy-base-image <image>     Static deploy base image. Defaults to pacific-rim-ros2-deploy-base:<tag>.
  --no-deploy-base-image          Build service image from the Dockerfile deploy-base stage directly.
  --push-to-harbor                Push the service deploy image to Harbor after building.
  --no-push-to-harbor             Skip service image push to Harbor.
  --pull-from-harbor              Pull the service image from Harbor on the remote host.
  --no-pull-from-harbor           Skip remote Harbor pull and use docker save/load.
  --no-load-image                 Do not fall back to docker save/load if remote Harbor pull fails.
  --network <mode>                Remote Docker network. Defaults to host.
  --env KEY=VALUE                 Add remote docker run environment.
  --device <spec>                 Add remote docker run device.
  --volume <spec>                 Add remote docker run volume.
  --privileged                    Run remote container as privileged.
  --restart <policy>              Defaults to unless-stopped.
  --logs-tail <lines>             Show container logs after deploy. Defaults to 120.
  --no-logs                       Skip post-deploy container logs.
  --pull                          Pull a fresh base image before building.
  --no-cache                      Build image without Docker cache.
  --build-arg KEY=VALUE           Extra Docker build arg.
  --dry-run                       Print commands without running them.
USAGE
}

compose() {
  docker_local compose "${COMPOSE_ARGS[@]}" "$@"
}

compose_image() {
  local compose_args=("${COMPOSE_ARGS[@]}")
  local COMPOSE_RUNTIME_ARGS=()
  append_vision_runtime_compose_args
  if [[ ${#COMPOSE_RUNTIME_ARGS[@]} -gt 0 ]]; then
    compose_args+=("${COMPOSE_RUNTIME_ARGS[@]}")
  fi
  docker_local compose "${compose_args[@]}" "$@"
}

yaml_single_quote() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "${value}"
}

write_ros_run_override() {
  local file="$1"
  printf 'services:\n  ros2:\n' > "${file}"

  if [[ -n "${ROS_RUN_NETWORK:-}" ]]; then
    printf '    network_mode: %s\n' "$(yaml_single_quote "${ROS_RUN_NETWORK}")" >> "${file}"
  fi

  if [[ "${ROS_RUN_PRIVILEGED:-}" == "1" || "${ROS_RUN_PRIVILEGED:-}" == "true" ]]; then
    printf '    privileged: true\n' >> "${file}"
  fi

  if [[ -n "${ROS_RUN_DEVICES:-}" ]]; then
    printf '    devices:\n' >> "${file}"

    local device
    while IFS= read -r device; do
      if [[ -n "${device}" ]]; then
        printf '      - %s\n' "$(yaml_single_quote "${device}")" >> "${file}"
      fi
    done <<< "${ROS_RUN_DEVICES}"
  fi
}

ros2_image() {
  printf '%s\n' "${ROS2_IMAGE}"
}

harbor_image_ref_for() {
  local image="$1"
  local ref_no_digest="${image%@*}"

  [[ -n "${HARBOR_REGISTRY}" ]] || return 1

  if [[ "${ref_no_digest}" != "${image}" ]]; then
    return 1
  fi

  if [[ "${ref_no_digest}" == "${HARBOR_REGISTRY}/"* ]]; then
    printf '%s\n' "${ref_no_digest}"
    return 0
  fi

  local repo="${ref_no_digest}"
  local tag="latest"
  local last_component="${repo##*/}"
  if [[ "${last_component}" == *:* ]]; then
    tag="${last_component##*:}"
    repo="${repo%:*}"
  fi

  local first_component="${repo%%/*}"
  if [[ "${repo}" == */* ]] && [[ "${first_component}" == *.* || "${first_component}" == *:* || "${first_component}" == "localhost" ]]; then
    repo="${repo#*/}"
  fi

  if [[ -n "${HARBOR_PROJECT}" ]]; then
    printf '%s/%s/%s:%s\n' "${HARBOR_REGISTRY}" "${HARBOR_PROJECT}" "${repo}" "${tag}"
  else
    printf '%s/%s:%s\n' "${HARBOR_REGISTRY}" "${repo}" "${tag}"
  fi
}

image_ref_is_harbor() {
  local image="$1"
  local ref_no_digest="${image%@*}"
  [[ -n "${HARBOR_REGISTRY}" && "${ref_no_digest}" == "${HARBOR_REGISTRY}/"* ]]
}

normalize_arch() {
  local arch
  arch="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

  case "${arch}" in
    x86_64)
      printf 'amd64\n'
      ;;
    aarch64)
      printf 'arm64\n'
      ;;
    *)
      printf '%s\n' "${arch}"
      ;;
  esac
}

platform_os_arch() {
  local platform="$1"
  [[ -n "${platform}" ]] || return 1

  local os="${platform%%/*}"
  local rest="${platform#*/}"
  [[ "${os}" != "${platform}" && -n "${rest}" ]] || return 1

  local arch="${rest%%/*}"
  arch="$(normalize_arch "${arch}")"
  printf '%s/%s\n' "${os}" "${arch}"
}

platform_tag_suffix() {
  local platform="$1"
  [[ -n "${platform}" ]] || return 1

  local os_arch arch
  os_arch="$(platform_os_arch "${platform}")" || return 1
  arch="${os_arch#*/}"
  printf '%s\n' "${arch}"
}

harbor_ros_base_image_for_platform() {
  local platform="$1"

  if [[ "${ROS_BASE_IMAGE_EXPLICIT}" == "1" || "${HARBOR_PREFER_ROS_BASE}" != "1" || -z "${HARBOR_REGISTRY}" ]]; then
    printf '%s\n' "${ROS_BASE_IMAGE}"
    return 0
  fi

  local arch
  if arch="$(platform_tag_suffix "${platform}")"; then
    printf '%s/%s/ros:%s-ros-base-%s\n' "${HARBOR_REGISTRY}" "${HARBOR_PROJECT}" "${ROS_DISTRO}" "${arch}"
    return 0
  fi

  printf '%s\n' "${HARBOR_ROS_BASE_IMAGE:-${ROS_BASE_IMAGE}}"
}

deploy_base_image_tag() {
  local platform="${1:-}"
  local tag="${ROS2_IMAGE_TAG}-${DEPLOY_BASE_REV}"

  case "${INSTALL_GOLANG}" in
    1|true|TRUE|yes|YES|on|ON)
      tag="${tag}-go-${GO_DEPLOY_BASE_REV}"
      ;;
  esac

  local arch
  if [[ "${DEPLOY_BASE_IMAGE_ARCH_TAGS}" == "1" ]] && arch="$(platform_tag_suffix "${platform}")"; then
    tag="${tag}-${arch}"
  fi

  printf 'pacific-rim-ros2-deploy-base:%s\n' "${tag}"
}

sanitize_lock_name() {
  local value="$1"
  value="${value//\//-}"
  value="${value//:/-}"
  value="${value//[^A-Za-z0-9_.-]/-}"
  printf '%s\n' "${value}"
}

file_mtime_epoch() {
  local file="$1"

  if stat -f %m "${file}" >/dev/null 2>&1; then
    stat -f %m "${file}"
    return
  fi

  stat -c %Y "${file}"
}

cache_file_is_fresh() {
  local file="$1"
  local ttl_seconds="$2"

  [[ -f "${file}" ]] || return 1

  local mtime now
  mtime="$(file_mtime_epoch "${file}" 2>/dev/null || printf '0')"
  now="$(date +%s)"
  [[ $((now - mtime)) -lt "${ttl_seconds}" ]]
}

harbor_cache_dir() {
  local dir="${ROOT_DIR}/.cache/ros2-docker"
  mkdir -p "${dir}"
  printf '%s\n' "${dir}"
}

harbor_login_cache_key() {
  local scope="$1"
  sanitize_lock_name "${scope}-${HARBOR_REGISTRY}-${HARBOR_USERNAME}"
}

harbor_login_success_output() {
  local output="$1"
  grep -Eiq \
    "(Login Succeeded|specified item already exists in the keychain|The specified item already exists|already exists in the keychain)" \
    <<< "${output}"
}

pull_ros2_image_from_harbor() {
  local image="$1"

  [[ "${HARBOR_IMAGE_PULL}" == "1" ]] || return 1

  local harbor_ref
  harbor_ref="$(harbor_image_ref_for "${image}")" || return 1
  [[ -n "${harbor_ref}" ]] || return 1

  echo "Trying Harbor ROS2 image: ${harbor_ref}"
  login_harbor_if_enabled || return 1
  local pull_args=(docker_local pull)
  if [[ -n "${DOCKER_DEFAULT_PLATFORM:-}" ]]; then
    pull_args+=(--platform "${DOCKER_DEFAULT_PLATFORM}")
  fi
  if ! "${pull_args[@]}" "${harbor_ref}"; then
    return 1
  fi

  if [[ -n "${DOCKER_DEFAULT_PLATFORM:-}" ]] && ! docker_image_matches_platform "${harbor_ref}" "${DOCKER_DEFAULT_PLATFORM}"; then
    echo "Harbor ROS2 image platform mismatch: ${harbor_ref} is $(docker_image_os_arch "${harbor_ref}" 2>/dev/null || printf 'unknown'), expected ${DOCKER_DEFAULT_PLATFORM}" >&2
    return 1
  fi

  if [[ "${harbor_ref}" != "${image}" ]]; then
    docker_local tag "${harbor_ref}" "${image}"
  fi
  return 0
}

pull_image_from_harbor() {
  local image="$1"
  local label="${2:-image}"
  local platform="${3:-${DOCKER_DEFAULT_PLATFORM:-}}"

  [[ "${HARBOR_IMAGE_PULL}" == "1" ]] || return 1

  local harbor_ref
  harbor_ref="$(harbor_image_ref_for "${image}")" || return 1
  [[ -n "${harbor_ref}" ]] || return 1

  echo "Trying Harbor ${label}: ${harbor_ref}"
  login_harbor_if_enabled || return 1

  local pull_args=(docker_local pull)
  if [[ -n "${platform}" ]]; then
    pull_args+=(--platform "${platform}")
  fi
  if ! "${pull_args[@]}" "${harbor_ref}"; then
    return 1
  fi

  if [[ -n "${platform}" ]] && ! docker_image_matches_platform "${harbor_ref}" "${platform}"; then
    echo "Harbor ${label} platform mismatch: ${harbor_ref} is $(docker_image_os_arch "${harbor_ref}" 2>/dev/null || printf 'unknown'), expected ${platform}" >&2
    return 1
  fi

  if [[ "${harbor_ref}" != "${image}" ]]; then
    docker_local tag "${harbor_ref}" "${image}"
  fi
  return 0
}

push_image_to_harbor() {
  local image="$1"
  local label="${2:-image}"

  HARBOR_PUSHED_REF=""

  local harbor_ref
  harbor_ref="$(harbor_image_ref_for "${image}")" || return 1
  [[ -n "${harbor_ref}" ]] || return 1

  echo "Pushing ${label} to Harbor: ${harbor_ref}"
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    if [[ "${HARBOR_AUTO_LOGIN}" == "1" ]]; then
      printf '+ printf %%s %q | docker login %q --username %q --password-stdin\n' "<redacted>" "${HARBOR_REGISTRY}" "${HARBOR_USERNAME}"
    fi
    if [[ "${harbor_ref}" != "${image}" ]]; then
      printf '+ docker tag %q %q\n' "${image}" "${harbor_ref}"
    fi
    printf '+ docker push %q\n' "${harbor_ref}"
    HARBOR_PUSHED_REF="${harbor_ref}"
    return 0
  fi

  login_harbor_if_enabled || return 1

  if [[ "${harbor_ref}" != "${image}" ]]; then
    docker_local rmi "${harbor_ref}" >/dev/null 2>&1 || true
    docker_local tag "${image}" "${harbor_ref}" || return 1
  fi
  docker_local push "${harbor_ref}" || return 1

  HARBOR_PUSHED_REF="${harbor_ref}"
  return 0
}

push_image_to_harbor_or_warn() {
  local image="$1"
  local label="${2:-image}"

  [[ "${HARBOR_IMAGE_PUSH}" == "1" ]] || return 0

  if ! push_image_to_harbor "${image}" "${label}"; then
    echo "Warning: failed to push ${label} to Harbor; continuing with local image." >&2
    return 0
  fi
}

reuse_ros2_image_as_deploy_base() {
  local base_image="$1"
  local platform="$2"

  [[ "${HARBOR_DEPLOY_BASE_REUSE_ROS2_IMAGE}" == "1" ]] || return 1
  [[ "${ENABLE_VISION_STACK}" == "1" || "${VISION_TARGET}" != "none" || "${ROS_DISTRO}" != "humble" ]] || return 1

  local source_image="${DEPLOY_BASE_REUSE_IMAGE:-${ROS2_IMAGE}}"
  [[ -n "${source_image}" ]] || return 1
  [[ "${source_image}" != "${base_image}" ]] || return 1

  if docker_image_matches_platform "${source_image}" "${platform}" >/dev/null 2>&1; then
    echo "Reusing ROS2 image as deploy base: ${source_image} -> ${base_image}"
    docker_local tag "${source_image}" "${base_image}" || return 1
    return 0
  fi

  local harbor_ref
  if harbor_ref="$(harbor_image_ref_for "${source_image}")" && docker_image_matches_platform "${harbor_ref}" "${platform}" >/dev/null 2>&1; then
    echo "Reusing Harbor ROS2 image as deploy base: ${harbor_ref} -> ${base_image}"
    docker_local tag "${harbor_ref}" "${source_image}" || true
    docker_local tag "${harbor_ref}" "${base_image}" || return 1
    return 0
  fi

  [[ "${HARBOR_IMAGE_PULL}" == "1" || "${HARBOR_DEPLOY_BASE_IMAGE_PULL}" == "1" ]] || return 1

  if pull_image_from_harbor "${source_image}" "ROS2 image for deploy base" "${platform}"; then
    echo "Reusing pulled ROS2 image as deploy base: ${source_image} -> ${base_image}"
    docker_local tag "${source_image}" "${base_image}" || return 1
    return 0
  fi

  return 1
}

ensure_ros2_image() {
  local image
  image="$(ros2_image)"
  if docker_image_exists_local "${image}" >/dev/null 2>&1; then
    return 0
  fi

  if pull_ros2_image_from_harbor "${image}"; then
    return 0
  fi

  echo "ROS2 image ${image} was not found locally; building it."
  compose_image build ros2 || return $?
  push_image_to_harbor_or_warn "${image}" "ROS2 image"
}

build_ros2_image() {
  local image
  image="$(ros2_image)"
  if ! docker_image_exists_local "${image}" >/dev/null 2>&1 && pull_ros2_image_from_harbor "${image}"; then
    return 0
  fi

  compose_image build ros2 || return $?
  push_image_to_harbor_or_warn "${image}" "ROS2 image"
}

run_ros() {
  local ROS_RUN_DEVICES="${ROS_RUN_DEVICES:-}"
  local ROS_RUN_NETWORK="${ROS_RUN_NETWORK:-}"
  local ROS_RUN_PRIVILEGED="${ROS_RUN_PRIVILEGED:-}"
  local ROS_RUN_SOURCE_INSTALL="${ROS_RUN_SOURCE_INSTALL:-0}"
  local command_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --network)
        shift
        if [[ $# -eq 0 || -z "${1:-}" ]]; then
          echo "--network requires a value" >&2
          return 2
        fi
        ROS_RUN_NETWORK="$1"
        ;;
      --network=*)
        ROS_RUN_NETWORK="${1#--network=}"
        ;;
      --host-network)
        ROS_RUN_NETWORK="host"
        ;;
      --device)
        shift
        if [[ $# -eq 0 || -z "${1:-}" ]]; then
          echo "--device requires a value" >&2
          return 2
        fi
        ROS_RUN_DEVICES="${ROS_RUN_DEVICES:+${ROS_RUN_DEVICES}$'\n'}$1"
        ;;
      --device=*)
        ROS_RUN_DEVICES="${ROS_RUN_DEVICES:+${ROS_RUN_DEVICES}$'\n'}${1#--device=}"
        ;;
      --privileged)
        ROS_RUN_PRIVILEGED="1"
        ;;
      --)
        shift
        command_args+=("$@")
        break
        ;;
      *)
        command_args+=("$@")
        break
        ;;
    esac
    shift
  done

  if [[ ${#command_args[@]} -eq 0 ]]; then
    usage
    return 1
  fi

  ensure_ros2_image || return $?
  local run_args=(run --rm)
  local compose_args=("${COMPOSE_ARGS[@]}")
  local COMPOSE_RUNTIME_ARGS=()
  append_vision_runtime_compose_args
  if [[ ${#COMPOSE_RUNTIME_ARGS[@]} -gt 0 ]]; then
    compose_args+=("${COMPOSE_RUNTIME_ARGS[@]}")
  fi
  local run_override=""
  if [[ -n "${ROS_RUN_DEVICES:-}" || -n "${ROS_RUN_NETWORK:-}" || -n "${ROS_RUN_PRIVILEGED:-}" ]]; then
    run_override="$(mktemp "${TMPDIR:-/tmp}/pacific-rim-ros2-run.XXXXXX.yaml")"
    write_ros_run_override "${run_override}"
    compose_args+=(-f "${run_override}")
  fi
  remove_matching_ros_run_containers
  if [[ -n "${ROS_RUN_CONTAINER_NAME:-}" ]]; then
    docker_local rm -f "${ROS_RUN_CONTAINER_NAME}" >/dev/null 2>&1 || true
    run_args+=(--name "${ROS_RUN_CONTAINER_NAME}")
  fi
  if [[ -n "${ROS_RUN_PACKAGE_NAME:-}" ]]; then
    run_args+=(-e "ROS_RUN_PACKAGE_NAME=${ROS_RUN_PACKAGE_NAME}")
  fi
  if [[ -n "${ROS_RUN_EXECUTABLE_NAME:-}" ]]; then
    run_args+=(-e "ROS_RUN_EXECUTABLE_NAME=${ROS_RUN_EXECUTABLE_NAME}")
  fi

  set +e
  local command_string
  if [[ ${#command_args[@]} -eq 1 ]]; then
    command_string="${command_args[0]}"
  else
    printf -v command_string '%q ' "${command_args[@]}"
  fi
  local setup_command="source /opt/ros/${ROS_DISTRO}/setup.bash"
  if [[ "${ROS_RUN_SOURCE_INSTALL}" == "1" || "${ROS_RUN_SOURCE_INSTALL}" == "true" ]]; then
    setup_command+=" && if [[ -f install/${ROS_DISTRO}/setup.bash ]]; then source install/${ROS_DISTRO}/setup.bash; elif [[ -f install/setup.bash ]]; then source install/setup.bash; fi"
  fi
  docker_local compose "${compose_args[@]}" "${run_args[@]}" ros2 bash -lc "${setup_command} && ${command_string}"
  local status=$?
  set -e
  if [[ -n "${run_override}" ]]; then
    rm -f "${run_override}"
  fi
  return "${status}"
}

remove_matching_ros_run_containers() {
  if [[ -z "${ROS_RUN_PACKAGE_NAME:-}" || -z "${ROS_RUN_EXECUTABLE_NAME:-}" || -z "${ROS_DOMAIN_ID:-}" || -z "${ROS_DISTRO:-}" ]]; then
    return 0
  fi

  local ids=()
  local id
  while IFS= read -r id; do
    [[ -n "${id}" ]] && ids+=("${id}")
  done < <(docker_local ps -aq)

  for id in "${ids[@]}"; do
    local env
    local cmd
    env="$(docker_local inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${id}" 2>/dev/null || true)"
    cmd="$(docker_local inspect --format '{{json .Config.Cmd}}' "${id}" 2>/dev/null || true)"

    if printf '%s\n' "${env}" | grep -Fxq "ROS_DISTRO=${ROS_DISTRO}" \
      && printf '%s\n' "${env}" | grep -Fxq "ROS_DOMAIN_ID=${ROS_DOMAIN_ID}" \
      && ros_run_container_matches "${env}" "${cmd}"; then
      docker_local rm -f "${id}" >/dev/null 2>&1 || true
    fi
  done
}

ros_run_container_matches() {
  local env="$1"
  local cmd="$2"

  if printf '%s\n' "${env}" | grep -Fxq "ROS_RUN_PACKAGE_NAME=${ROS_RUN_PACKAGE_NAME}" \
    && printf '%s\n' "${env}" | grep -Fxq "ROS_RUN_EXECUTABLE_NAME=${ROS_RUN_EXECUTABLE_NAME}"; then
    return 0
  fi

  [[ "${cmd}" == *"ros2 run ${ROS_RUN_PACKAGE_NAME} ${ROS_RUN_EXECUTABLE_NAME}"* ]] \
    || [[ "${cmd}" == *"ros2 run '${ROS_RUN_PACKAGE_NAME}' '${ROS_RUN_EXECUTABLE_NAME}'"* ]] \
    || [[ "${cmd}" == *"ros2 run \\\"${ROS_RUN_PACKAGE_NAME}\\\" \\\"${ROS_RUN_EXECUTABLE_NAME}\\\""* ]]
}

run_shell() {
  local ROS_RUN_DEVICES="${ROS_RUN_DEVICES:-}"
  local ROS_RUN_NETWORK="${ROS_RUN_NETWORK:-}"
  local ROS_RUN_PRIVILEGED="${ROS_RUN_PRIVILEGED:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --network)
        shift
        if [[ $# -eq 0 || -z "${1:-}" ]]; then
          echo "--network requires a value" >&2
          return 2
        fi
        ROS_RUN_NETWORK="$1"
        ;;
      --network=*)
        ROS_RUN_NETWORK="${1#--network=}"
        ;;
      --host-network)
        ROS_RUN_NETWORK="host"
        ;;
      --device)
        shift
        if [[ $# -eq 0 || -z "${1:-}" ]]; then
          echo "--device requires a value" >&2
          return 2
        fi
        ROS_RUN_DEVICES="${ROS_RUN_DEVICES:+${ROS_RUN_DEVICES}$'\n'}$1"
        ;;
      --device=*)
        ROS_RUN_DEVICES="${ROS_RUN_DEVICES:+${ROS_RUN_DEVICES}$'\n'}${1#--device=}"
        ;;
      --privileged)
        ROS_RUN_PRIVILEGED="1"
        ;;
      --help|-h)
        usage
        return 0
        ;;
      *)
        echo "Unknown shell option: $1" >&2
        usage
        return 2
        ;;
    esac
    shift
  done

  ensure_ros2_image || return $?
  local run_args=(run --rm)
  local compose_args=("${COMPOSE_ARGS[@]}")
  local COMPOSE_RUNTIME_ARGS=()
  append_vision_runtime_compose_args
  if [[ ${#COMPOSE_RUNTIME_ARGS[@]} -gt 0 ]]; then
    compose_args+=("${COMPOSE_RUNTIME_ARGS[@]}")
  fi
  local run_override=""
  if [[ -n "${ROS_RUN_DEVICES:-}" || -n "${ROS_RUN_NETWORK:-}" || -n "${ROS_RUN_PRIVILEGED:-}" ]]; then
    run_override="$(mktemp "${TMPDIR:-/tmp}/pacific-rim-ros2-run.XXXXXX.yaml")"
    write_ros_run_override "${run_override}"
    compose_args+=(-f "${run_override}")
  fi

  set +e
  docker_local compose "${compose_args[@]}" "${run_args[@]}" ros2 bash
  local status=$?
  set -e
  if [[ -n "${run_override}" ]]; then
    rm -f "${run_override}"
  fi
  return "${status}"
}

run_monitor_container() {
  local name="${1:-}"
  if [[ -z "${name}" ]]; then
    echo "monitor-container requires a container name." >&2
    exit 2
  fi

  ensure_ros2_image || return $?

  local id
  local running
  id="$(docker_local inspect --format '{{.Id}}' "${name}" 2>/dev/null || true)"
  if [[ -n "${id}" ]]; then
    running="$(docker_local inspect --format '{{.State.Running}}' "${name}" 2>/dev/null || true)"
    if [[ "${running}" != "true" ]]; then
      docker_local start "${name}" >/dev/null
    fi
    docker_local inspect --format '{{.Id}}' "${name}"
    return 0
  fi

  compose run -d --name "${name}" ros2 bash -lc "while true; do sleep 3600; done" >/dev/null
  docker_local inspect --format '{{.Id}}' "${name}"
}

colcon_has_arg() {
  local option="$1"
  shift

  local arg
  for arg in "$@"; do
    case "${arg}" in
      "${option}"|"${option}="*)
        return 0
        ;;
    esac
  done

  return 1
}

colcon_arg_value() {
  local option="$1"
  local default_value="$2"
  shift 2

  local arg
  local next_is_value="0"
  for arg in "$@"; do
    if [[ "${next_is_value}" == "1" ]]; then
      printf '%s\n' "${arg}"
      return
    fi

    case "${arg}" in
      "${option}")
        next_is_value="1"
        ;;
      "${option}="*)
        printf '%s\n' "${arg#${option}=}"
        return
        ;;
    esac
  done

  printf '%s\n' "${default_value}"
}

colcon_workspace_args() {
  local args=("$@")

  if ! colcon_has_arg "--build-base" "${args[@]}"; then
    args+=(--build-base "$(colcon_default_base "build")")
  fi
  if ! colcon_has_arg "--install-base" "${args[@]}"; then
    args+=(--install-base "$(colcon_default_base "install")")
  fi

  printf '%q ' "${args[@]}"
}

colcon_build_args() {
  local args=()
  local skip_next="0"
  local arg
  local has_packages_up_to="0"
  local index

  for arg in "$@"; do
    if [[ "${skip_next}" == "1" ]]; then
      skip_next="0"
      continue
    fi

    case "${arg}" in
      --log-base)
        skip_next="1"
        ;;
      --log-base=*)
        ;;
      *)
        args+=("${arg}")
        ;;
    esac
  done

  for index in "${!args[@]}"; do
    case "${args[${index}]}" in
      --packages-up-to|--packages-up-to=*)
        has_packages_up_to="1"
        ;;
    esac
  done

  if [[ "${has_packages_up_to}" != "1" ]]; then
    for index in "${!args[@]}"; do
      case "${args[${index}]}" in
        --packages-select)
          args[${index}]="--packages-up-to"
          ;;
        --packages-select=*)
          args[${index}]="--packages-up-to=${args[${index}]#--packages-select=}"
          ;;
      esac
    done
  fi

  colcon_workspace_args "${args[@]}"
}

base_image_failure_output() {
  local output_file="$1"
  grep -Eiq \
    "(registry-1\.docker\.io|docker\.io/library/ros|docker\.io/library/pacific-rim-ros2|failed to resolve source metadata|failed to resolve reference|failed to do request|context deadline exceeded|tls: failed to verify certificate|certificate is valid for|http: server gave HTTP response to HTTPS client|no basic auth credentials|pull access denied|not found|403 Forbidden|401 Unauthorized|${DEFAULT_ROS_BASE_IMAGE})" \
    "${output_file}"
}

dockerhub_failure_output() {
  base_image_failure_output "$1"
}

ros_base_retry_image_for() {
  local current_base_image="$1"
  local platform="${2:-}"
  local harbor_base_image
  harbor_base_image="$(harbor_ros_base_image_for_platform "${platform}")"

  if [[ "${current_base_image}" == "${harbor_base_image}" ]]; then
    [[ "${ROS_DOCKERHUB_FALLBACK}" == "1" ]] || return 1
    printf '%s\n' "${DEFAULT_ROS_BASE_IMAGE}"
    return 0
  fi

  [[ "${current_base_image}" != "${harbor_base_image}" ]] || return 1
  printf '%s\n' "${harbor_base_image}"
}

print_harbor_hint() {
  [[ -n "${HARBOR_REGISTRY}" ]] || return 0
  cat >&2 <<EOF
If Harbor is served over HTTP, configure this Docker daemon first:
  sudo mkdir -p /etc/docker
  sudo sh -c 'printf "%s\n" '"'"'{"insecure-registries":["${HARBOR_REGISTRY}"]}'"'"' > /etc/docker/daemon.json'
  sudo systemctl restart docker
EOF
}

login_harbor_if_enabled() {
  if [[ -z "${HARBOR_REGISTRY}" ]]; then
    return 1
  fi

  if [[ "${HARBOR_AUTO_LOGIN}" != "1" ]]; then
    return 0
  fi

  if [[ -z "${HARBOR_USERNAME}" || -z "${HARBOR_PASSWORD}" ]]; then
    echo "Set HARBOR_USERNAME and HARBOR_PASSWORD before enabling Harbor login." >&2
    return 1
  fi

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "Logging in to Harbor ${HARBOR_REGISTRY} as ${HARBOR_USERNAME}"
    printf '+ printf %%s %q | docker login %q --username %q --password-stdin\n' "<redacted>" "${HARBOR_REGISTRY}" "${HARBOR_USERNAME}"
    return 0
  fi

  local cache_dir cache_key cache_file lock_dir ttl_seconds
  cache_dir="$(harbor_cache_dir)"
  cache_key="$(harbor_login_cache_key "local")"
  cache_file="${cache_dir}/${cache_key}.ok"
  lock_dir="${cache_dir}/${cache_key}.lock"
  ttl_seconds="${HARBOR_LOGIN_CACHE_TTL:-3600}"

  if cache_file_is_fresh "${cache_file}" "${ttl_seconds}"; then
    return 0
  fi

  while ! mkdir "${lock_dir}" 2>/dev/null; do
    sleep 1
    if cache_file_is_fresh "${cache_file}" "${ttl_seconds}"; then
      return 0
    fi
  done

  if cache_file_is_fresh "${cache_file}" "${ttl_seconds}"; then
    rmdir "${lock_dir}" 2>/dev/null || true
    return 0
  fi

  echo "Logging in to Harbor ${HARBOR_REGISTRY} as ${HARBOR_USERNAME}"
  local output status
  set +e
  output="$(printf '%s' "${HARBOR_PASSWORD}" | docker_local login "${HARBOR_REGISTRY}" --username "${HARBOR_USERNAME}" --password-stdin 2>&1)"
  status=$?
  set -e
  printf '%s\n' "${output}"

  if [[ "${status}" -eq 0 ]] || harbor_login_success_output "${output}"; then
    : > "${cache_file}"
    rmdir "${lock_dir}" 2>/dev/null || true
    return 0
  fi

  rmdir "${lock_dir}" 2>/dev/null || true
  echo "Harbor login failed: ${HARBOR_REGISTRY}" >&2
  print_harbor_hint
  return 1
}

should_retry_with_harbor() {
  local output_file="$1"

  [[ "${ROS_DOCKERHUB_FALLBACK}" == "1" ]] || return 1
  [[ "${ROS_BASE_IMAGE}" != "${HARBOR_ROS_BASE_IMAGE}" ]] || return 1
  base_image_failure_output "${output_file}"
}

run_with_harbor_fallback() {
  local label="$1"
  shift

  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/pacific-rim-ros2-docker.XXXXXX")"

  if image_ref_is_harbor "${ROS_BASE_IMAGE}"; then
    login_harbor_if_enabled || true
  fi

  set +e
  "$@" 2>&1 | tee "${output_file}"
  local status=${PIPESTATUS[0]}
  set -e

  if [[ "${status}" -eq 0 ]]; then
    rm -f "${output_file}"
    return 0
  fi

  local retry_base_image=""
  if base_image_failure_output "${output_file}"; then
    retry_base_image="$(ros_base_retry_image_for "${ROS_BASE_IMAGE}" || true)"
  fi

  if [[ -n "${retry_base_image}" && "${retry_base_image}" != "${ROS_BASE_IMAGE}" ]]; then
    echo "${label} failed while resolving ROS base image: ${ROS_BASE_IMAGE}"
    echo "Retrying with ROS base image: ${retry_base_image}"
    if image_ref_is_harbor "${retry_base_image}"; then
      login_harbor_if_enabled
    fi

    set +e
    (export ROS_BASE_IMAGE="${retry_base_image}"; "$@") 2>&1 | tee "${output_file}"
    status=${PIPESTATUS[0]}
    set -e
  fi

  rm -f "${output_file}"
  return "${status}"
}

host_port() {
  local url="$1"
  local without_scheme="${url#*://}"
  local host_port_path="${without_scheme%%/*}"
  printf '%s\n' "${host_port_path##*:}"
}

print_observability_urls() {
  echo "Published on: 0.0.0.0"
  echo "Use http://localhost:<port> on this machine, or http://<host-ip>:<port> from another machine."
  echo "Grafana:    ${PLATFORM_GRAFANA_URL}    external: http://<host-ip>:$(host_port "${PLATFORM_GRAFANA_URL}")"
  echo "Prometheus: ${PLATFORM_PROMETHEUS_URL}    external: http://<host-ip>:$(host_port "${PLATFORM_PROMETHEUS_URL}")"
  echo "Loki:       ${PLATFORM_LOKI_URL}    external: http://<host-ip>:$(host_port "${PLATFORM_LOKI_URL}")"
  echo "Tempo:      ${PLATFORM_TEMPO_URL}    external: http://<host-ip>:$(host_port "${PLATFORM_TEMPO_URL}")"
  echo "OTLP HTTP:  ${PLATFORM_OTLP_HTTP_URL}    external: http://<host-ip>:$(host_port "${PLATFORM_OTLP_HTTP_URL}")"
}

remote_exec() {
  local user_host="$1"
  local port="$2"
  local command="$3"
  ssh_exec "${user_host}" "${port}" "${command}"
}

ssh_retry_limit() {
  local retries="${DEPLOY_SSH_RETRIES:-3}"
  if [[ ! "${retries}" =~ ^[1-9][0-9]*$ ]]; then
    retries="3"
  fi
  printf '%s\n' "${retries}"
}

ssh_retry_sleep_seconds() {
  local seconds="${DEPLOY_SSH_RETRY_SLEEP:-2}"
  if [[ ! "${seconds}" =~ ^[0-9]+$ ]]; then
    seconds="2"
  fi
  printf '%s\n' "${seconds}"
}

ssh_exec_once() {
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

ssh_exec() {
  local user_host="$1"
  local port="$2"
  local command="$3"
  local attempts sleep_seconds attempt status
  attempts="$(ssh_retry_limit)"
  sleep_seconds="$(ssh_retry_sleep_seconds)"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if ssh_exec_once "${user_host}" "${port}" "${command}"; then
      return 0
    fi
    status="$?"
    if [[ "${status}" != "255" || "${attempt}" -ge "${attempts}" ]]; then
      return "${status}"
    fi
    echo "Warning: SSH command failed with exit 255; retrying (${attempt}/${attempts})..." >&2
    sleep "${sleep_seconds}"
  done
}

ssh_exec_stdin_once() {
  local user_host="$1"
  local port="$2"
  local command="$3"
  local stdin_value="$4"

  if [[ -n "${DEPLOY_PASSWORD_VALUE:-}" ]]; then
    if ! command -v sshpass >/dev/null 2>&1; then
      echo "sshpass is required when using --password or DEPLOY_PASSWORD." >&2
      exit 127
    fi
    printf '%s' "${stdin_value}" | SSHPASS="${DEPLOY_PASSWORD_VALUE}" sshpass -e ssh \
      -o StrictHostKeyChecking=accept-new \
      -o PubkeyAuthentication=no \
      -o PreferredAuthentications=password \
      -o NumberOfPasswordPrompts=1 \
      -p "${port}" "${user_host}" "${command}"
    return
  fi

  printf '%s' "${stdin_value}" | ssh -p "${port}" "${user_host}" "${command}"
}

ssh_exec_stdin() {
  local user_host="$1"
  local port="$2"
  local command="$3"
  local stdin_value="$4"
  local attempts sleep_seconds attempt status
  attempts="$(ssh_retry_limit)"
  sleep_seconds="$(ssh_retry_sleep_seconds)"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if ssh_exec_stdin_once "${user_host}" "${port}" "${command}" "${stdin_value}"; then
      return 0
    fi
    status="$?"
    if [[ "${status}" != "255" || "${attempt}" -ge "${attempts}" ]]; then
      return "${status}"
    fi
    echo "Warning: SSH command failed with exit 255; retrying (${attempt}/${attempts})..." >&2
    sleep "${sleep_seconds}"
  done
}

run_ssh_or_print() {
  local user_host="$1"
  local port="$2"
  local command="$3"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    if [[ -n "${DEPLOY_PASSWORD_VALUE:-}" ]]; then
      printf '+ sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -p %q %q %q\n' "${port}" "${user_host}" "${command}"
    else
      printf '+ ssh -p %q %q %q\n' "${port}" "${user_host}" "${command}"
    fi
    return 0
  fi

  ssh_exec "${user_host}" "${port}" "${command}"
}

remote_harbor_login_if_enabled() {
  local user_host="$1"
  local port="$2"

  if [[ -z "${HARBOR_REGISTRY}" ]]; then
    return 1
  fi

  if [[ "${HARBOR_DEPLOY_AUTO_LOGIN}" != "1" ]]; then
    return 0
  fi

  if [[ -z "${HARBOR_USERNAME}" || -z "${HARBOR_PASSWORD}" ]]; then
    echo "Set HARBOR_USERNAME and HARBOR_PASSWORD before enabling Harbor login." >&2
    return 1
  fi

  local command
  command="docker login $(shell_quote "${HARBOR_REGISTRY}") --username $(shell_quote "${HARBOR_USERNAME}") --password-stdin"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    if [[ -n "${DEPLOY_PASSWORD_VALUE:-}" ]]; then
      printf '+ printf %%s %q | sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -p %q %q %q\n' "<redacted>" "${port}" "${user_host}" "${command}"
    else
      printf '+ printf %%s %q | ssh -p %q %q %q\n' "<redacted>" "${port}" "${user_host}" "${command}"
    fi
    return 0
  fi

  local cache_dir cache_key cache_file lock_dir ttl_seconds
  cache_dir="$(harbor_cache_dir)"
  cache_key="$(harbor_login_cache_key "remote-${user_host}-${port}")"
  cache_file="${cache_dir}/${cache_key}.ok"
  lock_dir="${cache_dir}/${cache_key}.lock"
  ttl_seconds="${HARBOR_LOGIN_CACHE_TTL:-3600}"

  if cache_file_is_fresh "${cache_file}" "${ttl_seconds}"; then
    return 0
  fi

  while ! mkdir "${lock_dir}" 2>/dev/null; do
    sleep 1
    if cache_file_is_fresh "${cache_file}" "${ttl_seconds}"; then
      return 0
    fi
  done

  if cache_file_is_fresh "${cache_file}" "${ttl_seconds}"; then
    rmdir "${lock_dir}" 2>/dev/null || true
    return 0
  fi

  echo "Logging in to Harbor ${HARBOR_REGISTRY} on ${user_host} as ${HARBOR_USERNAME}"
  local output status
  set +e
  output="$(ssh_exec_stdin "${user_host}" "${port}" "${command}" "${HARBOR_PASSWORD}" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "${output}"

  if [[ "${status}" -eq 0 ]] || harbor_login_success_output "${output}"; then
    : > "${cache_file}"
    rmdir "${lock_dir}" 2>/dev/null || true
    return 0
  fi

  rmdir "${lock_dir}" 2>/dev/null || true
  echo "Remote Harbor login failed: ${user_host} -> ${HARBOR_REGISTRY}" >&2
  print_harbor_hint
  return 1
}

remote_pull_harbor_image() {
  local image="$1"
  local harbor_ref="$2"
  local user_host="$3"
  local port="$4"

  [[ "${HARBOR_DEPLOY_IMAGE_PULL}" == "1" ]] || return 1

  remote_harbor_login_if_enabled "${user_host}" "${port}" || return 1
  run_ssh_or_print "${user_host}" "${port}" "docker pull $(shell_quote "${harbor_ref}")" || return 1
  if [[ "${harbor_ref}" != "${image}" ]]; then
    remote_exec_argv "${user_host}" "${port}" docker tag "${harbor_ref}" "${image}" || return 1
  fi
  return 0
}

ssh_load_image() {
  local image="$1"
  local user_host="$2"
  local port="$3"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    if [[ -n "${DEPLOY_PASSWORD_VALUE:-}" ]]; then
      printf '+ docker save %q | sshpass -e ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -p %q %q docker load\n' "${image}" "${port}" "${user_host}"
    else
      printf '+ docker save %q | ssh -p %q %q docker load\n' "${image}" "${port}" "${user_host}"
    fi
    return 0
  fi

  if [[ -n "${DEPLOY_PASSWORD_VALUE:-}" ]]; then
    if ! command -v sshpass >/dev/null 2>&1; then
      echo "sshpass is required when using --password or DEPLOY_PASSWORD." >&2
      exit 127
    fi
    docker_local save "${image}" | SSHPASS="${DEPLOY_PASSWORD_VALUE}" sshpass -e ssh \
      -o StrictHostKeyChecking=accept-new \
      -o PubkeyAuthentication=no \
      -o PreferredAuthentications=password \
      -o NumberOfPasswordPrompts=1 \
      -p "${port}" "${user_host}" docker load
    return
  fi

  docker_local save "${image}" | ssh -p "${port}" "${user_host}" docker load
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

run_or_print() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    printf '+'
    for arg in "$@"; do
      printf ' %q' "${arg}"
    done
    printf '\n'
    return 0
  fi

  if [[ "${1:-}" == "docker" ]]; then
    shift
    docker_local "$@"
  else
    "$@"
  fi
}

run_docker_build_with_base_fallback() {
  local current_base_image="$1"
  local fallback_base_image="$2"
  shift 2

  local output_file
  output_file="$(mktemp "${TMPDIR:-/tmp}/pacific-rim-ros2-docker-build.XXXXXX")"

  if image_ref_is_harbor "${current_base_image}"; then
    login_harbor_if_enabled || true
  fi

  set +e
  run_or_print "$@" 2>&1 | tee "${output_file}"
  local status=${PIPESTATUS[0]}
  set -e

  if [[ "${status}" -eq 0 ]]; then
    rm -f "${output_file}"
    return 0
  fi

  local retry_base_image=""
  if base_image_failure_output "${output_file}"; then
    if [[ -n "${fallback_base_image}" && "${current_base_image}" != "${fallback_base_image}" ]]; then
      retry_base_image="${fallback_base_image}"
    else
      retry_base_image="$(ros_base_retry_image_for "${current_base_image}" || true)"
    fi
  fi

  if [[ -n "${retry_base_image}" && "${current_base_image}" != "${retry_base_image}" ]]; then
    echo "Docker build failed while resolving ROS base image: ${current_base_image}"
    echo "Retrying with ROS base image: ${retry_base_image}"
    if image_ref_is_harbor "${retry_base_image}"; then
      login_harbor_if_enabled
    fi

    local retry_args=("$@")
    local idx
    for idx in "${!retry_args[@]}"; do
      if [[ "${retry_args[${idx}]}" == "ROS_BASE_IMAGE=${current_base_image}" ]]; then
        retry_args[${idx}]="ROS_BASE_IMAGE=${retry_base_image}"
      fi
    done

    set +e
    run_or_print "${retry_args[@]}" 2>&1 | tee "${output_file}"
    status=${PIPESTATUS[0]}
    set -e
  fi

  rm -f "${output_file}"
  return "${status}"
}

ensure_deploy_base_image() {
  local dockerfile="$1"
  local platform="$2"
  local effective_base_image="$3"

  RESOLVED_DEPLOY_BASE_IMAGE=""

  if [[ "${DEPLOY_BASE_IMAGE_PREPARE}" != "1" ]]; then
    if [[ -n "${DEPLOY_BASE_IMAGE}" ]]; then
      RESOLVED_DEPLOY_BASE_IMAGE="${DEPLOY_BASE_IMAGE}"
    else
      RESOLVED_DEPLOY_BASE_IMAGE="deploy-base"
    fi
    return 0
  fi

  if [[ -n "${DEPLOY_BASE_IMAGE}" ]]; then
    RESOLVED_DEPLOY_BASE_IMAGE="${DEPLOY_BASE_IMAGE}"
    return 0
  fi

  local base_image
  base_image="$(deploy_base_image_tag "${platform}")"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "+ ensure deploy base image ${base_image}"
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  if deploy_base_image_is_current "${base_image}" "${platform}" >/dev/null 2>&1; then
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PULL}" == "1" ]] \
    && pull_image_from_harbor "${base_image}" "deploy base image" "${platform}" \
    && deploy_base_image_is_current "${base_image}" "${platform}" >/dev/null 2>&1; then
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  if reuse_ros2_image_as_deploy_base "${base_image}" "${platform}"; then
    if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PUSH}" == "1" ]]; then
      push_image_to_harbor_or_warn "${base_image}" "deploy base image"
    fi
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  local lock_dir lock_key
  mkdir -p "${ROOT_DIR}/.cache/ros2-docker"
  lock_key="$(sanitize_lock_name "${base_image}-${platform:-native}-${effective_base_image}")"
  lock_dir="${ROOT_DIR}/.cache/ros2-docker/${lock_key}.lock"

  local last_wait_pull_attempt=0
  while ! mkdir "${lock_dir}" 2>/dev/null; do
    echo "Waiting for deploy base image build lock: ${base_image}"
    sleep 5
    if deploy_base_image_is_current "${base_image}" "${platform}" >/dev/null 2>&1; then
      RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
      return 0
    fi
    local now
    now="$(date +%s)"
    if [[ $((now - last_wait_pull_attempt)) -lt "${HARBOR_DEPLOY_BASE_WAIT_PULL_INTERVAL:-60}" ]]; then
      continue
    fi
    last_wait_pull_attempt="${now}"
    if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PULL}" == "1" ]] \
      && pull_image_from_harbor "${base_image}" "deploy base image" "${platform}" \
      && deploy_base_image_is_current "${base_image}" "${platform}" >/dev/null 2>&1; then
      RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
      return 0
    fi
    if reuse_ros2_image_as_deploy_base "${base_image}" "${platform}"; then
      if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PUSH}" == "1" ]]; then
        push_image_to_harbor_or_warn "${base_image}" "deploy base image"
      fi
      RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
      return 0
    fi
  done

  local cleanup_lock=1
  trap 'if [[ "${cleanup_lock:-0}" == "1" ]]; then rmdir "${lock_dir}" 2>/dev/null || true; fi; trap - RETURN' RETURN

  if deploy_base_image_is_current "${base_image}" "${platform}" >/dev/null 2>&1; then
    cleanup_lock=0
    rmdir "${lock_dir}" 2>/dev/null || true
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PULL}" == "1" ]] \
    && pull_image_from_harbor "${base_image}" "deploy base image" "${platform}" \
    && deploy_base_image_is_current "${base_image}" "${platform}" >/dev/null 2>&1; then
    cleanup_lock=0
    rmdir "${lock_dir}" 2>/dev/null || true
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  if reuse_ros2_image_as_deploy_base "${base_image}" "${platform}"; then
    if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PUSH}" == "1" ]]; then
      push_image_to_harbor_or_warn "${base_image}" "deploy base image"
    fi
    cleanup_lock=0
    rmdir "${lock_dir}" 2>/dev/null || true
    RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
    return 0
  fi

  echo "Building deploy base image: ${base_image}"
  local docker_build=(docker build -f "${dockerfile}" --target deploy-base -t "${base_image}")
  if [[ -n "${platform}" ]]; then
    docker_build+=(--platform "${platform}")
  fi
  docker_build+=(--build-arg "ROS_DISTRO=${ROS_DISTRO}")
  docker_build+=(--build-arg "ROS_BASE_IMAGE=${effective_base_image}")
  docker_build+=(--build-arg "GO_VERSION=${GO_VERSION:-1.25.5}")
  docker_build+=(--build-arg "GO_DOWNLOAD_BASE=${GO_DOWNLOAD_BASE}")
  docker_build+=(--build-arg "GOPROXY=${GOPROXY}")
  docker_build+=(--build-arg "GOSUMDB=${GOSUMDB}")
  docker_build+=(--build-arg "INSTALL_GOLANG=${INSTALL_GOLANG}")
  docker_build+=(--build-arg "PACIFIC_RIM_GO_BUILD_TAGS=${PACIFIC_RIM_GO_BUILD_TAGS}")
  docker_build+=(--build-arg "ENABLE_VISION_STACK=${ENABLE_VISION_STACK}")
  docker_build+=(--build-arg "VISION_TARGET=${VISION_TARGET}")
  docker_build+=(--build-arg "ONNX_VERSION=${ONNX_VERSION}")
  docker_build+=(--build-arg "PYTHON_RUNTIME_REQUIREMENTS_SHA=$(deploy_base_runtime_requirements_sha)")
  docker_build+=("${ROOT_DIR}")

  run_docker_build_with_base_fallback "${effective_base_image}" "$(ros_base_retry_image_for "${effective_base_image}" "${platform}" || true)" "${docker_build[@]}"

  if [[ "${HARBOR_DEPLOY_BASE_IMAGE_PUSH}" == "1" ]]; then
    push_image_to_harbor_or_warn "${base_image}" "deploy base image"
  fi

  cleanup_lock=0
  rmdir "${lock_dir}" 2>/dev/null || true
  RESOLVED_DEPLOY_BASE_IMAGE="${base_image}"
}

remote_exec_argv() {
  local user_host="$1"
  local port="$2"
  shift 2

  local command=""
  local arg
  for arg in "$@"; do
    if [[ -n "${command}" ]]; then
      command+=" "
    fi
    command+="$(shell_quote "${arg}")"
  done

  run_ssh_or_print "${user_host}" "${port}" "${command}"
}

remote_docker_rm() {
  local user_host="$1"
  local port="$2"
  local container_name="$3"
  local command="docker rm -f $(shell_quote "${container_name}") >/dev/null 2>&1 || true"
  run_ssh_or_print "${user_host}" "${port}" "${command}"
}

remote_docker_logs() {
  local user_host="$1"
  local port="$2"
  local container_name="$3"
  local logs_tail="$4"
  local command="sleep 2; docker logs --tail $(shell_quote "${logs_tail}") $(shell_quote "${container_name}") 2>&1 || true"
  if ! run_ssh_or_print "${user_host}" "${port}" "${command}"; then
    echo "Warning: failed to fetch remote container logs for ${container_name}; deployment already started." >&2
  fi
  return 0
}

remote_arch_to_platform() {
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

remote_arch_from_output() {
  local output="$1"
  local arch

  arch="$(printf '%s\n' "${output}" | tr -d '\r' | awk '
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
  ')"
  if [[ -n "${arch}" ]]; then
    printf '%s\n' "${arch}"
    return
  fi

  return 1
}

detect_remote_platform() {
  local user_host="$1"
  local port="$2"
  local arch

  local output
  set +e
  output="$(ssh_exec "${user_host}" "${port}" "uname -m" 2>&1)"
  local status=$?
  set -e
  if [[ "${status}" -ne 0 ]]; then
    echo "Failed to connect to ${user_host} over SSH while detecting remote architecture." >&2
    echo "Check --user/--password, SSH key access, host reachability, and remote sshd password authentication." >&2
    if [[ -n "${output}" ]]; then
      printf '%s\n' "${output}" >&2
    fi
    return "${status}"
  fi

  if ! arch="$(remote_arch_from_output "${output}")"; then
    arch=""
  fi
  if [[ -z "${arch}" ]]; then
    echo "Failed to detect remote architecture for ${user_host}." >&2
    if [[ -n "${output}" ]]; then
      printf '%s\n' "${output}" >&2
    fi
    return 1
  fi

  local platform
  if ! platform="$(remote_arch_to_platform "${arch}")"; then
    echo "Unsupported remote architecture \"${arch}\" for ${user_host}. Pass --platform explicitly." >&2
    return 1
  fi

  printf '%s %s\n' "${arch}" "${platform}"
}

find_ros2_package_xml() {
  local package_name="$1"

  find "${ROOT_DIR}" \
    -path "${ROOT_DIR}/build" -prune -o \
    -path "${ROOT_DIR}/install" -prune -o \
    -path "${ROOT_DIR}/log" -prune -o \
    -path "${ROOT_DIR}/node_modules" -prune -o \
    -name package.xml -print | while IFS= read -r candidate; do
      local candidate_name
      candidate_name="$(sed -n 's:.*<name>[[:space:]]*\([^<[:space:]]*\)[[:space:]]*</name>.*:\1:p' "${candidate}" | head -n 1)"
      if [[ "${candidate_name}" == "${package_name}" ]]; then
        printf '%s\n' "${candidate}"
        break
      fi
    done
}

resolve_ros2_package_dir() {
  local package_name="$1"
  local package_xml
  package_xml="$(find_ros2_package_xml "${package_name}")"

  [[ -n "${package_xml}" ]] || return 1
  dirname "${package_xml}"
}

resolve_ros2_executable() {
  local package_name="$1"
  local package_xml
  package_xml="$(find_ros2_package_xml "${package_name}")"

  if [[ -z "${package_xml}" ]]; then
    printf '%s_node\n' "${package_name}"
    return
  fi

  local module_dir
  module_dir="$(dirname "${package_xml}")"

  if [[ -f "${module_dir}/setup.py" ]]; then
    local python_executable
    python_executable="$(sed -n "s/^[[:space:]]*['\"]\\([^'\"]*\\)[[:space:]]*=[[:space:]]*[^'\"]*:main['\"].*/\\1/p" "${module_dir}/setup.py" | sed 's/[[:space:]]*$//' | head -n 1)"
    if [[ -n "${python_executable}" ]]; then
      printf '%s\n' "${python_executable}"
      return
    fi
  fi

  if [[ -f "${module_dir}/CMakeLists.txt" ]]; then
    local cpp_executable
    cpp_executable="$(sed -n 's/^[[:space:]]*add_executable([[:space:]]*\([A-Za-z0-9_.-][A-Za-z0-9_.-]*\).*/\1/p' "${module_dir}/CMakeLists.txt" | head -n 1)"
    if [[ -n "${cpp_executable}" ]]; then
      printf '%s\n' "${cpp_executable}"
      return
    fi
  fi

  printf '%s_node\n' "${package_name}"
}

deploy_image_remote() {
  local host=""
  local user="${DEPLOY_USER:-jetson}"
  local password="${DEPLOY_PASSWORD:-}"
  local port="${DEPLOY_PORT:-22}"
  local package_name=""
  local executable_name=""
  local domain_id="${ROS_DOMAIN_ID:-42}"
  local image=""
  local container_name=""
  local platform=""
  local base_image=""
  local network="host"
  local restart_policy="unless-stopped"
  local no_cache="0"
  local pull_base="0"
  local privileged="0"
  local dry_run="0"
  local show_logs="1"
  local logs_tail="${DEPLOY_LOGS_TAIL:-120}"
  local run_args=()
  local env_args=()
  local device_args=()
  local volume_args=()
  local build_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)
        host="${2:-}"
        shift 2
        ;;
      --user)
        user="${2:-}"
        shift 2
        ;;
      --password)
        password="${2:-}"
        shift 2
        ;;
      --port)
        port="${2:-}"
        shift 2
        ;;
      --packages-select|--package)
        package_name="${2:-}"
        shift 2
        ;;
      --executable)
        executable_name="${2:-}"
        shift 2
        ;;
      --domain-id)
        domain_id="${2:-}"
        shift 2
        ;;
      --image)
        image="${2:-}"
        shift 2
        ;;
      --container-name)
        container_name="${2:-}"
        shift 2
        ;;
      --platform)
        platform="${2:-}"
        shift 2
        ;;
      --base-image)
        base_image="${2:-}"
        shift 2
        ;;
      --deploy-base-image)
        DEPLOY_BASE_IMAGE="${2:-}"
        DEPLOY_BASE_IMAGE_PREPARE="1"
        shift 2
        ;;
      --no-deploy-base-image)
        DEPLOY_BASE_IMAGE=""
        DEPLOY_BASE_IMAGE_PREPARE="0"
        shift
        ;;
      --push-to-harbor)
        HARBOR_DEPLOY_IMAGE_PUSH="1"
        shift
        ;;
      --no-push-to-harbor)
        HARBOR_DEPLOY_IMAGE_PUSH="0"
        shift
        ;;
      --pull-from-harbor)
        HARBOR_DEPLOY_IMAGE_PULL="1"
        shift
        ;;
      --no-pull-from-harbor)
        HARBOR_DEPLOY_IMAGE_PULL="0"
        shift
        ;;
      --load-image)
        HARBOR_DEPLOY_IMAGE_FALLBACK_LOAD="1"
        shift
        ;;
      --no-load-image)
        HARBOR_DEPLOY_IMAGE_FALLBACK_LOAD="0"
        shift
        ;;
      --network)
        network="${2:-}"
        shift 2
        ;;
      --env|-e)
        env_args+=("${2:-}")
        shift 2
        ;;
      --device)
        device_args+=("${2:-}")
        shift 2
        ;;
      --volume|-v)
        volume_args+=("${2:-}")
        shift 2
        ;;
      --run-arg)
        run_args+=("${2:-}")
        shift 2
        ;;
      --build-arg)
        build_args+=("${2:-}")
        shift 2
        ;;
      --restart)
        restart_policy="${2:-}"
        shift 2
        ;;
      --logs-tail)
        logs_tail="${2:-}"
        shift 2
        ;;
      --no-logs)
        show_logs="0"
        shift
        ;;
      --pull)
        pull_base="1"
        shift
        ;;
      --privileged)
        privileged="1"
        shift
        ;;
      --no-cache)
        no_cache="1"
        shift
        ;;
      --dry-run)
        dry_run="1"
        shift
        ;;
      *)
        echo "Unknown deploy-image option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "${host}" ]]; then
    echo "--host is required for deploy-image" >&2
    usage
    exit 1
  fi

  if [[ -z "${package_name}" ]]; then
    echo "--packages-select is required for deploy-image" >&2
    usage
    exit 1
  fi

  if [[ ! "${domain_id}" =~ ^[0-9]+$ ]]; then
    echo "--domain-id must be a non-negative integer" >&2
    exit 1
  fi

  if [[ "${show_logs}" == "1" && ! "${logs_tail}" =~ ^[0-9]+$ ]]; then
    echo "--logs-tail must be a non-negative integer" >&2
    exit 1
  fi

  if [[ -z "${executable_name}" ]]; then
    executable_name="$(resolve_ros2_executable "${package_name}")"
  fi

  local package_dir package_dir_rel
  if ! package_dir="$(resolve_ros2_package_dir "${package_name}")"; then
    echo "Could not find package.xml for ROS2 package ${package_name}" >&2
    exit 1
  fi
  case "${package_dir}" in
    "${ROOT_DIR}"/*)
      package_dir_rel="${package_dir#${ROOT_DIR}/}"
      ;;
    *)
      echo "Resolved package directory is outside the workspace: ${package_dir}" >&2
      exit 1
      ;;
  esac

  if [[ -z "${container_name}" ]]; then
    container_name="${package_name}"
  fi

  local dockerfile="${ROOT_DIR}/deploy/remote/ros2/Dockerfile"
  if [[ ! -f "${dockerfile}" ]]; then
    echo "Remote ROS2 Dockerfile was not found: ${dockerfile}" >&2
    exit 1
  fi

  local user_host="${user}@${host}"

  DRY_RUN="${dry_run}"
  DEPLOY_PASSWORD_VALUE="${password}"

  if [[ -z "${platform}" ]]; then
    if [[ "${dry_run}" == "1" ]]; then
      echo "Skipping remote architecture detection during dry-run. Pass --platform to preview the exact build platform."
    else
      local detected
      detected="$(detect_remote_platform "${user_host}" "${port}")"
      local detected_arch="${detected%% *}"
      platform="${detected#* }"
      echo "Detected remote architecture: ${detected_arch} -> ${platform}"
    fi
  fi

  if [[ "${REQUESTED_VISION_TARGET}" == "auto" ]]; then
    if [[ -z "${platform}" ]]; then
      echo "VISION_TARGET=auto requires --platform during dry-run because remote architecture detection is skipped." >&2
      exit 1
    fi
    local detected_vision_target
    detected_vision_target="$(vision_target_from_platform "${platform}")"
    configure_vision_target "${detected_vision_target}"
    echo "Auto-detected VISION_TARGET=${VISION_TARGET} from platform ${platform}."
  fi

  if [[ -z "${image}" ]]; then
    image="pacific-rim-ros2-${package_name}:${ROS2_IMAGE_TAG}"
  fi

  local effective_base_image="${base_image:-$(harbor_ros_base_image_for_platform "${platform}")}"
  ensure_deploy_base_image "${dockerfile}" "${platform}" "${effective_base_image}"
  local deploy_base_image="${RESOLVED_DEPLOY_BASE_IMAGE}"
  echo "Deploy base image: ${deploy_base_image}"

  local docker_build=(docker build -f "${dockerfile}" -t "${image}" --build-context "current_service=${package_dir}")
  if [[ -n "${platform}" ]]; then
    docker_build+=(--platform "${platform}")
  fi
  if [[ "${pull_base}" == "1" ]]; then
    docker_build+=(--pull)
  fi
  if [[ "${no_cache}" == "1" ]]; then
    docker_build+=(--no-cache)
  fi
  docker_build+=(--build-arg "ROS_DISTRO=${ROS_DISTRO}")
  docker_build+=(--build-arg "ROS_BASE_IMAGE=${effective_base_image}")
  docker_build+=(--build-arg "DEPLOY_BASE_IMAGE=${deploy_base_image}")
  docker_build+=(--build-arg "ROS_PACKAGE=${package_name}")
  docker_build+=(--build-arg "ROS_SERVICE_DIR=${package_dir_rel}")
  docker_build+=(--build-arg "ROS_EXECUTABLE=${executable_name}")
  docker_build+=(--build-arg "GO_VERSION=${GO_VERSION:-1.25.5}")
  docker_build+=(--build-arg "GO_DOWNLOAD_BASE=${GO_DOWNLOAD_BASE}")
  docker_build+=(--build-arg "GOPROXY=${GOPROXY}")
  docker_build+=(--build-arg "GOSUMDB=${GOSUMDB}")
  docker_build+=(--build-arg "INSTALL_GOLANG=${INSTALL_GOLANG}")
  docker_build+=(--build-arg "PACIFIC_RIM_GO_BUILD_TAGS=${PACIFIC_RIM_GO_BUILD_TAGS}")
  docker_build+=(--build-arg "ENABLE_VISION_STACK=${ENABLE_VISION_STACK}")
  docker_build+=(--build-arg "VISION_TARGET=${VISION_TARGET}")
  docker_build+=(--build-arg "ONNX_VERSION=${ONNX_VERSION}")
  local build_arg
  if [[ "${#build_args[@]}" -gt 0 ]]; then
    for build_arg in "${build_args[@]}"; do
      docker_build+=(--build-arg "${build_arg}")
    done
  fi
  docker_build+=("${ROOT_DIR}")

  local remote_run=(docker run -d --name "${container_name}" --restart "${restart_policy}")
  if [[ -n "${network}" ]]; then
    remote_run+=(--network "${network}")
  fi
  remote_run+=(-e "ROS_DOMAIN_ID=${domain_id}")
  remote_run+=(-e "RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION}")
  remote_run+=(-e "ROS_DISTRO=${ROS_DISTRO}")
  remote_run+=(-e "ENABLE_VISION_STACK=${ENABLE_VISION_STACK}")
  remote_run+=(-e "VISION_TARGET=${VISION_TARGET}")
  case "${VISION_TARGET}" in
    pc-nvidia)
      remote_run+=(--gpus all)
      remote_run+=(-e "NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES}")
      remote_run+=(-e "NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES}")
      ;;
    jetson)
      if [[ -n "${NVIDIA_CONTAINER_RUNTIME}" && "${NVIDIA_CONTAINER_RUNTIME}" != "none" ]]; then
        remote_run+=(--runtime "${NVIDIA_CONTAINER_RUNTIME}")
      fi
      remote_run+=(-e "NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES}")
      remote_run+=(-e "NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES}")
      ;;
  esac
  if [[ -n "${PLATFORM_OTLP_ENDPOINT:-}" ]]; then
    remote_run+=(-e "OTEL_EXPORTER_OTLP_ENDPOINT=${PLATFORM_OTLP_ENDPOINT}")
  fi
  local env_arg
  if [[ "${#env_args[@]}" -gt 0 ]]; then
    for env_arg in "${env_args[@]}"; do
      remote_run+=(-e "${env_arg}")
    done
  fi
  local device_arg
  if [[ "${#device_args[@]}" -gt 0 ]]; then
    for device_arg in "${device_args[@]}"; do
      remote_run+=(--device "${device_arg}")
    done
  fi
  local volume_arg
  if [[ "${#volume_args[@]}" -gt 0 ]]; then
    for volume_arg in "${volume_args[@]}"; do
      remote_run+=(-v "${volume_arg}")
    done
  fi
  if [[ "${privileged}" == "1" ]]; then
    remote_run+=(--privileged)
  fi
  local run_arg
  if [[ "${#run_args[@]}" -gt 0 ]]; then
    for run_arg in "${run_args[@]}"; do
      remote_run+=("${run_arg}")
    done
  fi
  remote_run+=("${image}")

  echo "Deploying ROS2 package ${package_name} (${executable_name}) to ${user_host}"
  echo "Image: ${image}"
  run_docker_build_with_base_fallback "${effective_base_image}" "$(ros_base_retry_image_for "${effective_base_image}" "${platform}" || true)" "${docker_build[@]}"

  local deployed_via_harbor="0"
  local harbor_deploy_ref=""
  if [[ "${HARBOR_DEPLOY_IMAGE_PUSH}" == "1" ]]; then
    if push_image_to_harbor "${image}" "deploy image"; then
      harbor_deploy_ref="${HARBOR_PUSHED_REF}"
    else
      echo "Warning: failed to push deploy image to Harbor; falling back to docker save/load." >&2
    fi
  fi

  if [[ -n "${harbor_deploy_ref}" && "${HARBOR_DEPLOY_IMAGE_PULL}" == "1" ]]; then
    if remote_pull_harbor_image "${image}" "${harbor_deploy_ref}" "${user_host}" "${port}"; then
      deployed_via_harbor="1"
    else
      echo "Warning: remote Harbor pull failed; falling back to docker save/load." >&2
    fi
  fi

  if [[ "${deployed_via_harbor}" != "1" ]]; then
    if [[ "${HARBOR_DEPLOY_IMAGE_FALLBACK_LOAD}" != "1" ]]; then
      echo "Deploy image was not loaded because Harbor pull failed and docker save/load fallback is disabled." >&2
      exit 1
    fi
    ssh_load_image "${image}" "${user_host}" "${port}"
  fi
  remote_docker_rm "${user_host}" "${port}" "${container_name}"
  remote_exec_argv "${user_host}" "${port}" "${remote_run[@]}"
  if ! remote_exec_argv "${user_host}" "${port}" docker ps --filter "name=${container_name}"; then
    echo "Warning: failed to query remote container status for ${container_name}; deployment already started." >&2
  fi
  if [[ "${show_logs}" == "1" ]]; then
    echo "Container logs (${container_name}, tail ${logs_tail}):"
    remote_docker_logs "${user_host}" "${port}" "${container_name}" "${logs_tail}"
  fi
}

deploy_base_image_command() {
  local platform=""
  local base_image=""
  local dry_run="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform)
        platform="${2:-}"
        shift 2
        ;;
      --base-image)
        base_image="${2:-}"
        shift 2
        ;;
      --deploy-base-image)
        DEPLOY_BASE_IMAGE="${2:-}"
        DEPLOY_BASE_IMAGE_PREPARE="1"
        shift 2
        ;;
      --no-deploy-base-image)
        DEPLOY_BASE_IMAGE=""
        DEPLOY_BASE_IMAGE_PREPARE="0"
        shift
        ;;
      --dry-run)
        dry_run="1"
        shift
        ;;
      *)
        echo "Unknown deploy-base-image option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  local dockerfile="${ROOT_DIR}/deploy/remote/ros2/Dockerfile"
  if [[ ! -f "${dockerfile}" ]]; then
    echo "Remote ROS2 Dockerfile was not found: ${dockerfile}" >&2
    exit 1
  fi

  DRY_RUN="${dry_run}"
  ensure_deploy_base_image "${dockerfile}" "${platform}" "${base_image:-$(harbor_ros_base_image_for_platform "${platform}")}"
  echo "Deploy base image ready: ${RESOLVED_DEPLOY_BASE_IMAGE}"
}

deploy_remote() {
  local host=""
  local user="${DEPLOY_USER:-jetson}"
  local password="${DEPLOY_PASSWORD:-}"
  local port="${DEPLOY_PORT:-22}"
  local remote_dir="${DEPLOY_REMOTE_DIR:-/tmp/pacific-rim-deploy}"
  local package_name=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)
        host="${2:-}"
        shift 2
        ;;
      --user)
        user="${2:-}"
        shift 2
        ;;
      --password)
        password="${2:-}"
        shift 2
        ;;
      --port)
        port="${2:-}"
        shift 2
        ;;
      --remote-dir)
        remote_dir="${2:-}"
        shift 2
        ;;
      --packages-select)
        package_name="${2:-}"
        shift 2
        ;;
      *)
        echo "Unknown deploy option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "${host}" ]]; then
    echo "--host is required for deploy" >&2
    usage
    exit 1
  fi

  DEPLOY_PASSWORD_VALUE="${password}"

  local user_host="${user}@${host}"
  remote_exec "${user_host}" "${port}" "mkdir -p ${remote_dir}"
  tar czf - \
    --exclude .git \
    --exclude node_modules \
    --exclude .next \
    --exclude dist \
    --exclude build \
    --exclude .cache \
    . | remote_exec "${user_host}" "${port}" "tar xzf - -C ${remote_dir}"
  local build_cmd="cd ${remote_dir} && scripts/ros2-docker.sh build"
  if [[ -n "${package_name}" ]]; then
    build_cmd="${build_cmd} --packages-select ${package_name}"
  fi
  remote_exec "${user_host}" "${port}" "${build_cmd}"
}

command="${1:-shell}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "${command}" in
  build-image)
    run_with_harbor_fallback "ROS2 image build" build_ros2_image
    ;;
  deploy-base-image)
    deploy_base_image_command "$@"
    ;;
  up-observability)
    compose up -d loki tempo prometheus grafana otel-collector
    print_observability_urls
    ;;
  logs-observability)
    compose logs -f otel-collector loki tempo prometheus grafana
    ;;
  down)
    compose down
    ;;
  shell)
    run_with_harbor_fallback "ROS2 shell" run_shell "$@"
    ;;
  monitor-container)
    run_with_harbor_fallback "ROS2 monitor container" run_monitor_container "$@"
    ;;
  build)
    build_log_base="$(colcon_arg_value "--log-base" "$(colcon_default_base "log")" "$@")"
    ROS2_VISION_RUNTIME=0 run_with_harbor_fallback "ROS2 build" run_ros "colcon --log-base $(printf '%q' "${build_log_base}") build $(colcon_build_args "$@")"
    ;;
  test)
    test_result_base="$(colcon_arg_value "--build-base" "$(colcon_default_base "build")" "$@")"
    test_log_base="$(colcon_arg_value "--log-base" "$(colcon_default_base "log")" "$@")"
    ROS2_VISION_RUNTIME=0 run_with_harbor_fallback "ROS2 test" run_ros "colcon --log-base $(printf '%q' "${test_log_base}") test $(colcon_workspace_args "$@") && colcon test-result --test-result-base $(printf '%q' "${test_result_base}") --verbose"
    ;;
  run)
    if [[ $# -eq 0 ]]; then
      usage
      exit 1
    fi
    ROS_RUN_SOURCE_INSTALL="${ROS_RUN_SOURCE_INSTALL:-1}" run_with_harbor_fallback "ROS2 run" run_ros "$@"
    ;;
  deploy-image)
    deploy_image_remote "$@"
    ;;
  deploy)
    deploy_remote "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
