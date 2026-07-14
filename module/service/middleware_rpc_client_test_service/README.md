# module-middleware_rpc_client_test_service

Middleware Rpc Client Test ROS2 C++ module.

Generated package:

- ROS2 distro: `humble`
- ROS2 package: `middleware_rpc_client_test`
- Node executable: `middleware_rpc_client_test_node`
- Communication config: `config/config.yaml`

Typical local commands:

```bash
source /opt/ros/humble/setup.bash
colcon build --packages-select middleware_rpc_client_test
source install/setup.bash
ros2 run middleware_rpc_client_test middleware_rpc_client_test_node
```

The generated config follows the shared `communication.middleware/services/topics`
shape. `src/node.cpp` automatically registers the C++ infra NATS and
CycloneDDS backends and bootstraps `config/config.yaml` through
`infra/communication/cpp/core/bootstrap.hpp`. Keep consumer route bindings in config; provider routes live in public IDL
and business behavior in API handlers/services.

Public IDL lives under `pkg/idl/middleware_rpc_client_test_service/{pb,ros2,public}` by default. If a route
intentionally reuses another service's public IDL, set `idl_service` on that
route in `config/config.yaml`.

`protobuf message` may be used as a topic payload over NATS or CycloneDDS byte
transport. `protobuf request/response` contracts are transport-neutral: they may
be carried by `nats_rpc` or by `cyclonedds_rpc` with
`standard: omg_dds_rpc|rmw_cyclonedds`; the adapter lives in
`infra/communication/dds`.
