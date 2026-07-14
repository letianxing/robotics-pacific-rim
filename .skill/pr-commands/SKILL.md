---
name: pr-commands
description: Pacific-Rim repository command workflow guide for choosing and running the correct `./pr` commands. Use when working in this repo and the task involves health checks, affected checks, builds, project graph, module/pkg/infra creation or removal, interface generation, Dashboard, pr-monitor, ROS2 Docker build/run/deploy, observability, Go tests, or passthrough npm/nx/docker commands.
---

# Pacific-Rim `./pr` Commands

## Overview

Use `./pr` as the primary command entrypoint for this repository. Prefer it over
direct `npm`, `nx`, `docker`, or ad hoc script calls unless the requested task
requires a lower-level command or `./pr` does not expose the operation.

Run commands from the repository root.

## Default Workflow

Use this sequence unless the user asks for a narrower command:

```bash
./pr doctor
./pr check
./pr affected
```

For communication or IDL-adjacent work, add:

```bash
./pr check:comm
./pr gen:interfaces --service <service> --dry-run
```

Before finalizing broad or shared changes, prefer:

```bash
./pr check:all
```

Run `./pr build` or `./pr test:go` when the touched code path makes those relevant.

## Command Selection

Use these high-signal choices first:

- Environment problem: `./pr doctor`, `./pr check env`, `./pr check diag`.
- Routine code change: `./pr check`, then `./pr affected`.
- Submit-ready validation: `./pr check:all`; add `./pr build` for buildable changes.
- Communication config or route change: `./pr check:comm`, then interface dry-run.
- IDL data format creation: `./pr data-format --service <service> --kind <proto|msg|srv|dds_idl> --name <Type> (--file <path>|--data <text>|--stdin)`.
- Interface scaffold generation: always run `./pr gen:interfaces --service <service> --dry-run` before the write command.
- Project lookup: `./pr projects`; dependency questions: `./pr graph`.
- Dashboard: `./pr dashboard` or `./pr dashboard --daemon`.
- Runtime route inspection: `./pr monitor -i <keyword>`, `./pr monitor list`, or `./pr monitor --list-routes`.
- ROS2 local work: `./pr ros2:build-image`, `./pr ros2:build --packages-select <pkg>`, `./pr ros2:run <pkg>`.
- Observability: `./pr observability:up`, `./pr observability:logs`, `./pr observability:down`.
- Go infra changes: `./pr test:go`.
- Explicit passthrough: `./pr npm`, `./pr nx`, `./pr docker`, or `./pr run <script>`.

## Safety Rules

- Do not manually edit `pkg/idl/**`. If an IDL change is needed, tell the user it must be done through the Dashboard page or `./pr data-format`.
- Treat `./pr gen:interfaces --force` as destructive to editable scaffolds. Use it only when the user explicitly wants to reset generated skeletons.
- Prefer `--dry-run` before commands that generate or deploy.
- For `module/service/*`, preserve protocol boundaries: modules communicate through declared protocols, not direct source calls.
- `pr-monitor` process collection reads only the local process table. Prometheus and ROS2 graph may still reflect remote runtime data.

## Detailed Reference

Read [references/pr-command-reference.md](references/pr-command-reference.md)
when the task needs exact flags, examples, ROS2 deploy options, observability
endpoints, monitor modes, or passthrough command details.

## Common Examples

```bash
# Minimal health check
./pr check

# Check only affected projects
./pr affected

# Validate communication declarations
./pr check:comm

# Create a ROS2 msg data format
./pr data-format --service robo_brain_service --kind msg --name RobotState --data "string robot_id"

# Preview interface generation
./pr gen:interfaces --service robo_brain_service --dry-run

# Start Dashboard
./pr dashboard --daemon

# Inspect routes
./pr monitor -i upperbody

# Build and run a ROS2 package
./pr ros2:build --packages-select smoke_test1
./pr ros2:run smoke_test1
```
