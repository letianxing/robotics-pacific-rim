#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REGISTRY=""
DEFAULT_PROJECT="library"
DEFAULT_USERNAME=""
DEFAULT_PASSWORD=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

registry="${HARBOR_REGISTRY:-${DEFAULT_REGISTRY}}"
project="${HARBOR_PROJECT:-${DEFAULT_PROJECT}}"
harbor_username="${HARBOR_USERNAME:-${DEFAULT_USERNAME}}"
harbor_password="${HARBOR_PASSWORD:-${DEFAULT_PASSWORD}}"
source_image="${ROS_BASE_SOURCE_IMAGE:-}"
dry_run="0"
login_first="${HARBOR_LOGIN:-0}"
include_ros2="0"
multi_arch_ros_base="0"
pull_missing_platforms="1"
load_tars="1"
tar_files=()
image_refs=()

usage() {
  cat <<'USAGE'
Usage:
  image/push-to-harbor.sh [options] [image:tag...]

Defaults:
  - registry: unset; pass --registry or set HARBOR_REGISTRY
  - project:  library
  - login:    disabled unless --login or HARBOR_LOGIN=1 is set
  - no image arguments: load and push image/*.tar

Options:
  --registry <host:port>   Harbor registry. Defaults to HARBOR_REGISTRY.
  --project <name>         Harbor project. Defaults to HARBOR_PROJECT or library.
  --username <name>        Harbor username. Defaults to HARBOR_USERNAME.
  --password <value>       Harbor password. Defaults to HARBOR_PASSWORD.
  --no-project             Push directly under the registry without adding a project path.
  --tar <path>             Load and push a specific docker save tar. Can be repeated.
  --no-load                Do not load tar archives; only push image arguments.
  --ros2                   Also push ros:${ROS_DISTRO:-jazzy}-ros-base and pacific-rim-ros2:${ROS_DISTRO:-jazzy} if present.
  --multi-arch-ros-base    Push amd64/arm64 ROS base arch tags, then publish a multi-arch ROS base tag.
  --source-image <image>   Source ROS base image for --multi-arch-ros-base. Overrides the default source list.
  --no-pull                For --multi-arch-ros-base, do not pull missing platforms from Docker Hub.
  --login                  Run docker login before pushing. This is enabled by default.
  --no-login               Skip docker login.
  --dry-run                Print docker commands without running tag/push/load.
  -h, --help               Show this help.

Examples:
  image/push-to-harbor.sh --registry <registry-host:port>
  image/push-to-harbor.sh --registry <registry-host:port> --ros2
  image/push-to-harbor.sh --registry <registry-host:port> --multi-arch-ros-base
  image/push-to-harbor.sh --registry <registry-host:port> --multi-arch-ros-base --source-image <mirror>/library/ros:jazzy-ros-base
  image/push-to-harbor.sh --registry <registry-host:port> ros:jazzy-ros-base pacific-rim-ros2:jazzy
  HARBOR_PROJECT=robot image/push-to-harbor.sh --registry <registry-host:port> --tar image/postgres-17-alpine.tar

Linux Docker must trust an HTTP Harbor registry, for example:
  /etc/docker/daemon.json -> {"insecure-registries":["<registry-host:port>"]}
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

append_unique_image() {
  local ref="$1"
  local existing
  for existing in "${image_refs[@]}"; do
    if [[ "${existing}" == "${ref}" ]]; then
      return
    fi
  done
  image_refs+=("${ref}")
}

normalize_registry() {
  local value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%/}"
  printf '%s\n' "${value}"
}

run_cmd() {
  if [[ "${dry_run}" == "1" ]]; then
    printf '+'
    local arg
    for arg in "$@"; do
      printf ' %q' "${arg}"
    done
    printf '\n'
    return 0
  fi

  "$@"
}

docker_login() {
  [[ -n "${registry}" ]] || die "set --registry or HARBOR_REGISTRY before logging in"
  [[ -n "${harbor_username}" ]] || die "set --username or HARBOR_USERNAME before logging in"
  [[ -n "${harbor_password}" ]] || die "set --password or HARBOR_PASSWORD before logging in"

  if [[ "${dry_run}" == "1" ]]; then
    printf '+ docker login %q --username %q --password-stdin\n' "${registry}" "${harbor_username}"
    return 0
  fi

  printf '%s' "${harbor_password}" | docker login "${registry}" --username "${harbor_username}" --password-stdin
}

tar_image_refs() {
  local tar_file="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi

  python3 - "${tar_file}" <<'PY'
import json
import sys
import tarfile

tar_path = sys.argv[1]
try:
    with tarfile.open(tar_path) as archive:
        try:
            manifest = archive.extractfile("manifest.json")
        except KeyError:
            sys.exit(0)
        if manifest is None:
            sys.exit(0)
        for item in json.load(manifest):
            for ref in item.get("RepoTags") or []:
                print(ref)
except Exception as exc:
    print(f"warning: failed to inspect {tar_path}: {exc}", file=sys.stderr)
PY
}

loaded_image_refs() {
  local output="$1"
  local line
  while IFS= read -r line; do
    case "${line}" in
      "Loaded image: "*)
        printf '%s\n' "${line#Loaded image: }"
        ;;
    esac
  done <<< "${output}"
}

target_ref_for() {
  local source_ref="$1"
  local ref_no_digest="${source_ref%@*}"

  if [[ "${ref_no_digest}" != "${source_ref}" ]]; then
    die "digest-only image refs are not supported for retagging: ${source_ref}"
  fi

  if [[ "${ref_no_digest}" == "${registry}/"* ]]; then
    printf '%s\n' "${ref_no_digest}"
    return
  fi

  local last_component="${ref_no_digest##*/}"
  local repo
  local tag
  if [[ "${last_component}" == *:* ]]; then
    tag="${last_component##*:}"
    repo="${ref_no_digest%:*}"
  else
    tag="latest"
    repo="${ref_no_digest}"
  fi

  local first_component="${repo%%/*}"
  if [[ "${repo}" == */* ]] && [[ "${first_component}" == *.* || "${first_component}" == *:* || "${first_component}" == "localhost" ]]; then
    repo="${repo#*/}"
  fi

  if [[ -n "${project}" ]]; then
    printf '%s/%s/%s:%s\n' "${registry}" "${project}" "${repo}" "${tag}"
  else
    printf '%s/%s:%s\n' "${registry}" "${repo}" "${tag}"
  fi
}

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

