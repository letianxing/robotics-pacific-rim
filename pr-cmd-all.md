# pr 命令手册

`./pr` 是 Pacific-Rim 仓库的统一命令入口。日常开发优先使用它；直接调用
`npm`、`nx`、`docker` 或脚本时，也尽量走 `./pr npm`、`./pr nx`、`./pr docker`
或 `./pr run <script>`。

所有 `./pr` 命令都会打印明确状态：

```text
[PR RUNNING] ./pr <command> starting foreground process
[PR SUCCESS] ./pr <command> completed
[PR FAILED] ./pr <command> exit code <code>
```

```bash
./pr --help   # 查看入口、例子和可用 npm scripts
```

## 推荐流程

| 场景 | 顺序 |
| --- | --- |
| 新机器或环境异常 | `./pr doctor` -> `./pr check env` -> `./pr check diag` |
| 日常改代码 | `./pr check` -> `./pr affected` |
| 改通信配置 | `./pr check:comm` -> `./pr gen:interfaces --service <service> --dry-run` |
| 提交前 | `./pr check:all`，必要时补跑 `./pr build`、`./pr test:go`、ROS2 构建 |
| 依赖镜像或缓存异常 | `./pr clean` -> `./pr ros2:build-image` |
| 查项目边界 | `./pr projects` -> `./pr graph` |

高频命令：

```bash
./pr doctor
./pr clean --dry-run
./pr check
./pr check:comm
./pr affected
./pr check:all
./pr dashboard
./pr robot:profiles
./pr robot:check
./pr monitor -i upperbody
./pr gen:interfaces --service demo_action_service --dry-run
./pr ros2:build --packages-select smoke_test1
./pr ros2:run smoke_test1
```

## 命令总览

| 命令 | 用途 |
| --- | --- |
| `./pr doctor` | 检查 Node.js、npm、Go、Docker、Docker Compose 等本机依赖。 |
| `./pr clean` | 清理仓库生成缓存和 Pacific-Rim ROS2 Docker 镜像。 |
| `./pr check` | 最小仓库健康检查，不依赖 Nx。 |
| `./pr check env` | 打印 Pacific-Rim/VLink 相关环境变量和用途。 |
| `./pr check diag` | 诊断本机 IP、组播、磁盘、CPU、内存、常用工具和关联进程。 |
| `./pr check:comm` | 检查通信声明、公共接口、路由引用和配置一致性。 |
| `./pr affected` | 只检查受当前改动影响的项目。 |
| `./pr check:all` | 跑所有项目的 `check` target。 |
| `./pr build` | 构建所有可构建项目。 |
| `./pr projects` | 列出 workspace 已登记项目。 |
| `./pr graph` | 打开 Nx 项目依赖图。 |
| `./pr create ...` | 创建 module、pkg 或 infra 项目。 |
| `./pr remove module ...` | 删除 module 项目。 |
| `./pr data-format ...` | 为指定 service 创建 proto、msg、srv 或 DDS IDL 数据格式。 |
| `./pr gen:interfaces ...` | 从服务配置和公共 IDL 生成接口脚手架。 |
| `./pr dashboard ...` | 启动 Dashboard Web 开发服务。 |
| `./pr robot:profiles` | 列出机器人 profile 和模板。 |
| `./pr robot:show <profile-id>` | 查看机器人 profile 的服务、能力和部署信息。 |
| `./pr robot:check` | 校验 `pkg/robot` 能力目录和 `deploy/robot-profiles` 组合。 |
| `./pr robot:deploy <profile-id>` | 按 active profile 选择 ROS2 package 并调用 `ros2:deploy`。 |
| `./pr monitor ...` | 打开通信 route 与运行态监控。 |
| `./pr ros2:*` | 构建、运行、部署 ROS2 module。 |
| `./pr observability:*` | 管理本地 Grafana、Prometheus、Loki、Tempo、OTel Collector。 |
| `./pr test:go` | 运行共享 infra Go 包测试。 |

## 环境和仓库检查

```bash
./pr doctor
./pr clean --dry-run
./pr clean
./pr check
./pr check env
./pr check diag
./pr check:comm
./pr affected
./pr check:all
./pr build
```

说明：

