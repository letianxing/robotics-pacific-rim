# module-middleware_sub_test_service

Middleware Sub Test ROS2 Python module.

Generated package:

- ROS2 distro: `humble`
- ROS2 package: `middleware_sub_test`
- Node executable: `middleware_sub_test_node`
- Communication config: `config/config.yaml`

Typical local commands:

```bash
source /opt/ros/humble/setup.bash
colcon build --packages-select middleware_sub_test
source install/setup.bash
ros2 run middleware_sub_test middleware_sub_test_node
```

Communication bootstrap is already wired in `middleware_sub_test/node.py`. Add
consumer routes under `config/config.yaml -> communication.services/topics`; provider routes under `pkg/idl/<service>/public/interfaces.yaml`.
Run the interface scaffold for provider-side `rpc_server(...)` handlers and
publisher helpers. Subscriber routes and downstream service calls stay in
business code and can use `subscriber(...)` or `rpc_client(...)` explicitly.
Use `self.run_communication(...)` from synchronous ROS callbacks when calling
async publish/request/subscribe methods.

Public IDL lives under `pkg/idl/middleware_sub_test_service/{pb,ros2,public}` by default. If a route
intentionally reuses another service's public IDL, set `idl_service` on that
route in `config/config.yaml`.

`protobuf message` may be used as a topic payload over NATS or CycloneDDS byte
transport. `protobuf request/response` contracts are transport-neutral: they may
be carried by `nats_rpc` or by `cyclonedds_rpc` with
`standard: omg_dds_rpc|rmw_cyclonedds`; the adapter lives in
`infra/communication/dds`.
