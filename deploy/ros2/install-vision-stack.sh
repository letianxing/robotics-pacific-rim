#!/usr/bin/env bash
set -euo pipefail

ROS_DISTRO="${ROS_DISTRO:-humble}"
ENABLE_VISION_STACK="${ENABLE_VISION_STACK:-0}"
VISION_TARGET="${VISION_TARGET:-none}"
ONNX_VERSION="${ONNX_VERSION:-1.16.2}"
TARGETARCH="${TARGETARCH:-}"
NVIDIA_CUDA_VERSION="${NVIDIA_CUDA_VERSION:-12-9}"
NVIDIA_JETSON_CUDA_VERSION="${NVIDIA_JETSON_CUDA_VERSION:-13-0}"
NVIDIA_CUDA_KEYRING_URL="${NVIDIA_CUDA_KEYRING_URL:-}"
JETSON_L4T_RELEASE="${JETSON_L4T_RELEASE:-r38.4}"
JETSON_L4T_REPOSITORIES="${JETSON_L4T_REPOSITORIES:-common}"
JETSON_L4T_KEY_URL="${JETSON_L4T_KEY_URL:-https://repo.download.nvidia.com/jetson/jetson-ota-public.asc}"
APT_RETRIES="${APT_RETRIES:-8}"
APT_TIMEOUT_SECONDS="${APT_TIMEOUT_SECONDS:-180}"
APT_INSTALL_ATTEMPTS="${APT_INSTALL_ATTEMPTS:-4}"
APT_REWRITE_UBUNTU_PORTS_MIRROR="${APT_REWRITE_UBUNTU_PORTS_MIRROR:-1}"
APT_UBUNTU_PORTS_MIRROR="${APT_UBUNTU_PORTS_MIRROR:-http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports}"

apt_get_common_options=(
  -o "Acquire::Retries=${APT_RETRIES}"
  -o "Acquire::http::Timeout=${APT_TIMEOUT_SECONDS}"
  -o "Acquire::https::Timeout=${APT_TIMEOUT_SECONDS}"
  -o "Acquire::http::Pipeline-Depth=0"
)

apt_get_update() {
  apt-get "${apt_get_common_options[@]}" update
}

apt_get_install() {
  local attempt status

  for ((attempt = 1; attempt <= APT_INSTALL_ATTEMPTS; attempt += 1)); do
    if apt-get "${apt_get_common_options[@]}" install -y --no-install-recommends "$@"; then
      return 0
    fi

    status="$?"
    if [[ "${attempt}" -ge "${APT_INSTALL_ATTEMPTS}" ]]; then
      return "${status}"
    fi

    echo "Warning: apt-get install failed with exit ${status}; retrying (${attempt}/${APT_INSTALL_ATTEMPTS})." >&2
    sleep $((attempt * 10))
    apt_get_update || true
  done
}

configure_ubuntu_ports_mirror() {
  if [[ "${APT_REWRITE_UBUNTU_PORTS_MIRROR}" != "1" || -z "${APT_UBUNTU_PORTS_MIRROR}" ]]; then
    return 0
  fi

  local mirror="${APT_UBUNTU_PORTS_MIRROR%/}"
  local escaped_mirror="${mirror//&/\\&}"
  local source_file

  echo "Using Ubuntu ports apt mirror: ${mirror}"
  for source_file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    [[ -f "${source_file}" ]] || continue
    sed -i -E "s#https?://ports.ubuntu.com/ubuntu-ports/?#${escaped_mirror}#g" "${source_file}"
  done
}

remove_stale_opencv_cmake_config() {
  local legacy_dir="/usr/lib/cmake/opencv4"
  local legacy_modules="${legacy_dir}/OpenCVModules.cmake"

  [[ -f "${legacy_modules}" ]] || return 0

  if grep -q "/usr/lib/libopencv_core" "${legacy_modules}" \
    && ! compgen -G "/usr/lib/libopencv_core.so*" >/dev/null; then
    echo "Removing stale OpenCV CMake config: ${legacy_dir}"
    rm -rf "${legacy_dir}"
  fi
}