- `doctor` 检查本机依赖是否可用。
- `clean` 删除 `build/`、`install/`、`log/`、`.cache/`、`.nx/cache/` 等可再生成目录，并删除 `pacific-rim-ros2:*` / `pacific-rim-ros2-*:*` 项目 Docker 镜像。
- `clean --dry-run` 只预览清理范围；`clean --no-docker` 跳过 Docker；`clean --docker-builder` 额外执行 `docker builder prune -f`，会影响当前 Docker daemon 的全局 build cache。
- `check` 检查项目结构、边界、配置和 README，是最小健康检查。
- `check env` 说明当前支持的环境变量。
- `check diag` 输出本机网络、资源和关联进程诊断信息。
- `check:comm` 检查通信 manifest、公共接口和 route 引用。
- `affected` 基于 Nx 项目图只跑受当前改动影响的检查。
- `check:all` 跑所有项目的 `check` target。
- `build` 跑所有可构建项目的 `build` target。

例子：

```bash
# 新机器 bootstrap 后确认环境
./pr doctor
./pr check env
./pr check

# 切分支后发现命令异常，先看诊断信息
./pr check diag

# Dockerfile 依赖变更后，先看会清什么，再执行清理
./pr clean --dry-run
sudo ./pr clean

# 只验证当前改动影响范围
./pr affected

# 改了通信配置或服务 config 后
./pr check:comm
```

## 项目列表和依赖图

```bash
./pr projects
./pr graph
```

- `projects` 列出 workspace 已登记项目。
- `graph` 打开 Nx 项目依赖图，用于查看模块边界、隐式依赖和 affected 命中原因。

例子：

```bash
# 查某个服务是否已被 workspace 识别
./pr projects

# 分析为什么某次 affected 命中了多个项目
./pr graph
```

## 机器人 profile

```bash
./pr robot:profiles
./pr robot:profiles --json
./pr robot:show pure-driver-sample
./pr robot:check
./pr robot:deploy pure-driver-sample --dry-run --host 192.168.1.20 --domain-id 42
```

- `pkg/robot/capabilities.json` 定义机器人能力目录，例如 IMU 角速度、底盘速度、关节状态、AI intent、memory event 和 internal state。
- `deploy/robot-profiles/*.json` 定义不同机器人类型的 module 组合。`active` profile 必须能解析到当前存在的 service；`template` profile 可以保留规划中的 service slot。
- `robot:deploy` 只接受 `active` profile，会把 profile 里的 service package 转成 `./pr ros2:deploy --packages-select ...`。
- Dashboard 的 Robots 页面读取同一份数据，用于查看当前可部署样例和 humanoid、four-wheel、biped、tracked 模板。

## 创建和删除项目

```bash
./pr create module navigation
./pr create module lidar-driver --ros2 python --ros2-version humble
./pr create module drive-control --ros2 cpp --ros2-version humble
./pr create module brain-sidecar --ros2 go --ros2-version humble
./pr create pkg robot-contracts
./pr create infra telemetry
./pr remove module navigation
```

说明：

- `create module <name>` 创建普通业务服务模块。
- `create module <name> --ros2 python|cpp|go` 创建 ROS2 服务模块。
- `create pkg <name>` 创建共享契约、数据结构或通用类型项目。
- `create infra <name>` 创建通信、日志、追踪、指标、运行时适配等基础设施项目。
- `remove module <name>` 删除一个 workspace module。

模块名使用 lowercase kebab-case，例如 `lidar-driver`。脚手架会生成
`module/service/<name>_service`，并生成对应
`module/service/<name>_service/AGENTS.md`。该文件会指向
`.skill/<name>_service/SKILL.md`。

## 数据格式创建

```bash
./pr data-format --list-services
./pr data-format --service demo_action_service --kind msg --name RobotState --data "string robot_id"
./pr data-format --service demo_action_service --kind srv --name Plan --file ./Plan.srv
./pr data-format --service demo_action_service --kind proto --name RobotState --file ./RobotState.proto
./pr data-format --service demo_action_service --kind dds_idl --name RobotState --stdin < RobotState.idl
```

`data-format` 会为指定 `module/service/<service>` 创建源契约文件：

- `proto`: `pkg/idl/<service>/pb/<service>.proto`
- `msg`: `pkg/idl/<service>/ros2/<service>/msg/<Name>.msg`
- `srv`: `pkg/idl/<service>/ros2/<service>/srv/<Name>.srv`
- `dds_idl`: `pkg/idl/<service>/dds/<service>/<Name>.idl`

