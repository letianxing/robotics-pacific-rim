# Open Source Release Checklist

Last checked: 2026-07-14.

## Status Legend

| Status | Meaning |
| --- | --- |
| `done` | Verified by repository changes, local checks, or remote CI. |
| `pending-owner-confirmation` | Requires maintainer/legal/product owner review before announcement. |
| `accepted-risk` | Known non-blocking risk accepted for the initial open-source release. |
| `deferred` | Intentionally postponed and not required for initial release. |
| `blocked` | Must be resolved before release. |
| `not-applicable` | Not relevant to this repository or release. |

## Release Readiness

| Status | Item | Evidence / Decision |
| --- | --- | --- |
| `done` | MIT license is present. | `LICENSE` |
| `done` | Public contribution, security, code of conduct, and third-party notice files are present. | `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `THIRD_PARTY_NOTICES.md` |
| `done` | GitHub Actions CI is configured. | `.github/workflows/ci.yml` |
| `done` | Latest observed `main` CI run completed successfully. | Commit `4e0df98`, run `https://github.com/letianxing/robotics-pacific-rim/actions/runs/29319107050` |
| `done` | Root npm audit passes with no vulnerabilities. | `npm audit --audit-level=high` |
| `done` | Dashboard high/critical npm audit gate passes. | `npm audit --omit=dev --audit-level=high --prefix dashboard` |
| `done` | Local stability suite passes. | `node test/run.mjs`, `303/303` |
| `done` | Dashboard lint/format check passes. | `cd dashboard && npm run check` |
| `done` | Dashboard type check passes. | `cd dashboard && npm run check-types` |
| `done` | `.env.example` templates exist for Dashboard web, native, and database workspaces. | `dashboard/apps/web/.env.example`, `dashboard/apps/native/.env.example`, `dashboard/packages/db/.env.example` |
| `done` | Public examples use documentation IP addresses instead of private LAN addresses. | `192.0.2.20` |
| `done` | Repository metadata uses an HTTPS public GitHub URL. | `package.json` |
| `done` | Bundled ONNX Runtime provenance is documented. | `third_party/onnxruntime/README.md` |
| `done` | ONNX Runtime refresh path is reproducible. | `scripts/fetch-onnxruntime.sh` |

## Owner Confirmation

These items require project owner review before a public announcement.

| Status | Item | Notes |
| --- | --- | --- |
| `pending-owner-confirmation` | Confirm every copied source file can be released under this repository's MIT license. | Applies to code copied from the source `pacific-rim` workspace and any generated artifacts. |
| `pending-owner-confirmation` | Confirm no customer, vendor, or employer confidential material remains. | Review docs, configs, tests, comments, generated assets, and robot profiles. |
| `pending-owner-confirmation` | Confirm project name, logos, and robot/profile names do not violate third-party trademarks. | Rename before public announcement if needed. |
| `pending-owner-confirmation` | Confirm bundled ONNX Runtime redistribution is acceptable for the target distribution model. | Current recommendation: `keep-vendored` for initial release. |
| `pending-owner-confirmation` | Confirm export-control and hardware-safety statements are appropriate. | Especially relevant for real robot deployment and sim2real workflows. |

## Accepted Follow-Up Risks

| Status | Risk | Current Decision |
| --- | --- | --- |
| `accepted-risk` | Dashboard still reports moderate upstream toolchain advisories for `next -> postcss`, `expo -> xcode -> uuid`, and `drizzle-kit -> @esbuild-kit/esm-loader -> esbuild`. | Track in `SECURITY.md`; current automatic fixes require breaking changes. |
| `accepted-risk` | The repository currently vendors a 16 MB ONNX Runtime Linux aarch64 package. | Keep vendored for initial release; switch to release assets, Git LFS, or setup-time download if clone size or redistribution policy changes. |
| `accepted-risk` | The Dashboard API TypeScript test file has no dedicated package script/loader yet. | Root stability tests and Dashboard checks pass; add a first-class Dashboard test command later. |