install_opencv_dev_apt_candidate() {
  local repo_candidate installed_version

  repo_candidate="$(apt-cache madison libopencv-dev | awk 'NF >= 3 {print $3; exit}')"
  if [[ -z "${repo_candidate}" ]]; then
    repo_candidate="$(apt-cache policy libopencv-dev | awk '/Candidate:/ {print $2; exit}')"
  fi
  [[ -n "${repo_candidate}" && "${repo_candidate}" != "(none)" ]] || return 0

  installed_version="$(dpkg-query -W -f='${Version}' libopencv-dev 2>/dev/null || true)"
  if [[ "${installed_version}" != "${repo_candidate}" ]]; then
    echo "Installing libopencv-dev apt repository candidate ${repo_candidate} over ${installed_version:-not-installed}."
    apt_get_install --allow-downgrades "libopencv-dev=${repo_candidate}"
  fi
}

repair_opencv_dev_library_links() {
  local release_modules="/usr/lib/cmake/opencv4/OpenCVModules-release.cmake"
  local multiarch lib_path lib_name lib_stem actual

  [[ -f "${release_modules}" ]] || return 0
  multiarch="$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || true)"
  [[ -n "${multiarch}" && -d "/usr/lib/${multiarch}" ]] || return 0

  while IFS= read -r lib_path; do
    [[ -n "${lib_path}" && ! -e "${lib_path}" ]] || continue

    lib_name="$(basename "${lib_path}")"
    lib_stem="${lib_name%%.so.*}"
    actual="$(find "/usr/lib/${multiarch}" -maxdepth 1 -type f -name "${lib_stem}.so.*" | sort -V | tail -n 1)"
    if [[ -z "${actual}" ]]; then
      continue
    fi

    ln -sf "${actual}" "${lib_path}"
    echo "Linked OpenCV CMake import ${lib_path} -> ${actual}"
  done < <(
    awk -F'"' '/IMPORTED_LOCATION_RELEASE/ {print $2}' "${release_modules}" \
      | sed 's#^\${_IMPORT_PREFIX}#/usr#' \
      | grep -E '^/usr/lib/libopencv_[^/]+\.so\.[0-9.]+$' \
      | sort -u
  )
}

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
      exit 2
      ;;
  esac
}

case "${VISION_TARGET}" in
  none|pc-nvidia|jetson|auto)
    ;;
  *)
    echo "Unsupported VISION_TARGET=${VISION_TARGET}. Use one of: none, pc-nvidia, jetson, auto." >&2
    exit 2
    ;;
esac

if [[ "${VISION_TARGET}" == "auto" ]]; then
  VISION_TARGET="$(vision_target_from_arch "${TARGETARCH:-$(uname -m)}")"
  echo "Auto-detected VISION_TARGET=${VISION_TARGET}."
fi

if [[ "${VISION_TARGET}" != "none" ]]; then
  ENABLE_VISION_STACK="1"
fi

if [[ "${ENABLE_VISION_STACK}" != "1" ]]; then
  echo "Vision stack disabled."
  exit 0
fi

base_packages=(
  build-essential
  cmake
  git
  libopencv-dev
  pkg-config
  python3-colcon-common-extensions
  python3-numpy
  python3-opencv
  python3-pip
  python3-rosdep
  python3-serial
  ros-${ROS_DISTRO}-ament-cmake
  ros-${ROS_DISTRO}-ament-cmake-python
  ros-${ROS_DISTRO}-geometry-msgs
  ros-${ROS_DISTRO}-launch
  ros-${ROS_DISTRO}-launch-ros
  ros-${ROS_DISTRO}-nav-msgs
  ros-${ROS_DISTRO}-rcl-interfaces
  ros-${ROS_DISTRO}-rclcpp
  ros-${ROS_DISTRO}-rclpy
  ros-${ROS_DISTRO}-rosidl-default-generators
  ros-${ROS_DISTRO}-rosidl-default-runtime
  ros-${ROS_DISTRO}-sensor-msgs
  ros-${ROS_DISTRO}-std-msgs
)