定义来源必须三选一：`--file <path>`、`--data <text>` 或 `--stdin`。
命令会做基础格式校验；创建后继续运行
`./pr gen:interfaces --service <service> --dry-run`。

例子：

```bash
# 新增一个普通导航服务
./pr create module navigation

# 新增 Python ROS2 驱动服务
./pr create module lidar-driver --ros2 python --ros2-version humble

# 新增 C++ ROS2 控制服务
./pr create module drive-control --ros2 cpp --ros2-version humble

# 新增 Go ROS2 sidecar
./pr create module brain-sidecar --ros2 go --ros2-version humble

# 新增跨模块共享契约包
./pr create pkg robot-contracts

# 删除模块。下面几种名字通常都能解析到同一个 module
./pr remove module navigation
./pr remove module navigation_service
./pr remove module module-navigation
```

## 接口生成

```bash
./pr gen:interfaces --service demo_action_service --dry-run
./pr gen:interfaces --service demo_action_service
./pr gen:interfaces --service module/service/demo_action_service --dry-run
./pr gen:interfaces --service demo-action --dry-run
```

`gen:interfaces` 从服务的 `config.yaml` 和公共 IDL 生成 module-local 接口脚手架、
registry、manifest，以及需要的公共 generated 层。

服务名可以写：

- `demo_action_service`
- `demo-action`
- `module/service/demo_action_service`

常用参数：

- `--service <name>` 指定服务。
- `--dry-run` 只打印接口 manifest，不写文件，推荐先跑。
- `--config <file>` 调试或迁移时手动指定 `config.yaml`。
- `--protocols <dir>` 调试或迁移时手动指定协议扫描目录，默认是 `pkg/idl`。
- `--force` 允许重置可编辑实现骨架；只有明确要覆盖时才用。

注意：

- 禁止手动编辑 `pkg/idl/**`。IDL 变更只能通过 Dashboard 页面或 `./pr data-format` 操作。
- 如果发现通信逻辑需要改 IDL，应记录问题并交给人类通过 Dashboard 或 `./pr data-format` 修改。
- 普通生成不会覆盖已经存在的业务实现骨架；`--force` 会改变这个保护边界。
- 如果生成器提示公共 `interfaces.yaml` 缺失，说明 provider route 可能还没在公共 IDL 中发布。

例子：

```bash
# 先看将生成什么
./pr gen:interfaces --service demo_action_service --dry-run

# 确认 manifest 正确后写入生成文件
./pr gen:interfaces --service demo_action_service

# 服务目录不是标准位置时显式指定路径
./pr gen:interfaces --service module/service/demo_action_service --dry-run

# 调试迁移时指定 config 和协议目录
./pr gen:interfaces \
  --service demo_action_service \
  --config module/service/demo_action_service/config.yaml \
  --protocols pkg/idl \
  --dry-run

# 仅在需要按最新配置重置脚手架时使用
./pr gen:interfaces --service demo_action_service --force
```

## Dashboard

```bash
./pr dashboard
./pr dashboard --daemon
./pr dashboard --no-open
./pr dashboard -- --turbo
./pr dashboard:db:save-image
./pr dashboard:db:start
./pr dashboard:db:push
```

说明：

- 默认启动 `dashboard/apps/web` 的 Next.js 开发服务。
- 默认地址是 `http://localhost:13630`。
- `--daemon` 后台运行，日志写到 `dashboard/tmp/dashboard.log`。
- `--no-open` 只启动服务，不自动打开浏览器。
- `-- <args>` 把后面的参数透传给 Next.js。
- `dashboard:db:*` 只管理 Dashboard 本地数据库；主仓库通信、模块构建、IDL 生成不依赖它。
- `dashboard:db:save-image` 会把 `postgres:17-alpine` 保存到 `image/postgres-17-alpine.tar`；`dashboard:db:start` 拉取失败时会自动尝试导入这个文件。
- IDL 修改入口应通过 Dashboard 页面或 `./pr data-format` 完成，不要直接编辑 `pkg/idl/**`。

例子：

