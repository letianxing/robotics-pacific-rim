#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

node "${ROOT_DIR}/bin/generate-interface-scaffold.mjs" "module/service/imu_service" "$@"
