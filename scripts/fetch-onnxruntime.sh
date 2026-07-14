#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage:
  scripts/fetch-onnxruntime.sh

Environment:
  ONNXRUNTIME_VERSION   Version to download. Default: 1.16.2
  ONNXRUNTIME_PLATFORM  Release platform. Default: linux
  ONNXRUNTIME_ARCH      Release architecture. Default: aarch64
  ONNXRUNTIME_DEST      Destination directory. Default: third_party/onnxruntime
  ONNXRUNTIME_URL       Full archive URL override.
  ONNXRUNTIME_SHA256    Optional archive sha256 to verify.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

ONNXRUNTIME_VERSION="${ONNXRUNTIME_VERSION:-1.16.2}"
ONNXRUNTIME_PLATFORM="${ONNXRUNTIME_PLATFORM:-linux}"
ONNXRUNTIME_ARCH="${ONNXRUNTIME_ARCH:-aarch64}"
ONNXRUNTIME_DEST="${ONNXRUNTIME_DEST:-${REPO_ROOT}/third_party/onnxruntime}"
ONNXRUNTIME_ASSET="onnxruntime-${ONNXRUNTIME_PLATFORM}-${ONNXRUNTIME_ARCH}-${ONNXRUNTIME_VERSION}"
ONNXRUNTIME_URL="${ONNXRUNTIME_URL:-https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/${ONNXRUNTIME_ASSET}.tgz}"
ONNXRUNTIME_SHA256="${ONNXRUNTIME_SHA256:-}"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

archive="${tmp_dir}/${ONNXRUNTIME_ASSET}.tgz"
mkdir -p "${ONNXRUNTIME_DEST}"

echo "Downloading ${ONNXRUNTIME_URL}"
curl -fL "${ONNXRUNTIME_URL}" -o "${archive}"

if [[ -n "${ONNXRUNTIME_SHA256}" ]]; then
  actual_sha="$(sha256_file "${archive}")"
  if [[ "${actual_sha}" != "${ONNXRUNTIME_SHA256}" ]]; then
    echo "error: sha256 mismatch for ${archive}" >&2
    echo "       expected: ${ONNXRUNTIME_SHA256}" >&2
    echo "       actual:   ${actual_sha}" >&2
    exit 1
  fi
fi

rm -rf "${ONNXRUNTIME_DEST:?}/${ONNXRUNTIME_ASSET}"
tar -xzf "${archive}" -C "${ONNXRUNTIME_DEST}"
rm -f "${ONNXRUNTIME_DEST}/current"
ln -s "${ONNXRUNTIME_ASSET}" "${ONNXRUNTIME_DEST}/current"

echo "Installed ${ONNXRUNTIME_DEST}/${ONNXRUNTIME_ASSET}"
echo "Updated ${ONNXRUNTIME_DEST}/current"