image_arch_matches() {
  local ref="$1"
  local arch="$2"
  local actual_arch
  actual_arch="$(docker image inspect --format '{{.Architecture}}' "${ref}" 2>/dev/null | head -n 1)"
  [[ "${actual_arch}" == "${arch}" ]]
}

manifest_exists() {
  docker manifest inspect --insecure "$1" >/dev/null 2>&1
}

manifest_arch_matches() {
  local ref="$1"
  local arch="$2"
  docker manifest inspect --insecure --verbose "${ref}" 2>/dev/null \
    | grep -q "\"architecture\":[[:space:]]*\"${arch}\""
}

append_unique_source() {
  local ref="$1"
  local existing
  for existing in "${ros_base_source_candidates[@]}"; do
    if [[ "${existing}" == "${ref}" ]]; then
      return
    fi
  done
  ros_base_source_candidates+=("${ref}")
}

push_image() {
  local source_ref="$1"
  local target_ref
  target_ref="$(target_ref_for "${source_ref}")"

  if [[ "${source_ref}" != "${target_ref}" ]]; then
    run_cmd docker tag "${source_ref}" "${target_ref}"
  fi

  echo "Pushing ${target_ref}"
  if ! run_cmd docker push "${target_ref}"; then
    cat >&2 <<EOF
error: docker push failed for ${target_ref}

If Harbor is served over HTTP, configure this Docker daemon first:
  sudo mkdir -p /etc/docker
  sudo sh -c 'printf "%s\n" '"'"'{"insecure-registries":["${registry}"]}'"'"' > /etc/docker/daemon.json'
  sudo systemctl restart docker
  docker login ${registry}

If the error says "no basic auth credentials", login first:
  docker login ${registry}
  ${0} --login ${source_ref}

If login succeeds but push is still denied, create the Harbor project "${project:-<none>}"
or pass the correct one with:
  ${0} --project <project> ${source_ref}
EOF
    exit 1
  fi
}

