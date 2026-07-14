# Robotics Pacific Rim

Pacific-Rim 是机器人软件系统的 monorepo。日常开发围绕一个明确流程展开：


```text
初始化环境 -> 创建 module service -> 配置协议接口 -> 生成接口代码 -> 实现业务逻辑 -> build/run/deploy
```

日常操作优先使用 `./pr`。完整命令手册见 [pr-cmd-all.md](./pr-cmd-all.md)。
所有 `./pr` 命令都会打印明确状态：结束时输出 `[PR SUCCESS]` 或 `[PR FAILED]`；
前台长运行命令启动后会先输出 `[PR RUNNING]`。

## 0. 初始化工作区

新机器或刚切到这个仓库时，先跑：

```bash
./setup.sh
./pr doctor
./pr check
```

`./setup.sh` 会检查开发依赖，安装根目录和 `dashboard/` 的依赖，写入本地
Dashboard 默认配置，并编译仓库根目录的 `./pr` 入口。

常用检查命令：

| 场景 | 命令 |
| --- | --- |
| 查看入口帮助 | `./pr --help` |
| 列出可用脚本 | `./pr scripts` |
| 环境诊断 | `./pr doctor` |
| 清理缓存 | `./pr clean` |
| 最小仓库检查 | `./pr check` |
| 通信配置检查 | `./pr check:comm` |
| 机器人 profile 检查 | `./pr robot:check` |
| 当前改动影响范围 | `./pr affected` |
| 提交前全量检查 | `./pr check:all` |

## 0.1 机器人 profile 和 AI Native 组合

机器人能力目录在 `pkg/robot/capabilities.json`，机器人组合在
`deploy/robot-profiles/*.json`。这些文件只描述 capability、module 组合和部署意图；
具体协议契约仍然通过 Dashboard 或 `./pr data-format` 创建，不能手写 `pkg/idl`。

```bash
./pr robot:profiles
./pr robot:show pure-driver-sample
./pr robot:check
./pr robot:deploy pure-driver-sample --dry-run --host 192.168.1.20 --domain-id 42
```

Dashboard 的 Robots 页面会读取同一份 profile 数据，用于查看当前可部署样例和
humanoid、four-wheel、biped、tracked 等模板组合。

## 1. 从 0 创建一个 module service

模块名使用 lowercase kebab-case，例如 `demo-action`。脚手架会生成服务目录
`module/service/demo_action_service`，并生成 service-local agent 入口
`module/service/demo_action_service/AGENTS.md`。该入口会指向实际开发约束文件
`.skill/demo_action_service/SKILL.md`。

普通服务：

```bash
./pr create module demo-action
```

ROS2 Python 服务：

```bash
./pr create module demo-action --ros2 python --ros2-version humble
```

ROS2 C++ 服务：

```bash
./pr create module demo-action --ros2 cpp --ros2-version humble
```

ROS2 Go 服务：

```bash
./pr create module demo-action --ros2 go --ros2-version humble
```

创建后先确认这几个文件：

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



## 2. 配置协议接口

IDL 和公共接口必须通过 Dashboard 页面或 `./pr data-format` 修改，不要手工编辑 `pkg/idl/**`。

启动 Dashboard：

```bash
./pr dashboard
```

也可以用命令行创建数据格式：

```bash
./pr data-format --service demo_action_service --kind msg --name RobotState --data "string robot_id"
./pr data-format --service demo_action_service --kind proto --name RobotState --file ./RobotState.proto
./pr data-format --service demo_action_service --kind dds_idl --name RobotState --stdin < RobotState.idl
```

默认地址：

```text
http://localhost:13630
```

在 Dashboard 里为服务配置公共协议和路由。保存后，Dashboard 会写入或刷新协议相关文件，并触发接口脚手架生成。常见协议源位置是：

```text
pkg/idl/<service>/ros2/...
pkg/idl/<service>/pb/...
pkg/idl/<service>/public/interfaces.yaml
```

