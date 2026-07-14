#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PR_MATRIX_IMAGE:-pacific-rim-matrix:humble}"
NATS_IMAGE="${PR_NATS_IMAGE:-nats:2-alpine}"
CONTAINER="${PR_NATS_CONTAINER:-pr-test-nats}"
GO_VERSION="${PR_TEST_GO_VERSION:-1.25.5}"

cleanup() {
  docker stop "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
docker run -d --rm --name "${CONTAINER}" "${NATS_IMAGE}" >/dev/null

docker run --rm \
  --network "container:${CONTAINER}" \
  -v "${ROOT}:/workspace" \
  -w /workspace/infra \
  "${IMAGE}" \
  bash -lc "set -euo pipefail; \
    if [ ! -x /tmp/go${GO_VERSION}/go/bin/go ]; then \
      curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz -o /tmp/go${GO_VERSION}.tar.gz; \
      mkdir -p /tmp/go${GO_VERSION}; \
      tar -C /tmp/go${GO_VERSION} -xzf /tmp/go${GO_VERSION}.tar.gz; \
    fi; \
    export PATH=/tmp/go${GO_VERSION}/go/bin:\$PATH; \
    GOCACHE=/tmp/pr-go-build-cache go run ./communication/go/nats/smoke"
