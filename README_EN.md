# Robotics Pacific Rim

[English](./README_EN.md) | [中文](./README_ZH.md)

[![CI](https://github.com/letianxing/robotics-pacific-rim/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/letianxing/robotics-pacific-rim/actions/workflows/ci.yml)

Pacific-Rim is an **AI Native + Robotics** full-stack monorepo. It keeps robot
business services, protocol contracts, ROS2/communication runtimes, deployment
tooling, and the Dashboard in one workspace, so teams can evolve robot
capabilities around module services instead of synchronizing multiple
repositories by hand.

The core development unit is `module/service/*`. Each service has explicit
boundaries, protocol entry points, and local agent constraints, so you can use
**vibe coding** to describe target behavior, let an AI agent update the service
implementation, fill in interfaces and tests, and then use `./pr` for
generation, checks, local runs, and deployment.

```text
Initialize workspace -> Create module service -> Configure protocol contracts -> Generate interface code -> Implement behavior -> build/run/deploy
```

Use `./pr` for day-to-day operations. See [pr-cmd-all.md](./pr-cmd-all.md) for
the full command reference. Every `./pr` command prints a clear final status:
`[PR SUCCESS]` or `[PR FAILED]`. Long-running foreground commands print
`[PR RUNNING]` after startup.

Open-source collaboration entry points:
[CONTRIBUTING.md](./CONTRIBUTING.md),
[SECURITY.md](./SECURITY.md),
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md),
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Workspace Setup

On a new machine, or right after switching to this repository, run:

```bash
./setup.sh
./pr doctor
./pr check
```

`./setup.sh` checks local development dependencies, installs root and
`dashboard/` dependencies, writes default local Dashboard configuration, and
builds the root `./pr` entrypoint.

Common checks:

| Scenario | Command |
| --- | --- |
| CLI help | `./pr --help` |
| List scripts | `./pr scripts` |
| Environment diagnostics | `./pr doctor` |
| Clean caches | `./pr clean` |
| Minimal repository check | `./pr check` |
| Communication config check | `./pr check:comm` |
| Robot profile check | `./pr robot:check` |
| Affected projects | `./pr affected` |
| Full pre-submit check | `./pr check:all` |

## Robot Profiles And AI Native Composition

Robot capabilities live in `pkg/robot/capabilities.json`, and robot
compositions live in `deploy/robot-profiles/*.json`. These files describe
capabilities, module composition, and deployment intent only. Concrete protocol
contracts must still be created through the Dashboard or `./pr data-format`;
do not hand-edit `pkg/idl`.

```bash
./pr robot:profiles
./pr robot:show pure-driver-sample
./pr robot:check
./pr robot:deploy pure-driver-sample --dry-run --host 192.0.2.20 --domain-id 42
```

The Dashboard Robots page reads the same profile data and shows deployable
samples plus humanoid, four-wheel, biped, tracked, and other template
compositions.

## Create A Module Service

Module names use lowercase kebab-case, for example `demo-action`. The scaffold
creates `module/service/demo_action_service` and a service-local agent entry at
`module/service/demo_action_service/AGENTS.md`, which points to the actual
development constraints in `.skill/demo_action_service/SKILL.md`.

Plain service:

```bash
./pr create module demo-action
```

ROS2 Python service:

```bash
./pr create module demo-action --ros2 python --ros2-version humble
```

ROS2 C++ service:

```bash
./pr create module demo-action --ros2 cpp --ros2-version humble
```

ROS2 Go service:

```bash
./pr create module demo-action --ros2 go --ros2-version humble
```

After creation, confirm these files:

```text
module/service/demo_action_service/
  AGENTS.md
  README.md
  project.json
  config/config.yaml
  config/params.yaml
  tools/generate-interfaces.sh

.skill/demo_action_service/SKILL.md
```

Before changing `module/service/<service>`, read
`module/service/<service>/AGENTS.md` and then the referenced
`.skill/<service>/SKILL.md`. It defines the service's layer boundaries: API
handlers adapt protocols only; business behavior belongs in `src/service`,
`src/scheduler`, `src/executor`, or `src/adapter`; modules communicate only
through declared communication protocols.

## Configure Protocol Contracts

IDL and public interfaces must be changed through the Dashboard or
`./pr data-format`. Do not hand-edit `pkg/idl/**`.

Start the Dashboard:

```bash
./pr dashboard
```

Create data formats from the CLI:

```bash
./pr data-format --service demo_action_service --kind msg --name RobotState --data "string robot_id"
./pr data-format --service demo_action_service --kind proto --name RobotState --file ./RobotState.proto
./pr data-format --service demo_action_service --kind dds_idl --name RobotState --stdin < RobotState.idl
```

Default Dashboard address:

```text
http://localhost:13630
```

The Dashboard writes or refreshes protocol files and triggers interface
scaffolding. Common protocol source locations are:

```text
pkg/idl/<service>/ros2/...
pkg/idl/<service>/pb/...
pkg/idl/<service>/public/interfaces.yaml
```

Use these paths to inspect generated output, not to make manual edits.

Protocol ownership rules:

| Scenario | Owner |
| --- | --- |
| This service publishes a public topic | This service owns the public interface. |
| This service exposes request/response | This service owns the public interface. |
| This service subscribes to another service | Configure only a consumer route in this service's `config.yaml`; reference the provider's public interface. |
| This service calls another service | Configure only a client route in this service's `config.yaml`; reference the provider's public interface. |

If communication logic requires an IDL change, record the issue and update the
IDL through the Dashboard or `./pr data-format`.

## Generate Interface Code

After protocol contracts and `config.yaml` are aligned, run a dry-run first:

```bash
./pr gen:interfaces --service demo_action_service --dry-run
```

After confirming the manifest, generate the interfaces:

```bash
./pr gen:interfaces --service demo_action_service
```

Normal generation does not overwrite existing business implementation skeletons.
Use `--force` only when you explicitly want to reset editable implementation
files:

```bash
./pr gen:interfaces --service demo_action_service --force
```

Notes:

- `pkg/idl/**/generated/**` is generated output; do not write business logic here.
- `pkg/idl/**/protocol_manifest.json` is generated output; do not edit by hand.
- Generated handlers, publishers, and registries mainly bind protocols.
- Real business behavior belongs in the module's service, scheduler, executor,
  or adapter layers.

## Implement Business Logic

First read the current service skill files:

```bash
sed -n '1,160p' module/service/demo_action_service/AGENTS.md
sed -n '1,220p' .skill/demo_action_service/SKILL.md
```

Then use the generated output to find business extension points:

| Directory | Responsibility |
| --- | --- |
| `src/api/handler` or `internal/api` | Thin protocol entry adapters. |
| `src/service` or `internal/service` | Use-case orchestration and business behavior. |
| `src/scheduler` | Optional scheduling, priority, cancellation, and state transitions. |
| `src/executor` | Optional execution flow and algorithms. |
| `src/adapter` | Optional hardware or external system adapters. |
| `src/runtime` | Runtime binding only; no business rules. |

Typical call direction:

```text
api handler -> service -> scheduler/executor -> adapter -> external systems
```

Never connect `module/service/*` implementations through direct source-code
calls. If two services need to interact, define or reference a public interface
through the Dashboard, then configure provider/consumer routes in each service's
`config.yaml`.

## Local Checks And Builds

After changing protocols, configuration, or business code, validate in this
order:

```bash
./pr check:comm
./pr check
./pr affected
```

Before commit, or when the blast radius is larger:

```bash
./pr check:all
./pr build
```

For ROS2 modules on macOS or non-native ROS2 environments, prefer the Docker
ROS2 environment:

```bash
./pr ros2:build-image
./pr ros2:build --packages-select demo_action
./pr ros2:build --packages-up-to demo_action
```

`--packages-select` uses the `<name>` value from `package.xml`, not the service
directory name. If Dockerfile dependencies change, clean the old ROS2 image and
repository cache before rebuilding:

```bash
sudo ./pr clean
sudo ./pr ros2:build-image
```

By default, the build uses Docker Hub's `ros:<distro>-ros-base`, such as
`ros:humble-ros-base`. If your network environment needs a private registry
cache, configure Harbor explicitly:

```bash
HARBOR_REGISTRY=<registry-host:port> \
HARBOR_USERNAME=<username> \
HARBOR_PASSWORD=<password> \
HARBOR_LOGIN=1 \
./image/push-to-harbor.sh --multi-arch-ros-base
```

You can also specify the base image directly:

```bash
ROS_BASE_IMAGE=<registry-host:port>/library/ros:humble-ros-base \
  ./pr ros2:build --packages-select demo_action
```

ROS2 images do not install Go by default. Enable it explicitly when building Go
ROS2 services:

```bash
INSTALL_GOLANG=1 ./pr ros2:build-image
INSTALL_GOLANG=1 ./pr ros2:build --packages-select middleware_pub_test
```

Vision development dependencies are disabled by default. Without `VISION_TARGET`,
the build still produces a plain ROS2 image. Common vision dependencies can be
enabled with `ENABLE_VISION_STACK=1`:

```bash
ENABLE_VISION_STACK=1 ./pr ros2:build-image
```

When NVIDIA/CUDA/TensorRT is required, build the target vision image with
`VISION_TARGET`:

```bash
VISION_TARGET=auto ./pr ros2:build-image
VISION_TARGET=pc-nvidia ./pr ros2:build-image
VISION_TARGET=jetson ./pr ros2:build-image
```

Use the same profile when building packages:

```bash
VISION_TARGET=auto ./pr ros2:build --packages-select demo_action
```

`auto` maps architectures as follows: `amd64`/`x86_64` uses `pc-nvidia`, and
`arm64`/`aarch64` uses `jetson`. Remote deployment prefers the architecture
detected on the remote machine; `--dry-run` requires an explicit `--platform`.

## Communication Middleware Scope

`infra/communication` currently implements only part of the middleware matrix.
Use these high-level route middleware values in module `config.yaml` files:

| Middleware | Status |
| --- | --- |
| `nats` | Implemented. |
| `ros2` | Implemented. |
| `cyclonedds` | Implemented, partial by data path. |
| `fastdds` | Implemented, partial by data path. |
| `zenoh`, `grpc`, `mqtt` | Reserved only; not implemented. |

See [infra/communication/README.md](./infra/communication/README.md) for the
language-specific coverage and limitations.

## Local Run

ROS2 service:

```bash
./pr ros2:run demo_action --domain-id 42
```

Specify the executable explicitly:

```bash
./pr ros2:run demo_action demo_action_node --domain-id 42
```

Pass local hardware devices through:

```bash
./pr ros2:run imu --device /dev/ttyUSB0
```

Hardware that needs the host network namespace:

```bash
./pr ros2:run imu imu_node \
  --network host \
  --privileged \
  --device /dev/ttyUSB0:/dev/ttyUSB0
```

Start the optional observability stack:

```bash
./pr observability:up
```

Default endpoints:

| Service | Address |
| --- | --- |
| Grafana | `http://localhost:16000` |
| Prometheus | `http://localhost:18180` |
| Loki | `http://localhost:6200` |
| Tempo | `http://localhost:6400` |
| OTLP HTTP | `http://localhost:8636` |
| OTLP gRPC | `localhost:8634` |

Inspect communication routes and runtime state:

```bash
./pr monitor --list-routes
./pr monitor list
./pr monitor -i demo_action
```

## Deployment

ROS2 remote deployment builds the current workspace into a runtime image over
SSH, pushes it to the remote Docker host, and restarts the container:

```bash
./pr ros2:deploy \
  --host 192.0.2.20 \
  --user jetson \
  --password '<ssh-password>' \
  --packages-select demo_action \
  --domain-id 42
```

Vision deployment can use `VISION_TARGET=auto`; the script chooses `pc-nvidia`
or `jetson` from the remote architecture. When previewing commands only, pass
`--platform` explicitly:

```bash
VISION_TARGET=auto ./pr ros2:deploy \
  --host 192.0.2.20 \
  --user jetson \
  --packages-select demo_action \
  --domain-id 42

VISION_TARGET=auto ./pr ros2:deploy --dry-run \
  --platform linux/arm64 \
  --host 192.0.2.20 \
  --packages-select demo_action
```

Common deployment options:

| Option | Purpose |
| --- | --- |
| `--host` | Remote Docker host. |
| `--user` | SSH user. |
| `--password` | SSH password; `DEPLOY_PASSWORD` is also supported. |
| `--packages-select` | ROS2 package name. |
| `--executable` | ROS2 executable inside the container; inferred by default. |
| `--domain-id` | Remote `ROS_DOMAIN_ID`; default is 42. |
| `--platform` | Build platform, such as `linux/arm64`; auto-detected remotely when omitted. |
| `--base-image` | ROS base image override. |
| `--network` | Remote Docker network; default is `host`. |
| `--device` | Hardware device passthrough. |
| `--volume` | Remote volume mount. |
| `--privileged` | Enable when hardware privileges are needed. |
| `--env KEY=VALUE` | Pass container environment variables. |
| `--logs-tail` | Print container log lines after deployment; default is 120. |
| `--no-logs` | Do not print container logs after deployment. |
| `--dry-run` | Print planned commands only; no build and no SSH. |

When using `--password` or `DEPLOY_PASSWORD`, install `sshpass` locally.

## Repository Boundaries

```text
pkg/        Pure shared contracts, data structures, and runtime-free utilities.
infra/      Shared protocol adapters, runtimes, logs, metrics, and traces.
module/     Single-process runtime service modules.
deploy/     Local and cluster deployment topology.
example/    End-to-end examples and demos.
doc/        Cross-project design documents.
bin/        Workspace scaffolding, checks, and boundary tools.
dashboard/  Web/Native control surface.
monitor/    Communication route and runtime-state monitor.
```

Boundary rules:

- `pkg/*` may depend only on other `pkg/*` projects.
- `infra/*` may depend only on `pkg/*` or other `infra/*` projects.
- `module/service/*` may depend on `pkg/*` and `infra/*`.
- Services may interact only through communication protocols; direct source-code
  coupling is forbidden.
- New projects must include `project.json`, a non-empty `README.md`, and a
  `check` target.
- Source contracts under `pkg/idl/**` must not be hand-edited; update IDL
  through the Dashboard or `./pr data-format`.

## More Documentation

- [pr-cmd-all.md](./pr-cmd-all.md): `./pr` command reference.
- [doc/new_module_pr_workflow.md](./doc/new_module_pr_workflow.md): New module workflow.
- [module/README.md](./module/README.md): Module directory rules.
- [pkg/README.md](./pkg/README.md): `pkg` directory rules.
- [infra/README.md](./infra/README.md): `infra` directory rules.
- [deploy/README.md](./deploy/README.md): Deployment directory guide.
- [monitor/pr-monitor/README.md](./monitor/pr-monitor/README.md): Communication route monitor.