jetson_nvidia_packages=(
  libopencv
  libnvinfer-headers-dev
  libnvinfer-headers-plugin-dev
  libnvinfer10
  libnvinfer-plugin10
  libnvonnxparsers10
  "cuda-crt-${NVIDIA_JETSON_CUDA_VERSION}"
  "cuda-cudart-dev-${NVIDIA_JETSON_CUDA_VERSION}"
)

pc_nvidia_packages=(
  libnvinfer-dev
  libnvinfer-plugin-dev
  libnvonnxparsers-dev
  "cuda-crt-${NVIDIA_CUDA_VERSION}"
  "cuda-cudart-dev-${NVIDIA_CUDA_VERSION}"
)

normalize_arch() {
  local arch="$1"
  arch="$(printf '%s' "${arch}" | tr '[:upper:]' '[:lower:]')"

  case "${arch}" in
    amd64|x86_64)
      printf 'x86_64\n'
      ;;
    arm64|aarch64)
      printf 'arm64\n'
      ;;
    *)
      printf '%s\n' "${arch}"
      ;;
  esac
}

install_pc_nvidia_apt_source() {
  local arch
  arch="$(normalize_arch "${TARGETARCH:-$(dpkg --print-architecture)}")"
  if [[ "${arch}" != "x86_64" ]]; then
    echo "VISION_TARGET=pc-nvidia requires linux/amd64, got ${TARGETARCH:-$(dpkg --print-architecture)}." >&2
    echo "Set DOCKER_DEFAULT_PLATFORM=linux/amd64 for local builds or pass --platform linux/amd64 for deploy-image." >&2
    exit 1
  fi

  local keyring_url="${NVIDIA_CUDA_KEYRING_URL}"
  if [[ -z "${keyring_url}" ]]; then
    keyring_url="https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/${arch}/cuda-keyring_1.1-1_all.deb"
  fi

  echo "Installing NVIDIA CUDA apt source: ${keyring_url}"
  curl -fsSL "${keyring_url}" -o /tmp/nvidia-cuda-keyring.deb
  dpkg -i /tmp/nvidia-cuda-keyring.deb >/dev/null
  rm -f /tmp/nvidia-cuda-keyring.deb
  apt_get_update
}

