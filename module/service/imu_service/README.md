# module-imu_service

Pure ROS2 C++ driver sample module.

Generated package:

- ROS2 distro: `humble`
- ROS2 package: `imu`
- Node executable: `imu_node`
- Communication config: `config/config.yaml`

Typical local commands:

```bash
source /opt/ros/humble/setup.bash
colcon build --packages-select imu
source install/setup.bash
ros2 run imu imu_node
```

This module is intentionally minimal for the pure PR test repository. It keeps
the service shape, launch file, config file, package manifest, and public IDL
sample, but it does not contain hardware access, driver adapters, or IMU
publishing business logic.

The generated config follows the shared `communication.middleware/services/topics`
shape. Keep consumer route bindings in config; provider routes live in public
IDL and business behavior should be added under `src/service` only when this
sample is expanded into a real service.

Public IDL lives under `pkg/idl/imu_service/{pb,ros2,public}` by default. If a route
intentionally reuses another service's public IDL, set `idl_service` on that
route in `config/config.yaml`.

Routes choose only `data` (`msg`, `srv`, or `proto`) plus `middleware` (`nats`,
`cyclonedds`, or `ros2`) and optional QoS. The communication runtime expands
that contract to native CycloneDDS, RMW CycloneDDS, ROS2 protobuf envelope, or
native ROSIDL as needed; business code should not configure transport buses,
RMW standards, bridge modes, or adapters directly.