这些路径用于理解生成结果，但不要手写修改。

协议归属规则：

| 场景 | 放在哪里 |
| --- | --- |
| 本服务公开发布 topic | 本服务的公共接口，由本服务拥有。 |
| 本服务公开提供 request/response service | 本服务的公共接口，由本服务拥有。 |
| 本服务订阅别的服务 topic | 只在本服务 `config.yaml` 配消费路由，引用对方公共接口。 |
| 本服务调用别的服务 | 只在本服务 `config.yaml` 配 client 路由，引用对方公共接口。 |

如果开发过程中发现通信逻辑需要改 IDL，应记录问题并让人通过 Dashboard 或 `./pr data-format` 修改 IDL。

## 3. 生成接口代码

协议和 `config.yaml` 对齐后，先 dry-run：

```bash
./pr gen:interfaces --service demo_action_service --dry-run
```

确认 manifest 正确后生成：

```bash
./pr gen:interfaces --service demo_action_service
```

普通生成不会覆盖已经存在的业务实现骨架。只有明确要重置可编辑实现文件时才使用：

```bash
./pr gen:interfaces --service demo_action_service --force
```

注意：

- `pkg/idl/**/generated/**` 是生成产物，不要手写业务逻辑。
- `pkg/idl/**/protocol_manifest.json` 是生成产物，不要手写修改。
- 生成器产出的 handler、publisher、registry 主要负责协议绑定。
- 真正的业务实现写在 module 自己的 service/scheduler/executor/adapter 层。

## 4. 实现业务逻辑

先读当前服务的技能文件：

```bash
sed -n '1,160p' module/service/demo_action_service/AGENTS.md
sed -n '1,220p' .skill/demo_action_service/SKILL.md
```

再按生成结果找业务填充点。不同语言模板会略有差异，但原则一致：

| 目录 | 职责 |
| --- | --- |
| `src/api/handler` 或 `internal/api` | 协议入口适配，薄层。 |
| `src/service` 或 `internal/service` | use-case 编排和业务行为。 |
| `src/scheduler` | 可选，调度、优先级、取消、状态切换。 |
| `src/executor` | 可选，具体执行流程和算法。 |
| `src/adapter` | 可选，硬件或外部系统适配。 |
| `src/runtime` | runtime 绑定，不放业务规则。 |

典型调用方向：

```text
api handler -> service -> scheduler/executor -> adapter -> external systems
```

`module/service/*` 之间严禁代码直连。如果两个服务要交互，应通过 Dashboard
定义或引用公共接口，然后在各自 `config.yaml` 里配置 provider/consumer route。

## 5. 本地检查和构建

每次改完协议、配置或业务代码，按这个顺序验证：

```bash
./pr check:comm
./pr check
./pr affected
```

提交前或影响范围较大时：

```bash
./pr check:all
./pr build
```


ROS2 module 在 macOS 或非 ROS2 原生环境下，优先使用 Docker ROS2 环境：

```bash
./pr ros2:build-image
./pr ros2:build --packages-select demo_action
./pr ros2:build --packages-up-to demo_action
```

`--packages-select` 使用 `package.xml` 里的 `<name>`，不是服务目录名。
Linux 上如果 Docker 只能通过 `sudo` 使用，可以直接 `sudo ./pr ...`；
脚本会用 `SUDO_UID/SUDO_GID` 创建容器内 `ros` 用户，避免把 `root` 改名导致构建失败。
如果 Dockerfile 依赖发生变化，先清理旧的 ROS2 镜像和仓库缓存，再重新构建：

```bash
sudo ./pr clean
sudo ./pr ros2:build-image
```

默认使用 Docker Hub 的 `ros:<distro>-ros-base`。如果你的网络环境需要私有
registry 镜像缓存，可以显式配置 Harbor：

