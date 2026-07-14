# ONNX Runtime Vendor Package

This directory contains the optional ONNX Runtime package used by the sim2real
runtime when policy inference is enabled.

## Current Package

- Package: `onnxruntime-linux-aarch64-1.16.2`
- Upstream project: `microsoft/onnxruntime`
- Source release asset:
  `https://github.com/microsoft/onnxruntime/releases/download/v1.16.2/onnxruntime-linux-aarch64-1.16.2.tgz`
- Upstream commit recorded by the package:
  `0c5b95fc86750526d09ee9e669a98506116c6bde`
- License: MIT. The upstream `LICENSE`, `ThirdPartyNotices.txt`, and
  `Privacy.md` files are preserved in the package directory.

Local file checksums:

```text
967895ce2dc1a4138b70d67e27c15bdf86335d1b64a6677f524f1a841703aaac  onnxruntime-linux-aarch64-1.16.2/lib/libonnxruntime.so.1.16.2
d7d726424fc23a8395c139bbc7eb2aefa2b5bb2eb3332ec34ad0442d149d2308  onnxruntime-linux-aarch64-1.16.2/ThirdPartyNotices.txt
```

## Refreshing

Use the fetch script to reproduce or update the package:

```bash
./scripts/fetch-onnxruntime.sh
```

Override the version or target architecture when needed:

```bash
ONNXRUNTIME_VERSION=1.16.2 ONNXRUNTIME_ARCH=aarch64 ./scripts/fetch-onnxruntime.sh
```

For stricter source-only distribution, remove the vendored package from the
repository and run this script during setup or release packaging instead. If the
binary has already been pushed to a public branch, coordinate any history rewrite
before force-pushing.