```bash
# 前台启动，适合看实时日志
./pr dashboard

# 后台启动，适合长期使用
./pr dashboard --daemon

# 只启动服务，不打开浏览器
./pr dashboard --no-open

# 后台启动并透传 Next.js 参数
./pr dashboard --daemon -- --turbo

# Dashboard 需要登录/数据库功能时再启动本地 Postgres 并推送 schema
./pr dashboard:db:save-image
./pr dashboard:db:start
./pr dashboard:db:push
```

## 通信链路监控

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

`pr-monitor` 展示仓库中声明的 ROS2/NATS/CycloneDDS 通信 route，并在运行态可用时
采集真实指标。

数据来源：

- `pkg/idl/**/public/interfaces.yaml`
- `module/service/**/config.yaml`
- bridge YAML，例如 `module/service/<service>/bridge/nats/*.yaml`
- 本机进程表 `ps`
- Prometheus
- native CycloneDDS 采样，覆盖 `cyclonedds://` route
- ROS2 CLI，例如 topic/service list 和 topic hz/bw 采样

如果宿主机没有 CycloneDDS 开发环境，monitor 会通过
`scripts/ros2-docker.sh monitor-container` 拉起独立的
`pacific-rim-ros2-monitor-<distro>` 容器进行 native DDS 采样。DDS domain 会从
正在运行的 Docker 容器和 Linux `/proc/*/environ` 自动发现；需要手动指定扫描范围时
可用 `PR_MONITOR_ROS_DOMAIN_IDS=0,42`。

如果运行态来源没启动，频率、延迟、丢包等指标会显示 `---`，不是伪造 0 值。

常用选项：

- `-i <keyword>` 过滤 route。
- `--loc -x` 打开带预设面板的实时 TUI。
- `list` 等价于进程拓扑视图。
- `--list-routes` 只打印发现的 route，不启动 TUI。
- `--list-processes` / `--topology` 打印 vlink-list 风格的进程拓扑。
- `--prometheus-url <url>` 覆盖 Prometheus 地址。

快捷键：方向键移动，`Enter` 看详情，`i` 过滤，`Space` 暂停，`q` 退出。

例子：

```bash
# 只看 upperbody 相关链路
./pr monitor -i upperbody

# 打开实时面板，展示 detail/process/chart 等预设
./pr monitor --loc -x

# CI 或排查配置时，只打印静态路由
./pr monitor --list-routes

# 打印进程拓扑，并按关键字过滤
./pr monitor list -i upperbody

# Prometheus 跑在非默认地址
./pr monitor --prometheus-url http://localhost:9090
```

## ROS2 Docker

```bash
./pr ros2:build-image
./pr ros2:shell [--network <mode>] [--device <device>...] [--privileged]
./pr ros2:exec [--network <mode>] [--device <device>...] [--privileged] <command...>
./pr ros2:build --packages-select <ros_package_name>
./pr ros2:run <ros_package_name> [--device <device>...] [--network <mode>] [--privileged]
./pr ros2:run <ros_package_name> <executable> [--device <device>...] [--network <mode>] [--privileged]
./pr ros2:deploy --host <linux_host> --packages-select <ros_package_name> --domain-id <id>
```

说明：

- 本地 macOS 或非 ROS2 原生环境，优先用 Docker ROS2 环境。
- `<ros_package_name>` 是 `package.xml` 里的 `<name>`，不一定等于目录名。
- 默认 `ROS_DISTRO=humble`。
- 可用发行版：`humble`、`jazzy`、`kilted`、`lyrical`、`rolling`。
- 默认 `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`。
- `ENABLE_VISION_STACK=1` 启用通用视觉依赖；`VISION_TARGET=pc-nvidia|jetson|auto`
  会自动启用视觉依赖，并按目标增加 NVIDIA 构建/运行配置。`auto` 按架构映射：
  `amd64`/`x86_64` -> `pc-nvidia`，`arm64`/`aarch64` -> `jetson`。
- 不设置 `VISION_TARGET` 时构建普通 ROS2 镜像；`auto` 是显式 opt-in。
- 远端部署默认 `ROS_DOMAIN_ID=42`，可用 `--domain-id <id>` 覆盖。
- `ros2:deploy` 每次都会用当前工作区最新代码重新构建运行镜像，通过
  `docker save | ssh docker load` 推到远端，再重启同名容器。
- 部署镜像内部使用 `colcon build --packages-up-to <pkg>`，会一起构建工作区内目标 package 依赖。

例子：

