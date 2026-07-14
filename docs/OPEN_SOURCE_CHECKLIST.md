# Open Source Release Checklist

Last checked: 2026-07-14.

## Completed

- MIT license is present at `LICENSE`.
- Public contribution, security, code of conduct, and third-party notice files
  are present.
- GitHub Actions CI is configured in `.github/workflows/ci.yml`.
- Latest observed `main` CI run for commit `ef7327a` completed successfully:
  `https://github.com/letianxing/robotics-pacific-rim/actions/runs/29316858537`.
- Root npm audit passes with no vulnerabilities.
- Dashboard high/critical npm audit gate passes.
- Local stability suite passes: `303/303`.
- `.env.example` templates exist for Dashboard web, native, and database
  workspaces.
- Public examples use documentation IP address `192.0.2.20` instead of a private
  LAN address.
- Repository metadata uses an HTTPS public GitHub URL.
- Bundled ONNX Runtime provenance is documented in
  `third_party/onnxruntime/README.md`.

## Maintainer Confirmation Required

These items require project owner review before a public announcement:

- Confirm every copied source file can be released under this repository's MIT
  license.
- Confirm no customer, vendor, or employer confidential material remains in docs,
  configs, tests, comments, or generated assets.
- Confirm project name, logos, and robot/profile names do not violate third-party
  trademarks.
- Confirm bundled ONNX Runtime redistribution is acceptable for the project's
  target distribution model, or move it to release assets / Git LFS / setup-time
  download.
- Confirm export-control and hardware-safety statements are appropriate for the
  intended audience and jurisdictions.

## Accepted Follow-Up Risks

- Dashboard still reports moderate upstream toolchain advisories for
  `next -> postcss`, `expo -> xcode -> uuid`, and
  `drizzle-kit -> @esbuild-kit/esm-loader -> esbuild`. They are tracked in
  `SECURITY.md`; current automatic fixes require breaking changes.
- The repository currently vendors a 16 MB ONNX Runtime Linux aarch64 package.
  This is acceptable for initial publication, but a source-only distribution
  should switch to `scripts/fetch-onnxruntime.sh` or external release assets.
- The Dashboard API TypeScript test file has no dedicated package script/loader
  yet. Root stability tests and Dashboard checks pass, but a future cleanup
  should add a first-class Dashboard test command.