configure_jetson_apt_source() {
  if [[ -z "${JETSON_L4T_RELEASE}" ]]; then
    echo "JETSON_L4T_RELEASE must not be empty when VISION_TARGET=jetson." >&2
    exit 2
  fi

  local repos=()
  read -r -a repos <<< "${JETSON_L4T_REPOSITORIES}"
  if [[ "${#repos[@]}" -eq 0 ]]; then
    echo "JETSON_L4T_REPOSITORIES must contain at least one repository name." >&2
    exit 2
  fi

  local repo
  for repo in "${repos[@]}"; do
    if [[ ! "${repo}" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "Invalid Jetson repository name: ${repo}" >&2
      exit 2
    fi
  done

  local keyring="/usr/share/keyrings/jetson-ota-public.asc"
  local source_file="/etc/apt/sources.list.d/nvidia-l4t-apt-source.list"

  echo "Configuring NVIDIA Jetson apt source for ${JETSON_L4T_RELEASE}: ${JETSON_L4T_REPOSITORIES}"
  install -d /usr/share/keyrings /etc/apt/sources.list.d
  curl -fsSL "${JETSON_L4T_KEY_URL}" -o "${keyring}"
  chmod 0644 "${keyring}"

  {
    echo "# Generated by Pacific Rim vision installer."
    for repo in "${repos[@]}"; do
      printf 'deb [signed-by=%s] https://repo.download.nvidia.com/jetson/%s %s main\n' \
        "${keyring}" \
        "${repo}" \
        "${JETSON_L4T_RELEASE}"
    done
  } > "${source_file}"
}

create_library_link() {
  local link_library_name="$1"
  shift || true

  local runtime_library_names=("${link_library_name}" "$@")
  local library_dirs=(
    /usr/lib/aarch64-linux-gnu
    /usr/lib/sbsa-linux-gnu
    /usr/lib/x86_64-linux-gnu
    /usr/lib
  )

  local dir runtime_library_name target
  for dir in "${library_dirs[@]}"; do
    [[ -d "${dir}" ]] || continue

    if [[ -e "${dir}/${link_library_name}.so" ]]; then
      return 0
    fi

    for runtime_library_name in "${runtime_library_names[@]}"; do
      local matches=()
      shopt -s nullglob
      matches=("${dir}/${runtime_library_name}.so."*)
      shopt -u nullglob

      if [[ "${#matches[@]}" -gt 0 ]]; then
        target="$(printf '%s\n' "${matches[@]}" | sort -V | tail -n 1)"
        ln -sf "$(basename "${target}")" "${dir}/${link_library_name}.so"
        echo "Linked ${dir}/${link_library_name}.so -> $(basename "${target}")"
        return 0
      fi
    done
  done

  echo "Missing runtime library ${link_library_name}.so.* after NVIDIA package install." >&2
  return 1
}

create_jetson_tensorrt_dev_links() {
  # CMake find_library needs libnvinfer.so, libnvinfer_plugin.so, and libnvonnxparser.so.
  create_library_link libnvinfer
  create_library_link libnvinfer_plugin
  create_library_link libnvonnxparser libnvonnxparsers
}

if [[ "${VISION_TARGET}" == "jetson" ]]; then
  configure_jetson_apt_source
fi

configure_ubuntu_ports_mirror
apt_get_update

apt_get_install "${base_packages[@]}"
install_opencv_dev_apt_candidate
repair_opencv_dev_library_links
remove_stale_opencv_cmake_config

if [[ "${VISION_TARGET}" == "pc-nvidia" || "${VISION_TARGET}" == "jetson" ]]; then
  nvidia_packages=()
  if [[ "${VISION_TARGET}" == "pc-nvidia" ]]; then
    echo "Installing PC NVIDIA vision packages. The base image or apt sources must provide CUDA/TensorRT packages."
    install_pc_nvidia_apt_source
    nvidia_packages=("${pc_nvidia_packages[@]}")
  else
    echo "Installing Jetson vision packages. Use a JetPack/L4T-compatible base image or apt sources; TensorRT Python should come from JetPack, not pip."
    nvidia_packages=("${jetson_nvidia_packages[@]}")
  fi

  missing_packages=()
  for package_name in "${nvidia_packages[@]}"; do
    if ! apt-cache show "${package_name}" >/dev/null 2>&1; then
      missing_packages+=("${package_name}")
    fi
  done

  if [[ "${#missing_packages[@]}" -gt 0 ]]; then
    printf 'Missing NVIDIA vision apt packages for VISION_TARGET=%s:\n' "${VISION_TARGET}" >&2
    printf '  %s\n' "${missing_packages[@]}" >&2
    echo "Use a compatible NVIDIA/JetPack base image or configure the matching NVIDIA apt repository before enabling this target." >&2
    exit 1
  fi

  apt_get_install "${nvidia_packages[@]}"
  if [[ "${VISION_TARGET}" == "jetson" ]]; then
    create_jetson_tensorrt_dev_links
  fi
fi

rm -rf /var/lib/apt/lists/*

if [[ -n "${ONNX_VERSION}" && "${ONNX_VERSION}" != "none" ]]; then
  pip_args=(--no-cache-dir)
  if python3 -m pip install --help | grep -q -- "--break-system-packages"; then
    pip_args+=(--break-system-packages)
  fi
  python3 -m pip install "${pip_args[@]}" "onnx==${ONNX_VERSION}"
fi
