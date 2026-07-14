# module-{{name}}

{{title}} ROS2 C++ module.

Generated package:

- ROS2 distro: `{{rosDistro}}`
- ROS2 package: `{{packageName}}`
- Node executable: `{{executableName}}`
- Communication config: `config/config.yaml`

Typical local commands:

```bash
source /opt/ros/{{rosDistro}}/setup.bash
colcon build --packages-select {{packageName}}
source install/setup.bash
ros2 run {{packageName}} {{executableName}}
```

The generated config follows the shared `communication.middleware/services/topics`
shape. `src/node.cpp` automatically registers the C++ infra NATS and
CycloneDDS backends and bootstraps `config/config.yaml` through
`infra/communication/cpp/core/bootstrap.hpp`. Keep consumer route bindings in config; provider routes live in public IDL
and business behavior in API handlers/services.

Public IDL lives under `pkg/idl/{{name}}/{pb,ros2,public}` by default. If a route
intentionally reuses another service's public IDL, set `idl_service` on that
route in `config/config.yaml`.

Routes choose only `data` (`msg`, `srv`, or `proto`) plus `middleware` (`nats`,
`cyclonedds`, or `ros2`) and optional QoS. The communication runtime expands
that contract to native CycloneDDS, RMW CycloneDDS, ROS2 protobuf envelope, or
native ROSIDL as needed; business code should not configure transport buses,
RMW standards, bridge modes, or adapters directly.