```bash
HARBOR_REGISTRY=<registry-host:port> \
HARBOR_USERNAME=<username> \
HARBOR_PASSWORD=<password> \
HARBOR_LOGIN=1 \
./image/push-to-harbor.sh --multi-arch-ros-base
```

HTTP registry 需要先让 Docker 信任对应地址，例如 Linux 上：

```bash
sudo mkdir -p /etc/docker
sudo sh -c 'printf "%s\n" '"'"'{"insecure-registries":["<registry-host:port>"]}'"'"' > /etc/docker/daemon.json'
sudo systemctl restart docker
```

也可以直接指定 base image：

```bash
ROS_BASE_IMAGE=<registry-host:port>/library/ros:humble-ros-base \
  ./pr ros2:build --packages-select demo_action
```

ROS2 镜像默认不安装 Go。构建 Go ROS2 service 时显式启用：

```bash
INSTALL_GOLANG=1 ./pr ros2:build-image
INSTALL_GOLANG=1 ./pr ros2:build --packages-select middleware_pub_test
```

视觉开发依赖默认关闭；不设置 `VISION_TARGET` 时仍构建普通 ROS2 镜像。
通用视觉依赖可通过 `ENABLE_VISION_STACK=1` 启用，会安装 OpenCV、ROS2
Humble 消息/rosidl/launch 依赖以及 `onnx==1.16.2`：

```bash
ENABLE_VISION_STACK=1 ./pr ros2:build-image
```

需要 NVIDIA/CUDA/TensorRT 时，用 `VISION_TARGET` 构建目标视觉镜像：

```bash
VISION_TARGET=auto ./pr ros2:build-image
VISION_TARGET=pc-nvidia ./pr ros2:build-image
VISION_TARGET=jetson ./pr ros2:build-image
```

构建 package 时带同样的 profile：

```bash
VISION_TARGET=auto ./pr ros2:build --packages-select demo_action
```

`auto` 会按架构映射：`amd64`/`x86_64` 使用 `pc-nvidia`，
`arm64`/`aarch64` 使用 `jetson`。远端部署时优先使用远端检测到的架构；
`--dry-run` 下需要显式传 `--platform` 才能解析。
`pc-nvidia` 期望基础镜像或 apt 源提供桌面/服务器 CUDA 和 TensorRT 包；
`jetson` 期望 JetPack/L4T 匹配的基础镜像或 apt 源，TensorRT Python 包应使用
JetPack 自带版本，不要额外 pip 混装。

## 6. 本地运行

ROS2 服务：

```bash
./pr ros2:run demo_action   --domain-id 42
```

显式指定 executable：

```bash
./pr ros2:run demo_action demo_action_node   --domain-id 42
```

透传本机硬件设备：

```bash
./pr ros2:run imu --device /dev/ttyUSB0
```

需要共享宿主机网络命名空间的硬件：

```bash
./pr ros2:run imu imu_node \
  --network host \
  --privileged \
  --device /dev/ttyUSB0:/dev/ttyUSB0
```

启动观测栈(可不做)：

```bash
./pr observability:up
```

默认端点：

| 服务 | 地址 |
| --- | --- |
| Grafana | `http://localhost:16000` |
| Prometheus | `http://localhost:18180` |
| Loki | `http://localhost:6200` |
| Tempo | `http://localhost:6400` |
| OTLP HTTP | `http://localhost:8636` |
| OTLP gRPC | `localhost:8634` |

查看通信 route 和运行态：

```bash
./pr monitor --list-routes
./pr monitor list
./pr monitor -i demo_action
```

## 7. 部署

ROS2 远端部署通过 SSH 把当前工作区代码构建成运行镜像，推到远端 Docker 主机并重启容器：

```bash
./pr ros2:deploy \
  --host 192.168.1.20 \
  --user jetson \
  --password '<ssh-password>' \
  --packages-select demo_action \
  --domain-id 42
```

