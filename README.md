# Robotics Pacific Rim

[![CI](https://github.com/letianxing/robotics-pacific-rim/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/letianxing/robotics-pacific-rim/actions/workflows/ci.yml)

Pacific-Rim 是一个由 **AI Native + Robotics** 驱动的机器人全栈 monorepo。
它把机器人业务服务、协议接口、ROS2/通信运行时、部署工具链和 Dashboard 放在同一个工作区里，
让开发者围绕 module service 迭代机器人能力，而不是在多个割裂仓库之间手工同步。

Pacific-Rim is an **AI Native + Robotics** full-stack monorepo. It keeps robot
business services, protocol contracts, ROS2/communication runtimes, deployment
tooling, and the Dashboard in one workspace, so teams can evolve robot
capabilities around module services instead of manually synchronizing multiple
repositories.

这个仓库的核心开发单元是 `module/service/*`。每个 service 都有清晰的边界、
协议入口和本地 agent 约束文件，因此可以直接通过 **vibe coding** 的方式描述目标、
让 AI agent 修改 service 内部实现、补齐接口与测试，再用 `./pr` 完成生成、检查、运行和部署。

The core development unit is `module/service/*`. Each service has explicit
boundaries, protocol entry points, and local agent constraints, so you can use
**vibe coding** to describe the target behavior, let an AI agent update the
service implementation, fill in interfaces and tests, and then use `./pr` for
generation, checks, local runs, and deployment.

日常开发围绕一个明确流程展开：

```text
初始化环境 -> 创建 module service -> 配置协议接口 -> 生成接口代码 -> 实现业务逻辑 -> build/run/deploy
Initialize workspace -> Create module service -> Configure protocol contracts -> Generate interface code -> Implement behavior -> build/run/deploy
```

日常操作优先使用 `./pr`。完整命令手册见 [pr-cmd-all.md](./pr-cmd-all.md)。
所有 `./pr` 命令都会打印明确状态：结束时输出 `[PR SUCCESS]` 或 `[PR FAILED]`；
前台长运行命令启动后会先输出 `[PR RUNNING]`。

Use `./pr` for day-to-day operations. See [pr-cmd-all.md](./pr-cmd-all.md) for
the full command reference. Every `./pr` command prints a clear final status:
`[PR SUCCESS]` or `[PR FAILED]`. Long-running foreground commands print
`[PR RUNNING]` after startup.

开源协作入口：

Open-source collaboration entry points:

[CONTRIBUTING.md](./CONTRIBUTING.md)、
[SECURITY.md](./SECURITY.md)、
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)、
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 0. 初始化工作区 / Workspace Setup

新机器或刚切到这个仓库时，先跑：

On a new machine, or right after switching to this repository, run:

```bash
./setup.sh
./pr doctor
./pr check
```

`./setup.sh` 会检查开发依赖，安装根目录和 `dashboard/` 的依赖，写入本地
Dashboard 默认配置，并编译仓库根目录的 `./pr` 入口。

`./setup.sh` checks local development dependencies, installs root and
`dashboard/` dependencies, writes default local Dashboard configuration, and
builds the root `./pr` entrypoint.

常用检查命令：

Common checks:

| 场景 / Scenario | 命令 / Command |
| --- | --- |
| 查看入口帮助 / CLI help | `./pr --help` |
| 列出可用脚本 / List scripts | `./pr scripts` |
| 环境诊断 / Environment diagnostics | `./pr doctor` |
| 清理缓存 / Clean caches | `./pr clean` |
| 最小仓库检查 / Minimal repository check | `./pr check` |
| 通信配置检查 / Communication config check | `./pr check:comm` |
| 机器人 profile 检查 / Robot profile check | `./pr robot:check` |
| 当前改动影响范围 / Affected projects | `./pr affected` |
| 提交前全量检查 / Full pre-submit check | `./pr check:all` |

## 0.1 机器人 Profile 和 AI Native 组合 / Robot Profiles And AI Native Composition

机器人能力目录在 `pkg/robot/capabilities.json`，机器人组合在
`deploy/robot-profiles/*.json`。这些文件只描述 capability、module 组合和部署意图；
具体协议契约仍然通过 Dashboard 或 `./pr data-format` 创建，不能手写 `pkg/idl`。

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

Dashboard 的 Robots 页面会读取同一份 profile 数据，用于查看当前可部署样例和
humanoid、four-wheel、biped、tracked 等模板组合。

The Dashboard Robots page reads the same profile data and shows deployable
samples plus humanoid, four-wheel, biped, tracked, and other template
compositions.

## 1. 从 0 创建一个 Module Service / Create A Module Service From Scratch

模块名使用 lowercase kebab-case，例如 `demo-action`。脚手架会生成服务目录
`module/service/demo_action_service`，并生成 service-local agent 入口
`module/service/demo_action_service/AGENTS.md`。该入口会指向实际开发约束文件
`.skill/demo_action_service/SKILL.md`。

Module names use lowercase kebab-case, for example `demo-action`. The scaffold
creates `module/service/demo_action_service` and a service-local agent entrypoint
at `module/service/demo_action_service/AGENTS.md`, which points to the actual
development constraints in `.skill/demo_action_service/SKILL.md`.

普通服务 / Plain service:

```bash
./pr create module demo-action
```

ROS2 Python 服务 / ROS2 Python service:

```bash
./pr create module demo-action --ros2 python --ros2-version humble
```

ROS2 C++ 服务 / ROS2 C++ service:

```bash
./pr create module demo-action --ros2 cpp --ros2-version humble
```

ROS2 Go 服务 / ROS2 Go service:

```bash
./pr create module demo-action --ros2 go --ros2-version humble
```

创建后先确认这几个文件：

After creation, first confirm these files:

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

开发 `module/service/<service>` 前必须先读对应 `module/service/<service>/AGENTS.md`，
再按其中引用读取 `.skill/<service>/SKILL.md`。
它定义了当前服务的分层边界：API handler 只做协议适配，业务逻辑放在
`src/service`、`src/scheduler`、`src/executor` 或 `src/adapter`，模块之间只能通过通信协议交互。

Before changing `module/service/<service>`, read
`module/service/<service>/AGENTS.md` and then the referenced
`.skill/<service>/SKILL.md`. It defines the service's layer boundaries: API
handlers adapt protocols only; business behavior belongs in `src/service`,
`src/scheduler`, `src/executor`, or `src/adapter`; modules communicate only
through declared communication protocols.


## 2. 配置协议接口 / Configure Protocol Contracts

IDL 和公共接口必须通过 Dashboard 页面或 `./pr data-format` 修改，不要手工编辑 `pkg/idl/**`。

IDL and public interfaces must be changed through the Dashboard or
`./pr data-format`. Do not hand-edit `pkg/idl/**`.

启动 Dashboard / Start the Dashboard:

```bash
./pr dashboard
```

也可以用命令行创建数据格式 / You can also create data formats from the CLI:

```bash
./pr data-format --service demo_action_service --kind msg --name RobotState --data "string robot_id"
./pr data-format --service demo_action_service --kind proto --name RobotState --file ./RobotState.proto
./pr data-format --service demo_action_service --kind dds_idl --name RobotState --stdin < RobotState.idl
```

默认地址 / Default address:

```text
http://localhost:13630
```

在 Dashboard 里为服务配置公共协议和路由。保存后，Dashboard 会写入或刷新协议相关文件，并触发接口脚手架生成。常见协议源位置是：

Configure public protocols and routes for the service in the Dashboard. After
save, the Dashboard writes or refreshes protocol files and triggers interface
scaffolding. Common protocol source locations are:

```text
pkg/idl/<service>/ros2/...
pkg/idl/<service>/pb/...
pkg/idl/<service>/public/interfaces.yaml
```

这些路径用于理解生成结果，但不要手写修改。

Use these paths to inspect generated output, not to make manual edits.

协议归属规则：

Protocol ownership rules:

| 场景 / Scenario | 放在哪里 / Owner |
| --- | --- |
| 本服务公开发布 topic / This service publishes a public topic | 本服务的公共接口，由本服务拥有 / This service owns the public interface. |
| 本服务公开提供 request/response service / This service exposes request/response | 本服务的公共接口，由本服务拥有 / This service owns the public interface. |
| 本服务订阅别的服务 topic / This service subscribes to another service | 只在本服务 `config.yaml` 配消费路由，引用对方公共接口 / Configure only a consumer route in this service's `config.yaml`; reference the provider's public interface. |
| 本服务调用别的服务 / This service calls another service | 只在本服务 `config.yaml` 配 client 路由，引用对方公共接口 / Configure only a client route in this service's `config.yaml`; reference the provider's public interface. |

如果开发过程中发现通信逻辑需要改 IDL，应记录问题并让人通过 Dashboard 或 `./pr data-format` 修改 IDL。

If communication logic requires an IDL change, record the issue and update the
IDL through the Dashboard or `./pr data-format`.

## 3. 生成接口代码 / Generate Interface Code

协议和 `config.yaml` 对齐后，先 dry-run：

After protocol contracts and `config.yaml` are aligned, run a dry-run first:

```bash
./pr gen:interfaces --service demo_action_service --dry-run
```

确认 manifest 正确后生成：

After confirming the manifest, generate the interfaces:

```bash
./pr gen:interfaces --service demo_action_service
```

普通生成不会覆盖已经存在的业务实现骨架。只有明确要重置可编辑实现文件时才使用：

Normal generation does not overwrite existing business implementation skeletons.
Use `--force` only when you explicitly want to reset editable implementation
files:

```bash
./pr gen:interfaces --service demo_action_service --force
```

注意：

Notes:

- `pkg/idl/**/generated/**` 是生成产物，不要手写业务逻辑 / Generated output; do not write business logic here.
- `pkg/idl/**/protocol_manifest.json` 是生成产物，不要手写修改 / Generated manifest; do not edit by hand.
- 生成器产出的 handler、publisher、registry 主要负责协议绑定 / Generated handlers, publishers, and registries mainly bind protocols.
- 真正的业务实现写在 module 自己的 service/scheduler/executor/adapter 层 / Real business behavior belongs in the module's service, scheduler, executor, or adapter layers.

## 4. 实现业务逻辑 / Implement Business Logic

先读当前服务的技能文件：

First read the current service skill files:

```bash
sed -n '1,160p' module/service/demo_action_service/AGENTS.md
sed -n '1,220p' .skill/demo_action_service/SKILL.md
```

再按生成结果找业务填充点。不同语言模板会略有差异，但原则一致：

Then use the generated output to find business extension points. Language
templates differ slightly, but the layering principle is the same:

| 目录 / Directory | 职责 / Responsibility |
| --- | --- |
| `src/api/handler` 或 `internal/api` | 协议入口适配，薄层 / Thin protocol entry adapters. |
| `src/service` 或 `internal/service` | use-case 编排和业务行为 / Use-case orchestration and business behavior. |
| `src/scheduler` | 可选，调度、优先级、取消、状态切换 / Optional scheduling, priority, cancellation, and state transitions. |
| `src/executor` | 可选，具体执行流程和算法 / Optional execution flow and algorithms. |
| `src/adapter` | 可选，硬件或外部系统适配 / Optional hardware or external system adapters. |
| `src/runtime` | runtime 绑定，不放业务规则 / Runtime binding only; no business rules. |

典型调用方向：

Typical call direction:

```text
api handler -> service -> scheduler/executor -> adapter -> external systems
```

`module/service/*` 之间严禁代码直连。如果两个服务要交互，应通过 Dashboard
定义或引用公共接口，然后在各自 `config.yaml` 里配置 provider/consumer route。

Never connect `module/service/*` implementations through direct source-code
calls. If two services need to interact, define or reference a public interface
through the Dashboard, then configure provider/consumer routes in each service's
`config.yaml`.

## 5. 本地检查和构建 / Local Checks And Builds

每次改完协议、配置或业务代码，按这个顺序验证：

After changing protocols, configuration, or business code, validate in this
order:

```bash
./pr check:comm
./pr check
./pr affected
```

提交前或影响范围较大时：

Before commit, or when the blast radius is larger:

```bash
./pr check:all
./pr build
```


ROS2 module 在 macOS 或非 ROS2 原生环境下，优先使用 Docker ROS2 环境：

For ROS2 modules on macOS or non-native ROS2 environments, prefer the Docker
ROS2 environment:

```bash
./pr ros2:build-image
./pr ros2:build --packages-select demo_action
./pr ros2:build --packages-up-to demo_action
```

`--packages-select` 使用 `package.xml` 里的 `<name>`，不是服务目录名。
Linux 上如果 Docker 只能通过 `sudo` 使用，可以直接 `sudo ./pr ...`；
脚本会用 `SUDO_UID/SUDO_GID` 创建容器内 `ros` 用户，避免把 `root` 改名导致构建失败。
如果 Dockerfile 依赖发生变化，先清理旧的 ROS2 镜像和仓库缓存，再重新构建：

`--packages-select` uses the `<name>` value from `package.xml`, not the service
directory name. On Linux, if Docker requires `sudo`, you can run `sudo ./pr ...`
directly. The scripts use `SUDO_UID/SUDO_GID` to create the container `ros` user
and avoid renaming `root`. If Dockerfile dependencies change, clean the old ROS2
image and repository cache before rebuilding:

```bash
sudo ./pr clean
sudo ./pr ros2:build-image
```

默认使用 Docker Hub 的 `ros:<distro>-ros-base`。如果你的网络环境需要私有
registry 镜像缓存，可以显式配置 Harbor：

By default, the build uses Docker Hub's `ros:<distro>-ros-base`. If your network
environment needs a private registry cache, configure Harbor explicitly:

```bash
HARBOR_REGISTRY=<registry-host:port> \
HARBOR_USERNAME=<username> \
HARBOR_PASSWORD=<password> \
HARBOR_LOGIN=1 \
./image/push-to-harbor.sh --multi-arch-ros-base
```

HTTP registry 需要先让 Docker 信任对应地址，例如 Linux 上：

For an HTTP registry, first make Docker trust that address. For example, on
Linux:

```bash
sudo mkdir -p /etc/docker
sudo sh -c 'printf "%s\n" '"'"'{"insecure-registries":["<registry-host:port>"]}'"'"' > /etc/docker/daemon.json'
sudo systemctl restart docker
```

也可以直接指定 base image：

You can also specify the base image directly:

```bash
ROS_BASE_IMAGE=<registry-host:port>/library/ros:humble-ros-base \
  ./pr ros2:build --packages-select demo_action
```

ROS2 镜像默认不安装 Go。构建 Go ROS2 service 时显式启用：

ROS2 images do not install Go by default. Enable it explicitly when building Go
ROS2 services:

```bash
INSTALL_GOLANG=1 ./pr ros2:build-image
INSTALL_GOLANG=1 ./pr ros2:build --packages-select middleware_pub_test
```

视觉开发依赖默认关闭；不设置 `VISION_TARGET` 时仍构建普通 ROS2 镜像。
通用视觉依赖可通过 `ENABLE_VISION_STACK=1` 启用，会安装 OpenCV、ROS2
Humble 消息/rosidl/launch 依赖以及 `onnx==1.16.2`：

Vision development dependencies are disabled by default. Without `VISION_TARGET`,
the build still produces a plain ROS2 image. Common vision dependencies can be
enabled with `ENABLE_VISION_STACK=1`; this installs OpenCV, ROS2 Humble
message/rosidl/launch dependencies, and `onnx==1.16.2`:

```bash
ENABLE_VISION_STACK=1 ./pr ros2:build-image
```

需要 NVIDIA/CUDA/TensorRT 时，用 `VISION_TARGET` 构建目标视觉镜像：

When NVIDIA/CUDA/TensorRT is required, build the target vision image with
`VISION_TARGET`:

```bash
VISION_TARGET=auto ./pr ros2:build-image
VISION_TARGET=pc-nvidia ./pr ros2:build-image
VISION_TARGET=jetson ./pr ros2:build-image
```

构建 package 时带同样的 profile：

Use the same profile when building packages:

```bash
VISION_TARGET=auto ./pr ros2:build --packages-select demo_action
```

`auto` 会按架构映射：`amd64`/`x86_64` 使用 `pc-nvidia`，
`arm64`/`aarch64` 使用 `jetson`。远端部署时优先使用远端检测到的架构；
`--dry-run` 下需要显式传 `--platform` 才能解析。
`pc-nvidia` 期望基础镜像或 apt 源提供桌面/服务器 CUDA 和 TensorRT 包；
`jetson` 期望 JetPack/L4T 匹配的基础镜像或 apt 源，TensorRT Python 包应使用
JetPack 自带版本，不要额外 pip 混装。

`auto` maps architectures as follows: `amd64`/`x86_64` uses `pc-nvidia`, and
`arm64`/`aarch64` uses `jetson`. Remote deployment prefers the architecture
detected on the remote machine; `--dry-run` requires an explicit `--platform`.
`pc-nvidia` expects CUDA and TensorRT packages from the base image or apt
sources for desktop/server NVIDIA targets. `jetson` expects a JetPack/L4T
matched base image or apt source; TensorRT Python packages should come from
JetPack and should not be mixed with extra pip installs.

## 6. 本地运行 / Local Run

ROS2 服务 / ROS2 service:

```bash
./pr ros2:run demo_action   --domain-id 42
```

显式指定 executable / Specify the executable explicitly:

```bash
./pr ros2:run demo_action demo_action_node   --domain-id 42
```

透传本机硬件设备 / Pass local hardware devices through:

```bash
./pr ros2:run imu --device /dev/ttyUSB0
```

需要共享宿主机网络命名空间的硬件 / Hardware that needs the host network namespace:

```bash
./pr ros2:run imu imu_node \
  --network host \
  --privileged \
  --device /dev/ttyUSB0:/dev/ttyUSB0
```

启动观测栈(可不做) / Start the optional observability stack:

```bash
./pr observability:up
```

默认端点 / Default endpoints:

| 服务 / Service | 地址 / Address |
| --- | --- |
| Grafana | `http://localhost:16000` |
| Prometheus | `http://localhost:18180` |
| Loki | `http://localhost:6200` |
| Tempo | `http://localhost:6400` |
| OTLP HTTP | `http://localhost:8636` |
| OTLP gRPC | `localhost:8634` |

查看通信 route 和运行态 / Inspect communication routes and runtime state:

```bash
./pr monitor --list-routes
./pr monitor list
./pr monitor -i demo_action
```

## 7. 部署 / Deployment

ROS2 远端部署通过 SSH 把当前工作区代码构建成运行镜像，推到远端 Docker 主机并重启容器：

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

默认会通过 SSH 在远端执行 `uname -m`，自动把 `x86_64` 映射到
`linux/amd64`，把 `aarch64`/`arm64` 映射到 `linux/arm64`。挂硬件设备时
不需要手写平台：

By default, the script runs `uname -m` on the remote host over SSH and maps
`x86_64` to `linux/amd64`, and `aarch64`/`arm64` to `linux/arm64`. When passing
hardware devices through, you usually do not need to specify the platform
manually:

```bash
./pr ros2:deploy \
  --host 192.0.2.20 \
  --user jetson \
  --password '<ssh-password>' \
  --packages-select demo_action \
  --domain-id 42 \
  --device /dev/ttyUSB0
```

视觉部署可以使用 `VISION_TARGET=auto`，脚本会按远端架构选择 `pc-nvidia`
或 `jetson`。只预览命令时需要显式传 `--platform`：

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

常用部署参数：

Common deployment options:

| 参数 / Option | 用途 / Purpose |
| --- | --- |
| `--host` | 远端 Docker 主机 / Remote Docker host. |
| `--user` | SSH 用户，默认可由环境或脚本决定 / SSH user; defaults can come from env or scripts. |
| `--password` | SSH 密码；也可用 `DEPLOY_PASSWORD` 环境变量 / SSH password; `DEPLOY_PASSWORD` is also supported. |
| `--packages-select` | ROS2 package 名 / ROS2 package name. |
| `--executable` | 容器内运行的 ROS2 executable，默认推断 / ROS2 executable inside the container; inferred by default. |
| `--domain-id` | 远端 `ROS_DOMAIN_ID`，默认 42 / Remote `ROS_DOMAIN_ID`; default is 42. |
| `--platform` | 构建平台，例如 `linux/arm64`；不传时自动识别远端架构 / Build platform, such as `linux/arm64`; auto-detected remotely when omitted. |
| `--base-image` | 指定 ROS base image / ROS base image override. |
| `--container-name` | 远端容器名，默认使用 package 名 / Remote container name; package name by default. |
| `--network` | 远端 Docker network，默认 `host` / Remote Docker network; default is `host`. |
| `--device` | 透传硬件设备 / Hardware device passthrough. |
| `--volume` | 挂载远端 volume / Remote volume mount. |
| `--privileged` | 需要硬件权限时启用 / Enable when hardware privileges are needed. |
| `--env KEY=VALUE` | 传入容器环境变量 / Pass container environment variables. |
| `--logs-tail` | 部署后打印容器日志行数，默认 120 / Print container log lines after deployment; default is 120. |
| `--no-logs` | 部署后不打印容器日志 / Do not print container logs after deployment. |
| `--dry-run` | 只打印将执行的命令，不构建、不 SSH / Print planned commands only; no build and no SSH. |

使用 `--password` 或 `DEPLOY_PASSWORD` 时，本机需要安装 `sshpass`。

When using `--password` or `DEPLOY_PASSWORD`, install `sshpass` locally.

本地部署拓扑和共享端点放在 [deploy/local/platform.yaml](./deploy/local/platform.yaml)，说明见 [deploy/local/README.md](./deploy/local/README.md)。

Local deployment topology and shared endpoints live in
[deploy/local/platform.yaml](./deploy/local/platform.yaml). See
[deploy/local/README.md](./deploy/local/README.md) for details.

## 8. 仓库边界 / Repository Boundaries

```text
pkg/        纯通用契约、数据结构和无运行时依赖的工具。
infra/      共享协议适配、运行时、日志、指标和追踪能力。
module/     单进程 runtime 服务模块。
deploy/     本地和集群部署拓扑。
example/    端到端示例或演示程序。
doc/        跨项目设计文档。
bin/        工作区脚手架、检查和边界约束工具。
dashboard/  Web/Native 控制台应用。
monitor/    通信 route 与运行态监控工具。
```

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

边界规则：

Boundary rules:

- `pkg/*` 是纯通用库，只能依赖其他 `pkg/*` 项目 / Pure shared libraries; may depend only on other `pkg/*` projects.
- `infra/*` 是共享适配与运行时库，只能依赖 `pkg/*` 或其他 `infra/*` 项目 / Shared adapter/runtime libraries; may depend only on `pkg/*` or other `infra/*` projects.
- `module/service/*` 是服务模块，可以依赖 `pkg/*` 和 `infra/*` / Service modules; may depend on `pkg/*` and `infra/*`.
- `module/service/*` 之间只能通过通信协议交互，严禁源代码直连 / Services may interact only through communication protocols; direct source-code coupling is forbidden.
- 新增项目必须补 `project.json`、非空 `README.md` 和 `check` target / New projects must include `project.json`, a non-empty `README.md`, and a `check` target.
- `pkg/idl/**` 源契约不能手工编辑；IDL 只能通过 Dashboard 或 `./pr data-format` 修改 / Source contracts under `pkg/idl/**` must not be hand-edited; update IDL through the Dashboard or `./pr data-format`.
- `pkg/idl/**/generated/**` 和 `pkg/idl/**/protocol_manifest.json` 只能由生成器刷新 / `pkg/idl/**/generated/**` and `pkg/idl/**/protocol_manifest.json` must be refreshed only by generators.

## 更多文档 / More Documentation

- [pr-cmd-all.md](./pr-cmd-all.md): `./pr` 常用命令手册 / `./pr` command reference.
- [doc/new_module_pr_workflow.md](./doc/new_module_pr_workflow.md): 新模块工作流 / New module workflow.
- [module/README.md](./module/README.md): module 目录规则 / Module directory rules.
- [pkg/README.md](./pkg/README.md): pkg 目录规则 / `pkg` directory rules.
- [infra/README.md](./infra/README.md): infra 目录规则 / `infra` directory rules.
- [deploy/README.md](./deploy/README.md): 部署目录说明 / Deployment directory guide.
- [monitor/pr-monitor/README.md](./monitor/pr-monitor/README.md): 通信 route 监控 / Communication route monitor.