```bash
# 第一次使用先构建 ROS2 镜像
./pr ros2:build-image

# 进入容器调试
./pr ros2:shell

# 查看 host network 里的 ROS2 节点/topic
./pr ros2:shell --network host
./pr ros2:exec --network host ros2 topic list

# 只构建一个 package
./pr ros2:build --packages-select smoke_test1

# 运行 package，executable 自动从 setup.py/CMakeLists.txt 推断
./pr ros2:run smoke_test1

# 显式指定 executable
./pr ros2:run smoke_test1 smoke_test1_node

# 运行时透传本机硬件设备
./pr ros2:run imu --device /dev/ttyUSB0

# 需要宿主机网络命名空间的硬件
./pr ros2:run imu imu_node \
  --network host \
  --privileged \
  --device /dev/ttyUSB0:/dev/ttyUSB0

# 通过 SSH 推送运行镜像到远端 Linux 并拉起容器
./pr ros2:deploy \
  --host 192.168.1.20 \
  --user jetson \
  --packages-select smoke_test1 \
  --domain-id 42

# 部署到 ARM64 远端，并传入硬件设备
./pr ros2:deploy \
  --host 192.168.1.20 \
  --user jetson \
  --platform linux/arm64 \
  --packages-select smoke_test1 \
  --domain-id 42 \
  --device /dev/ttyUSB0

# 构建普通 PC NVIDIA 视觉环境
VISION_TARGET=pc-nvidia ./pr ros2:build-image

# 构建 Jetson 视觉环境
VISION_TARGET=jetson ./pr ros2:build-image

# 按架构自动选择 pc-nvidia 或 jetson
VISION_TARGET=auto ./pr ros2:build-image

# 用相同 profile 构建 package
VISION_TARGET=auto ./pr ros2:build --packages-select smoke_test1

# 用远端架构自动选择 pc-nvidia 或 jetson 并部署
VISION_TARGET=auto ./pr ros2:deploy \
  --host 192.168.1.20 \
  --user jetson \
  --packages-select smoke_test1 \
  --domain-id 42

# dry-run 不连远端，需要显式给平台才能解析 auto
VISION_TARGET=auto ./pr ros2:deploy --dry-run \
  --platform linux/arm64 \
  --host 192.168.1.20 \
  --packages-select smoke_test1

# 切换 ROS2 发行版
ROS_DISTRO=jazzy ./pr ros2:build-image
ROS_DISTRO=jazzy ./pr ros2:shell
```

底层脚本还支持少量高级操作，通常只在调试容器或远端部署流程时使用：

```bash
scripts/ros2-docker.sh test [colcon args...]
scripts/ros2-docker.sh run <command...>
scripts/ros2-docker.sh deploy-image --host <ip-or-host> --packages-select <pkg> [--domain-id <id>] [options]
scripts/ros2-docker.sh deploy --host <ip-or-host> --remote-dir <dir> [--user <user>] [--port <port>] [--packages-select <pkg>]
```

例子：

```bash
# 在容器中直接跑 colcon test
scripts/ros2-docker.sh test --packages-select smoke_test1

# 在容器中执行任意 ROS2 命令
scripts/ros2-docker.sh run "ros2 topic list"

# 部署到远端机器并只构建一个 package
scripts/ros2-docker.sh deploy \
  --host 192.168.1.20 \
  --user jetson \
  --remote-dir /tmp/pacific-rim \
  --packages-select smoke_test1
```

## 观测栈

```bash
./pr observability:up
./pr observability:logs
./pr observability:down
```

说明：

- `observability:up` 启动 Grafana、Prometheus、Loki、Tempo、OTel Collector。
- `observability:logs` 跟随观测栈日志。
- `observability:down` 停止本地 ROS2/观测 compose 栈。

本地入口：

| 服务 | 地址 |
| --- | --- |
| Grafana | `http://localhost:16000` |
| Prometheus | `http://localhost:18180` |
| Loki | `http://localhost:6200` |
| Tempo | `http://localhost:6400` |
| OTLP HTTP | `http://localhost:8636` |
| OTLP gRPC | `localhost:8634` |

例子：

```bash
# 启动观测平台
./pr observability:up

# 查看采集器、Grafana、Prometheus 等日志
./pr observability:logs

# pr-monitor 指向本地 Prometheus
./pr monitor --prometheus-url http://localhost:18180

# 停止观测平台
./pr observability:down
```
