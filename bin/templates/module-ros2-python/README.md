# module-{{name}}

{{title}} ROS2 Python module.

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

Communication bootstrap is already wired in `{{packageName}}/node.py`. Add
consumer routes under `config/config.yaml -> communication.services/topics`; provider routes under `pkg/idl/<service>/public/interfaces.yaml`.
Run the interface scaffold for provider-side `rpc_server(...)` handlers and
publisher helpers. Subscriber routes and downstream service calls stay in
business code and can use `subscriber(...)` or `rpc_client(...)` explicitly.
Use `self.run_communication(...)` from synchronous ROS callbacks when calling
async publish/request/subscribe methods.

Public IDL lives under `pkg/idl/{{name}}/{pb,ros2,public}` by default. If a route
intentionally reuses another service's public IDL, set `idl_service` on that
route in `config/config.yaml`.

Routes choose only `data` (`msg`, `srv`, or `proto`) plus `middleware` (`nats`,
`cyclonedds`, or `ros2`) and optional QoS. The communication runtime expands
that contract to native CycloneDDS, RMW CycloneDDS, ROS2 protobuf envelope, or
native ROSIDL as needed; business code should not configure transport buses,
RMW standards, bridge modes, or adapters directly.