默认会通过 SSH 在远端执行 `uname -m`，自动把 `x86_64` 映射到
`linux/amd64`，把 `aarch64`/`arm64` 映射到 `linux/arm64`。挂硬件设备时
不需要手写平台：

```bash
./pr ros2:deploy \
  --host 192.168.1.20 \
  --user jetson \
  --password '<ssh-password>' \
  --packages-select demo_action \
  --domain-id 42 \
  --device /dev/ttyUSB0
```

视觉部署可以使用 `VISION_TARGET=auto`，脚本会按远端架构选择 `pc-nvidia`
或 `jetson`。只预览命令时需要显式传 `--platform`：

```bash
VISION_TARGET=auto ./pr ros2:deploy \
  --host 192.168.1.20 \
  --user jetson \
  --packages-select demo_action \
  --domain-id 42

VISION_TARGET=auto ./pr ros2:deploy --dry-run \
  --platform linux/arm64 \
  --host 192.168.1.20 \
  --packages-select demo_action
```

常用部署参数：

| 参数 | 用途 |
| --- | --- |
| `--host` | 远端 Docker 主机。 |
| `--user` | SSH 用户，默认可由环境或脚本决定。 |
| `--password` | SSH 密码；也可用 `DEPLOY_PASSWORD` 环境变量。 |
| `--packages-select` | ROS2 package 名。 |
| `--executable` | 容器内运行的 ROS2 executable，默认推断。 |
| `--domain-id` | 远端 `ROS_DOMAIN_ID`，默认 42。 |
| `--platform` | 构建平台，例如 `linux/arm64`；不传时自动识别远端架构。 |
| `--base-image` | 指定 ROS base image。 |
| `--container-name` | 远端容器名，默认使用 package 名。 |
| `--network` | 远端 Docker network，默认 `host`。 |
| `--device` | 透传硬件设备。 |
| `--volume` | 挂载远端 volume。 |
| `--privileged` | 需要硬件权限时启用。 |
| `--env KEY=VALUE` | 传入容器环境变量。 |
| `--logs-tail` | 部署后打印容器日志行数，默认 120。 |
| `--no-logs` | 部署后不打印容器日志。 |
| `--dry-run` | 只打印将执行的命令，不构建、不 SSH。 |

使用 `--password` 或 `DEPLOY_PASSWORD` 时，本机需要安装 `sshpass`。

本地部署拓扑和共享端点放在 [deploy/local/platform.yaml](./deploy/local/platform.yaml)，说明见 [deploy/local/README.md](./deploy/local/README.md)。

## 8. 仓库边界

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

边界规则：

- `pkg/*` 是纯通用库，只能依赖其他 `pkg/*` 项目。
- `infra/*` 是共享适配与运行时库，只能依赖 `pkg/*` 或其他 `infra/*` 项目。
- `module/service/*` 是服务模块，可以依赖 `pkg/*` 和 `infra/*`。
- `module/service/*` 之间只能通过通信协议交互，严禁源代码直连。
- 新增项目必须补 `project.json`、非空 `README.md` 和 `check` target。
- `pkg/idl/**` 源契约不能手工编辑；IDL 只能通过 Dashboard 或 `./pr data-format` 修改。
- `pkg/idl/**/generated/**` 和 `pkg/idl/**/protocol_manifest.json` 只能由生成器刷新。

## 更多文档

- [pr-cmd-all.md](./pr-cmd-all.md): `./pr` 常用命令手册。
- [doc/new_module_pr_workflow.md](./doc/new_module_pr_workflow.md): 新模块工作流。
- [module/README.md](./module/README.md): module 目录规则。
- [pkg/README.md](./pkg/README.md): pkg 目录规则。
- [infra/README.md](./infra/README.md): infra 目录规则。
- [deploy/README.md](./deploy/README.md): 部署目录说明。
- [monitor/pr-monitor/README.md](./monitor/pr-monitor/README.md): 通信 route 监控。
