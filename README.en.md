# Robotics Pacific Rim

[![CI](https://github.com/letianxing/robotics-pacific-rim/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/letianxing/robotics-pacific-rim/actions/workflows/ci.yml)

Robotics Pacific Rim is an open-source robotics full-stack monorepo framework.
It combines a repository-level CLI, service scaffolding, protocol-driven
interfaces, ROS2 deployment workflows, and a TypeScript Dashboard.

## What Is Inside

- `bin/`: the `pr` CLI implementation.
- `dashboard/`: Next.js, Expo, tRPC, Drizzle, and PostgreSQL dashboard
  workspace.
- `infra/`: communication, protocol, runtime, telemetry, trace, metrics, and log
  libraries.
- `module/service/`: robot service modules.
- `pkg/idl/`: generated and managed protocol/interface assets.
- `deploy/`: local Docker, remote ROS2, robot profile, and sim2real workflows.
- `test/`: repository-level stability and contract tests.

## Quick Start

Use Node.js 20 or newer. Docker, Go, and ROS2 are needed for the corresponding
runtime and deployment workflows.

```bash
./setup.sh
./pr doctor
./pr check
```

Most day-to-day operations go through `./pr`:

```bash
./pr --help
./pr create module demo-action
./pr data-format --service demo_action_service --kind msg --name RobotState --data "string robot_id"
./pr dashboard
./pr robot:profiles
./pr robot:deploy pure-driver-sample --dry-run --host 192.0.2.20 --domain-id 42
```

## Dashboard

```bash
cd dashboard
npm install
cp apps/web/.env.example apps/web/.env
cp apps/native/.env.example apps/native/.env
cp packages/db/.env.example packages/db/.env
../pr dashboard:db:start
../pr dashboard:db:push
../pr dashboard
```

Open `http://localhost:13630`.

## Checks

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high --prefix dashboard
node bin/pr.mjs check
node test/run.mjs
cd dashboard && npm run check && npm run check-types
```

## Open Source Docs

- [Contributing](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Third-Party Notices](./THIRD_PARTY_NOTICES.md)
- [Open Source Release Checklist](./docs/OPEN_SOURCE_CHECKLIST.md)
