#!/usr/bin/env bash
# Build all sim2real + motion-control padding ROS2 packages for THIS repo's pr layout.
#
# Layout note (differs from the source pacific-rim repo):
#   - shared IDL  -> pkg/idl/motion_control_sim2real_service/ros2/{lhframework_interfaces,yesense_interface}
#   - drivers     -> pkg/driver/motor/khcan_native, pkg/driver/sensor/{serial,yesense/yesense_std_ros2}
#   - sim2real    -> module/service/motion_control_sim2real_service/src/plugins/ros2_plugin/{lhframework_hw,lhframework_ros}
#   - motion-control padding -> module/service/motion_control_padding_service
#
# We pass the REAL package dirs via --base-paths (not symlinks), so each
# package's in-tree relative paths (khcan_native, runtime/core, runtime/resources,
# infra/*) resolve correctly with no -D overrides needed. Output is a single
# merge-install tree the deploy run-scripts source as one setup.bash.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# ONNX Runtime is OPTIONAL at build time (the build still succeeds without it,
# with policy inference disabled). To enable inference, point this at an
# onnxruntime install dir, for example:
#   ONNXRUNTIME_ROOT=/path/to/onnxruntime/current
export ONNXRUNTIME_ROOT="${ONNXRUNTIME_ROOT:-${REPO_ROOT}/third_party/onnxruntime/current}"

WS="${WS:-${REPO_ROOT}/.ros_local_ws}"
BUILD_BASE="${BUILD_BASE:-${WS}/build}"
INSTALL_BASE="${INSTALL_BASE:-${WS}/install}"
LOG_BASE="${LOG_BASE:-${WS}/log}"
ROS_SETUP="${ROS_SETUP:-/opt/ros/humble/setup.bash}"

# Use system python (rosidl/em/lark live there), not a conda interpreter.
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/ros/humble/bin"
unset PYTHONPATH CONDA_PREFIX CONDA_DEFAULT_ENV || true

source_setup() { set +u; source "$1"; set -u; }
require_dir() {
  if [[ ! -d "$1" ]]; then
    echo "error: required directory not found: $1" >&2
    case "$1" in
      pkg/idl/*)
        echo "       Sync IDL through the frontend before building; pkg/idl is not edited by hand." >&2
        ;;
    esac
    exit 1
  fi
}

usage() {
  cat <<EOF
Usage:
  bash deploy/sim2real/scripts/build-runtime.sh [extra colcon args...]

Outputs (merge-install):
  BUILD_BASE=${BUILD_BASE}
  INSTALL_BASE=${INSTALL_BASE}
  LOG_BASE=${LOG_BASE}

Environment:
  ROS_SETUP=${ROS_SETUP}
  ONNXRUNTIME_ROOT=${ONNXRUNTIME_ROOT}  (optional; absent => inference disabled)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi

if [[ ! -f "${ROS_SETUP}" ]]; then
  echo "error: ROS setup file not found: ${ROS_SETUP}" >&2
  exit 1
fi

mkdir -p "${WS}"
source_setup "${ROS_SETUP}"

cd "${REPO_ROOT}"
for required in \
  pkg/idl/motion_control_sim2real_service/ros2/lhframework_interfaces \
  pkg/idl/motion_control_sim2real_service/ros2/yesense_interface \
  pkg/driver/motor/khcan_native/upstream \
  pkg/driver/sensor/serial \
  pkg/driver/sensor/yesense/yesense_std_ros2 \
  module/service/motion_control_sim2real_service/src/plugins/ros2_plugin/lhframework_hw \
  module/service/motion_control_sim2real_service/src/plugins/ros2_plugin/lhframework_ros \
  module/service/motion_control_padding_service
do
  require_dir "${required}"
done

colcon --log-base "${LOG_BASE}" build --merge-install \
  --build-base "${BUILD_BASE}" \
  --install-base "${INSTALL_BASE}" \
  --base-paths \
    pkg/idl/motion_control_sim2real_service/ros2/lhframework_interfaces \
    pkg/idl/motion_control_sim2real_service/ros2/yesense_interface \
    pkg/driver/motor/khcan_native/upstream \
    pkg/driver/sensor/serial \
    pkg/driver/sensor/yesense/yesense_std_ros2 \
    module/service/motion_control_sim2real_service/src/plugins/ros2_plugin/lhframework_hw \
    module/service/motion_control_sim2real_service/src/plugins/ros2_plugin/lhframework_ros \
    module/service/motion_control_padding_service \
  --packages-select \
    lhframework_interfaces yesense_interface serial yesense_std_ros2 \
    khcan lhframework_hw lhframework_ros motion_control_padding \
  "$@"
