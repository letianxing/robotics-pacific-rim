# Pacific-Rim `./pr` Command Reference

Use commands from the repository root.

## Quick Workflow

```bash
./pr doctor
./pr check
./pr check env
./pr check diag
./pr check:comm
./pr affected
./pr check:all
./pr projects
./pr graph
./pr dashboard
./pr gen:interfaces --service robo_brain_service --dry-run
./pr monitor -i upperbody
./pr ros2:build --packages-select smoke_test1
./pr ros2:run smoke_test1
./pr test:go
```

Recommended order:

1. New machine or broken environment: `./pr doctor`, `./pr check env`, `./pr check diag`.
2. Normal code work: `./pr check`, `./pr affected`.
3. Communication config work: `./pr check:comm`, then `./pr gen:interfaces --service <service> --dry-run`.
4. Before submitting: `./pr check:all`; add `./pr build` and `./pr test:go` when relevant.

## Environment and Checks

```bash
./pr doctor
./pr check
./pr check env
./pr check diag
./pr check:comm
./pr affected
./pr check:all
./pr build
```

- `doctor`: checks Node.js, npm, Go, Docker, Docker Compose, and other host dependencies.
- `check`: minimal repository health check; does not depend on Nx.
- `check env`: prints Pacific-Rim/VLink environment variables and purposes.
- `check diag`: diagnoses local IP, multicast, disk, CPU, memory, common tools, and related local processes.
- `check:comm`: checks communication declarations, public interfaces, route references, and config consistency.
- `affected`: checks only projects affected by current changes.
- `check:all`: runs every project's `check` target.
- `build`: builds all buildable projects.

## Projects and Graph

```bash
./pr projects
./pr graph
```

Use `projects` to confirm workspace registration. Use `graph` to inspect explicit project dependencies and affected fan-out.

## Create and Remove

```bash
./pr create module navigation
./pr create module lidar-driver --ros2 python --ros2-version jazzy
./pr create module drive-control --ros2 cpp --ros2-version humble
./pr create module brain-sidecar --ros2 go --ros2-version humble
./pr create pkg robot-contracts
./pr create infra telemetry
./pr remove module navigation
```

Names should use lowercase kebab-case. Module scaffolding creates `module/service/<name>_service` and `.skill/<name>_service/SKILL.md`.

## Interface Generation

```bash
./pr gen:interfaces --service robo_brain_service --dry-run
./pr gen:interfaces --service robo_brain_service
./pr gen:interfaces --service module/service/robo_brain_service --dry-run
./pr gen:interfaces --service robo-brain --dry-run
```

Service names can be `robo_brain_service`, `robo-brain`, or `module/service/robo_brain_service`.

Common options:

- `--service <name>`: target service.
- `--dry-run`: print manifest without writing; use first.
- `--config <file>`: explicit `config.yaml` for debugging or migration.
- `--protocols <dir>`: explicit protocol scan directory; default is `pkg/idl`.
- `--force`: allow resetting editable implementation skeletons; use only when intentionally overwriting.

Rules:

- Do not manually edit `pkg/idl`.
- IDL changes must be made through the Dashboard page.
- Normal generation does not overwrite existing business implementation skeletons.
- Missing public `interfaces.yaml` usually means a provider route has not been published in public IDL.

## Dashboard

```bash
./pr dashboard
./pr dashboard --daemon
./pr dashboard --no-open
./pr dashboard -- --turbo
```

- Default web URL: `http://localhost:13630`.
- `--daemon`: run in background and write logs to `dashboard/tmp/dashboard.log`.
- `--no-open`: start without opening a browser.
- `-- <args>`: pass arguments to Next.js.

## Monitor

```bash
./pr monitor -i upperbody
./pr monitor --loc -x
./pr monitor list
./pr monitor list -i upperbody
./pr monitor --list-routes
./pr monitor --list-processes
./pr monitor --topology
./pr monitor --prometheus-url http://localhost:18180
```

`pr-monitor` discovers ROS2/NATS/CycloneDDS routes from repository manifests and samples runtime data when available.

Sources:

- `pkg/idl/**/public/interfaces.yaml`
- `module/service/**/config.yaml`
- bridge YAML such as `module/service/robo_brain_service/bridge/nats/*.yaml`
- local process table `ps`
- Prometheus
- ROS2 CLI topic/service list and topic hz/bw

Notes:

- Missing runtime sources show `---`; do not interpret that as zero traffic.
- Process collection reads only the local process table. It does not scan LAN processes.
- Prometheus and ROS2 graph may reflect remote or same-DDS-domain runtime data.

Hotkeys: arrows move, `Enter` opens detail, `i` filters, `Space` pauses, `q` exits.

## ROS2 Docker

```bash
./pr ros2:build-image
./pr ros2:shell
./pr ros2:build --packages-select <ros_package_name>
./pr ros2:run <ros_package_name>
./pr ros2:run <ros_package_name> <executable>
./pr ros2:deploy --host <linux_host> --packages-select <ros_package_name>
```

Advanced lower-level script:

```bash
scripts/ros2-docker.sh test [colcon args...]
scripts/ros2-docker.sh run <command...>
scripts/ros2-docker.sh deploy-image --host <ip-or-host> --packages-select <pkg> [options]
scripts/ros2-docker.sh deploy --host <ip-or-host> --remote-dir <dir> [--user <user>] [--port <port>] [--packages-select <pkg>]
```

Notes:

- Prefer Docker ROS2 on macOS or hosts without native ROS2.
- `<ros_package_name>` is the `<name>` in `package.xml`.
- Default `ROS_DISTRO=jazzy`.
- Supported distro tags include `humble`, `jazzy`, `kilted`, `lyrical`, and `rolling`.
- Default `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`.
- `ros2:deploy` rebuilds the runtime image from the current workspace, transfers it with `docker save | ssh docker load`, and restarts the matching remote container.

Examples:

```bash
./pr ros2:build-image
./pr ros2:build --packages-select smoke_test1
./pr ros2:run smoke_test1
./pr ros2:run smoke_test1 smoke_test1_node
ROS_DISTRO=humble ./pr ros2:build-image
scripts/ros2-docker.sh run "ros2 topic list"
```

## Observability

```bash
./pr observability:up
./pr observability:logs
./pr observability:down
```

Local endpoints:

```text
Grafana:    http://localhost:16000
Prometheus: http://localhost:18180
Loki:       http://localhost:6200
Tempo:      http://localhost:6400
OTLP HTTP:  http://localhost:8636
```

Useful pairing:

```bash
./pr observability:up
./pr monitor --prometheus-url http://localhost:18180
./pr observability:logs
./pr observability:down
```

## Go Tests

```bash
./pr test:go
```

Run this after changing Go communication, protocol, OpenTelemetry, trace, metric, or log packages.

## Passthrough

```bash
./pr npm <args...>
./pr nx <args...>
./pr docker <args...>
./pr run <npm-script> [args...]
```

Examples:

```bash
./pr npm install
./pr nx show projects
./pr docker ps
./pr run trace:demo
```
