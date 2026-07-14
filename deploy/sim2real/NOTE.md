# Sim2real + 运控层 上手 NOTE

这套程序从 `pacific-rim` 迁移到本仓库（pr 脚手架布局），可在 **本地直接构建运行，无需 Docker**。
下面是从零开机到机器人动起来的完整流程。

---

## 0. 一次性环境

- ROS2 **humble**（`/opt/ros/humble`）。
- 构建必须用 **系统 Python 3.10**（`/usr/bin/python3`），不能用 conda 的 3.13（缺 `em`/`lark`/`catkin_pkg`，rosidl 会失败）。
  下面所有脚本已自动设置干净 PATH 并 `unset` conda 变量，照着跑即可。

迁移后各包的位置（pr 约定布局，和源 `pacific-rim` 不同）：

| 包 | 位置 | 作用 |
|---|---|---|
| `lhframework_interfaces` | `pkg/idl/motion_control_sim2real_service/ros2/` | sim2real 服务接口（srv） |
| `yesense_interface` | `pkg/idl/motion_control_sim2real_service/ros2/` | IMU 消息（msg） |
| `serial` | `pkg/driver/sensor/serial` | 串口驱动库（临时迁移形态） |
| `yesense_std_ros2` | `pkg/driver/sensor/yesense/` | IMU 驱动节点（后续会替换为 IMU service 协议适配） |
| `khcan_native` | `pkg/driver/motor/khcan_native` | 电机 CAN 驱动（当前被 lhframework_hw 直接编译，后续会替换为 motor service 协议适配） |
| `lhframework_hw` | `module/service/motion_control_sim2real_service/src/plugins/ros2_plugin/` | 硬件层节点 |
| `lhframework_ros` | 同上 | 策略/控制/runner 节点（runtime/core 静态库） |
| `motion_control_padding` | `module/service/motion_control_padding_service` | PI 速度补偿（`velocity_pi_compensator`） |

---

## 1. 构建（一条命令，全部运行包）

```bash
bash deploy/sim2real/scripts/build-runtime.sh
```

- 产物：merge-install 到 `.ros_local_ws/install/`，运行脚本统一 source 这一个 `setup.bash`。
- 原理：用 `--base-paths` 指向**真实**包目录（非符号链接），各包的相对路径（khcan / runtime/core / infra）自动正确解析，无需任何 `-D` 覆盖。
- 改了参数 / 代码后重跑这条命令即可（增量构建）。

> 单独只构建 sim2real 那 4 个包时也可用 `module/service/motion_control_sim2real_service/tools/build-local.sh`，
> 但**日常统一用上面的 `build-runtime.sh`**（它含运控层 + IMU/串口驱动，输出统一 install）。

### 关于 ONNX Runtime（策略推理）
构建时 onnxruntime 是**可选**的：缺了也能编过，但策略推理会被禁用（机器人不会按策略走）。
要启用推理，构建前指定一个 onnxruntime 安装目录：

```bash
ONNXRUNTIME_ROOT=/path/to/onnxruntime/current \
  bash deploy/sim2real/scripts/build-runtime.sh
```

（或把该目录迁进本仓库 `third_party/onnxruntime/current` 后直接构建。）

---

## 2. 硬件上电：拉起电机 CAN

```bash
bash deploy/sim2real/scripts/bringup-motor-can.sh lower   # can2 can3 can6
bash deploy/sim2real/scripts/bringup-motor-can.sh upper   # can5 can7 + CAN-FD can4
# 或直接指定：bash deploy/sim2real/scripts/bringup-motor-can.sh can2 can3 ...
```

需要 `sudo`（脚本内部用 `ip link`）。每次重新上电后做一次。

---

## 3. 启动（两层，分两个终端）

设计上分两层，**下层常驻、上层可随意重启调参**，互不打扰平衡策略。

### 终端 A — 第 1 层（底层：sim2real 策略 + cmd_vel_mux auto，常驻）
```bash
bash deploy/sim2real/scripts/start-sim2real-layer.sh
```
- 起 lhframework 硬件/策略/IMU/速度估计，做 IMU、速度自检。
- 会有一个**安全确认**：机器人架好或周围净空、急停就绪后，按回车才开始策略推理。
- 起来后保持这个终端不动。

### 终端 B — 第 2 层（motion-control padding：PI 速度补偿器，可反复重启）
```bash
bash deploy/sim2real/scripts/start-motion-control-layer.sh
```
- 起 `motion_control_padding` 的 `velocity_pi_compensator`：闭环 `/cmd_vel_vision`（期望）
  + `/robot/velocity_estimate`（反馈）→ PI 校正 → `/cmd_vel_auto`（给底层 mux）。
- 改了 `module/service/motion_control_padding_service/config/params.yaml` 后，Ctrl-C 再跑这条即可热重载，不影响第 1 层。
- 脚本会打印 **PI 调参速查**（起步慢加 `vx_kp`、稳态差加 `vx_ki`、抖/过冲降 `vx_kp`）。
- 状态话题：`/motion_control_padding/velocity_pi_compensator/status`。

### 看状态
```bash
bash deploy/sim2real/scripts/show-status.sh
```

---

## 4. 调参位置

- motion-control padding（PI 速度补偿）：`module/service/motion_control_padding_service/config/params.yaml`
  - 运行中临时改：`ros2 param set /velocity_pi_compensator <name> <value>`（如 `vx_kp` / `vx_ki` / `wz_kp` / `wz_ki`）
- 说明文档：`module/service/motion_control_padding_service/README.md`
- sim2real 硬件 / runtime 配置：由 `start-sim2real-layer.sh` 里的
  `hw_params_file` / `runtime_config_file` 指定（指向 lhframework_hw / lhframework_ros 的 share/config）。

---

## 5. 已知缺口 / TODO

- 运控层采用 **`motion-control-padding`**（PI 速度补偿）。源仓库另有一个非 padding 版
  `module/motion-control`（`velocity_compensator` + 路径规划 + odom），**未迁入**本仓库；
  对应的 `start-path-planning-mode.sh`（路径规划一体模式）也随之移除。若以后需要路径规划，
  再单独迁 / 适配。
- [ ] **ONNX Runtime** 未迁入本仓库 `third_party/`；要跑真实策略推理需按 §1 指定 `ONNXRUNTIME_ROOT` 或迁移该目录。
- [ ] 电机库和 IMU 库后续会拆成独立 service；届时 `motion_control_sim2real_service` 需要移除对 driver 库/节点的直接依赖，改为通过通讯协议适配。
- [ ] `project.json` 的 `build` target 仍写的是 docker 路径（`scripts/ros2-docker.sh`）；本地构建以本 NOTE 的 `build-runtime.sh` 为准，docker 以后再说。
- [ ] 安全：`module/service/robo_brain_service/config.yaml` 内硬编码的 OpenAI API key 需轮换（与本运控层无关，顺带记一笔）。