push_ros_base_platform_image() {
  local platform="$1"
  local target_ref="$2"
  local existing_multi_ref="$3"
  local arch="${platform##*/}"
  local source_ref=""

  if [[ "${dry_run}" != "1" ]] && manifest_exists "${target_ref}"; then
    echo "Using existing Harbor platform image: ${target_ref}"
    return 0
  fi

  if [[ "${dry_run}" != "1" ]] \
    && [[ "${existing_multi_ref}" != "${target_ref}" ]] \
    && manifest_arch_matches "${existing_multi_ref}" "${arch}"; then
    echo "Reusing existing Harbor ${arch} image: ${existing_multi_ref}"
    run_cmd docker pull "${existing_multi_ref}"
    run_cmd docker tag "${existing_multi_ref}" "${target_ref}"
    echo "Pushing ${target_ref}"
    run_cmd docker push "${target_ref}"
    return 0
  fi

  if [[ "${pull_missing_platforms}" == "1" ]]; then
    local candidate
    for candidate in "${ros_base_source_candidates[@]}"; do
      echo "Pulling ${candidate} for ${platform}"
      if [[ "${dry_run}" == "1" ]]; then
        run_cmd docker pull --platform "${platform}" "${candidate}"
        source_ref="${candidate}"
        break
      fi

      set +e
      docker pull --platform "${platform}" "${candidate}"
      local pull_status=$?
      set -e
      if [[ "${pull_status}" -eq 0 ]]; then
        source_ref="${candidate}"
        break
      fi
      echo "Pull failed for ${candidate} (${platform}), trying next source." >&2
    done
  fi

  if [[ -z "${source_ref}" ]]; then
    source_ref="${ros_base_source_candidates[0]}"
  fi

  if [[ "${dry_run}" != "1" ]] && ! image_arch_matches "${source_ref}" "${arch}"; then
    die "local image ${source_ref} is not ${platform}. Re-run with --multi-arch-ros-base without --no-pull on a machine that can pull Docker Hub, or load this platform image first."
  fi

  run_cmd docker tag "${source_ref}" "${target_ref}"
  echo "Pushing ${target_ref}"
  run_cmd docker push "${target_ref}"
}

publish_ros_base_multi_arch() {
  local ros_distro="${ROS_DISTRO:-jazzy}"
  local target_source_ref="ros:${ros_distro}-ros-base"
  local target_ref
  target_ref="$(target_ref_for "${target_source_ref}")"

  local amd64_ref="${target_ref}-amd64"
  local arm64_ref="${target_ref}-arm64"
  ros_base_source_candidates=()
  if [[ -n "${source_image}" ]]; then
    append_unique_source "${source_image}"
  else
    append_unique_source "ros:${ros_distro}-ros-base"
    append_unique_source "docker.m.daocloud.io/library/ros:${ros_distro}-ros-base"
    append_unique_source "docker.1ms.run/library/ros:${ros_distro}-ros-base"
  fi

  push_ros_base_platform_image "linux/amd64" "${amd64_ref}" "${target_ref}"
  push_ros_base_platform_image "linux/arm64" "${arm64_ref}" "${target_ref}"

  echo "Creating multi-arch manifest: ${target_ref}"
  if [[ "${dry_run}" == "1" ]]; then
    run_cmd docker manifest create --insecure "${target_ref}" "${amd64_ref}" "${arm64_ref}"
    run_cmd docker manifest annotate "${target_ref}" "${amd64_ref}" --os linux --arch amd64
    run_cmd docker manifest annotate "${target_ref}" "${arm64_ref}" --os linux --arch arm64
    run_cmd docker manifest push --insecure "${target_ref}"
    return 0
  fi

  docker manifest rm "${target_ref}" >/dev/null 2>&1 || true
  docker manifest create --insecure "${target_ref}" "${amd64_ref}" "${arm64_ref}"
  docker manifest annotate "${target_ref}" "${amd64_ref}" --os linux --arch amd64
  docker manifest annotate "${target_ref}" "${arm64_ref}" --os linux --arch arm64
  docker manifest push --insecure "${target_ref}"
  docker manifest inspect --insecure --verbose "${target_ref}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)
      registry="${2:-}"
      shift 2
      ;;
    --project)
      project="${2:-}"
      shift 2
      ;;
    --username)
      harbor_username="${2:-}"
      shift 2
      ;;
    --password)
      harbor_password="${2:-}"
      shift 2
      ;;
    --no-project)
      project=""
      shift
      ;;
    --tar)
      tar_files+=("${2:-}")
      shift 2
      ;;
    --no-load)
      load_tars="0"
      shift
      ;;
    --ros2)
      include_ros2="1"
      shift
      ;;
    --multi-arch-ros-base)
      multi_arch_ros_base="1"
      load_tars="0"
      shift
      ;;
    --source-image)
      source_image="${2:-}"
      shift 2
      ;;
    --no-pull)
      pull_missing_platforms="0"
      shift
      ;;
    --login)
      login_first="1"
      shift
      ;;
    --no-login)
      login_first="0"
      shift
      ;;
    --dry-run)
      dry_run="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        append_unique_image "$1"
        shift
      done
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      append_unique_image "$1"
      shift
      ;;
  esac
