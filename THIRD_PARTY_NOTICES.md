# Third-Party Notices

This repository includes source and binary dependencies under their upstream
licenses. Package-manager dependencies are governed by their package metadata
and lockfiles.

## Bundled Binaries

- `third_party/onnxruntime/onnxruntime-linux-aarch64-1.16.2`: ONNX Runtime
  1.16.2 for Linux aarch64, licensed under MIT. The upstream `LICENSE`,
  `ThirdPartyNotices.txt`, and `Privacy.md` files are preserved in that
  directory. Provenance, checksums, and refresh instructions are documented in
  `third_party/onnxruntime/README.md`.

## Package Dependencies

- Root JavaScript dependencies are listed in `package.json` and
  `package-lock.json`.
- Dashboard JavaScript dependencies are listed in `dashboard/package.json` and
  `dashboard/package-lock.json`.
- Go and Python dependencies are declared inside their module-specific manifests.