done

registry="$(normalize_registry "${registry}")"
[[ -n "${registry}" ]] || die "set --registry or HARBOR_REGISTRY"
[[ -n "${registry}" ]] || die "registry must not be empty"

if [[ "${dry_run}" != "1" ]]; then
  command -v docker >/dev/null 2>&1 || die "docker is required"
fi

if [[ "${include_ros2}" == "1" ]]; then
  ros_distro="${ROS_DISTRO:-jazzy}"
  for ref in "ros:${ros_distro}-ros-base" "pacific-rim-ros2:${ros_distro}"; do
    if [[ "${dry_run}" == "1" ]] || image_exists "${ref}"; then
      append_unique_image "${ref}"
    else
      echo "Skipping missing local image: ${ref}" >&2
    fi
  done
fi

if [[ "${load_tars}" == "1" && ${#tar_files[@]} -eq 0 && ${#image_refs[@]} -eq 0 ]]; then
  while IFS= read -r -d '' tar_file; do
    tar_files+=("${tar_file}")
  done < <(find "${SCRIPT_DIR}" -maxdepth 1 -type f -name '*.tar' -print0)
fi

if [[ "${load_tars}" == "1" ]]; then
  for tar_file in "${tar_files[@]}"; do
    [[ -f "${tar_file}" ]] || die "tar file not found: ${tar_file}"
    echo "Loading ${tar_file}"

    if [[ "${dry_run}" == "1" ]]; then
      run_cmd docker load -i "${tar_file}"
      while IFS= read -r ref; do
        [[ -n "${ref}" ]] && append_unique_image "${ref}"
      done < <(tar_image_refs "${tar_file}")
      continue
    fi

    load_output="$(docker load -i "${tar_file}")"
    printf '%s\n' "${load_output}"
    found_ref="0"
    while IFS= read -r ref; do
      [[ -n "${ref}" ]] || continue
      found_ref="1"
      append_unique_image "${ref}"
    done < <(loaded_image_refs "${load_output}")

    if [[ "${found_ref}" == "0" ]]; then
      while IFS= read -r ref; do
        [[ -n "${ref}" ]] && append_unique_image "${ref}"
      done < <(tar_image_refs "${tar_file}")
    fi
  done
fi

if [[ "${login_first}" == "1" ]]; then
  docker_login
fi

if [[ "${multi_arch_ros_base}" == "1" ]]; then
  publish_ros_base_multi_arch
fi

if [[ "${multi_arch_ros_base}" == "1" && ${#image_refs[@]} -eq 0 ]]; then
  exit 0
fi

if [[ ${#image_refs[@]} -eq 0 ]]; then
  die "no images to push"
fi

echo "Target Harbor: ${registry}${project:+/${project}}"
for ref in "${image_refs[@]}"; do
  if [[ "${dry_run}" != "1" ]] && ! image_exists "${ref}"; then
    die "local image not found: ${ref}"
  fi
  push_image "${ref}"
done
