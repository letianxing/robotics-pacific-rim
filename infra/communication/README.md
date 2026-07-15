# infra-communication

Concrete communication adapters for robot services.

`infra/communication` owns communication contracts and binds them to real
middleware runtimes. It owns middleware buses, connection handling,
routing/fabric helpers, fanout, bootstrap, and compatibility bridge runtimes.

It does not own business schemas, action names, protobuf files, IDL files, or
field mappers. Public cross-module IDL lives in
`pkg/idl/<service>/{pb,ros2}`; serialization mechanics live in `infra/protocol`.

## Current Scope

The implemented communication middleware scope is intentionally limited. Use
only these high-level route middleware values in module `config.yaml` files:

| Middleware | Status | Notes |
| --- | --- | --- |
| `nats` | Implemented | Pub/sub and request/reply byte transport. |
| `ros2` | Implemented | Native ROSIDL routes and protobuf envelope routes. Go native ROS2 requires the `pacific_rim_ros2_rclgo` build tag or explicit rosbridge fallback. |
| `cyclonedds` | Implemented, partial by data path | Native byte-envelope/protobuf paths exist; ROSIDL `msg|srv` routes use the ROS2 RMW CycloneDDS path internally. |
| `fastdds` | Implemented, partial by data path | Native byte-envelope/protobuf paths exist; ROSIDL `msg|srv` routes use the ROS2 RMW Fast DDS path internally. Go native Fast DDS requires the `pacific_rim_fastdds` build tag. |
| `zenoh` | Not implemented | Reserved for future extension only. |
| `grpc` | Not implemented | Reserved for future extension only. |
| `mqtt` | Not implemented | Reserved for future extension only. |
| `aimrt`, `cyberrt`, `http`, `tcp`, `udp`, `quic` | Not implemented | Add only with a real `MessageBus` implementation or bridge runtime. |

Some language contracts contain enum values for future middleware families.
Those names do not mean the middleware is supported by themselves. A middleware
is considered usable only when this package contains a real bus implementation,
route binding, connection handling, and tests for the route shape.

## Implemented Backends

- `python/pacific_rim_communication_infra/core`: `MessageBus`,
  `TypedMessageBus`, `FanoutMessageBus`, config/fabric helpers, and service
  bootstrap.
- `python/pacific_rim_communication_infra/nats`: NATS publish/subscribe and
  request/reply adapter.
- `python/pacific_rim_communication_infra/dds`: CycloneDDS publish/subscribe
  adapter using the optional `cyclonedds` Python binding and a byte envelope.
- `python/pacific_rim_communication_infra/ros2`: generic ROS2/NATS bridge
  runtime, protobuf byte-envelope `MessageBus`, and config compatibility
  helpers.
- `go/core`: `MessageBus`, registry/fabric, `FanoutBus`, service communication
  config parser.
- `go/nats`: NATS byte-client adapter behind `core.MessageBus`.
- `go/dds`: CycloneDDS byte-client adapter behind `core.MessageBus`. The
  `pacific_rim_cyclonedds` build tag links native in-process `libddsc`; the
  default build fails fast when a CycloneDDS route is used.
- `cpp/core`: `MessageBus`, registry, `FanoutBus`, config bootstrap, and
  fabric route lookup.
- `cpp/nats`: C++ NATS bus adapter plus a native byte client for publish,
  subscribe, and request/reply.
- `cpp/dds`: C++ CycloneDDS bus adapter. The default C++ bootstrap currently
  registers the serialized ROS2 generic publisher/subscription client, so DDS
  traffic is handled by the configured ROS2 RMW while business modules still
  bind routes through `config.yaml`. Fully native C++ bytes/protobuf over
  CycloneDDS should be added as a type-support adapter here, not in modules.
- `cpp/ros2/proto_envelope_bus.hpp`: native `rclcpp` MessageBus for
  `adapter: ros2_proto_envelope`, using `common/msg/ProtoEnvelope` for topics
  and `common/srv/ProtoCall` for request/reply.
- `cpp/ros2/domain_bridge`: reusable ROS2 dual-domain runtime and serialized
  topic relay. Modules still own route allowlists, service type bindings, and
  business handlers.

Do not create empty backend directories for unimplemented middleware. Add
`mqtt`, `zenoh`, `grpc`, `http`, `aimrt`, or other backends only when they have
a real `MessageBus` implementation or bridge runtime.

## Layering

```text
module/*
  service-specific routes, executable processes, launch files, mappers

infra/communication
  middleware adapters, bus API, fanout, routing, bridge runtimes

infra/protocol
  shared codec interfaces, base codecs, protobuf/json-schema/flatbuffers
  helpers, ROS2 type descriptors, and wire encodings such as CDR

pkg/idl
  public cross-module .proto, .msg, .srv, and IDL source contracts
```

Serialization/deserialization implementations belong under `infra/protocol`;
communication should carry bytes and bind routes to middleware.

## User-Facing API

Python:

```python
from pacific_rim_communication_infra import bootstrap_communication

runtime = await bootstrap_communication("config/config.yaml")
endpoint = runtime.publisher("robot_state")
await endpoint.bus.publish_bytes(endpoint.channel, payload)
```

Go:

```go
runtime, err := commcore.BootstrapCommunication(ctx, "config/config.yaml", "foo-service")
defer runtime.Close(context.Background())

endpoint, err := runtime.Fabric.RPCClient("do_foo")
```

C++:

```cpp
auto runtime = pacific_rim::communication::core::BootstrapCommunication(
    "config/config.yaml",
    "foo-service");
auto endpoint = runtime.Publisher("robot_state");
endpoint.bus->Publish(endpoint.channel, payload);
```

For new module onboarding, generated files, language bootstrap behavior, and
route configuration examples, see `doc/new_module_pr_workflow.md`.

## Route Config

Business modules configure only the payload data format, the middleware protocol,
route addresses, and optional QoS. They should not configure transport buses,
adapters, RMW implementations, bridge modes, or middleware implementation names.
At the module route level, supported middleware values are currently `nats`,
`ros2`, `cyclonedds`, and `fastdds`.

```yaml
communication:
  topics:
    robot_state:
      data: proto
      type: pacific_rim.demo.RobotState
      middleware: ros2
      topic: /demo/robot_state
      qos:
        reliability: best_effort
        deadline_ms: 50

    joint_state:
      data: msg
      type: sensor_msgs/msg/JointState
      middleware: cyclonedds
      topic: JointState
      qos:
        depth: 5

    fast_state:
      data: proto
      type: pacific_rim.demo.FastState
      middleware: fastdds
      topic: /demo/fast_state

  services:
    plan_action:
      data: proto
      type: demo.Planner/Plan
      middleware: nats
      service: /demo/plan_action
```

The parser flattens nested QoS to `qos.*` metadata, and `queue_size` is mirrored
to `qos.depth` when no explicit depth is set. Current shared fields are
`reliability`, `durability`, `history`, `depth`, `deadline_ms`, `lifespan_ms`,
`liveliness`, and `liveliness_lease_duration_ms`.

`message_type`, `payload.type`, and `contract.type` describe the business
schema (`.msg`, `.srv`, protobuf, or OMG DDS IDL). CycloneDDS/FastDDS
middleware `type_name` describes
the byte-envelope DDS transport type. Do not use `type_name` for business
schema names unless a language-specific native type-support adapter is
registered for that exact DDS type.

## Internal Execution Plan

The communication compiler/runtime expands the high-level route to the fastest
compatible implementation:

- `middleware: cyclonedds` with `data: msg|srv` uses the ROS2 RMW CycloneDDS
  wire path internally. It is still treated as the CycloneDDS middleware family.
- `middleware: cyclonedds` with `data: proto` uses the native CycloneDDS
  byte-envelope/RPC path.
- `middleware: fastdds` with `data: proto` uses the native Fast DDS
  byte-envelope/RPC path.
- `middleware: cyclonedds|fastdds` with `data: dds_idl` or `data: omg_idl`
  prefers typed native DDS when generated TypeSupport is registered, and falls
  back to the stable byte-envelope path otherwise. Use bounded IDL fields for
  future loan/shared-memory optimization.
- `middleware: fastdds` with `data: msg|srv` uses the ROS2 RMW Fast DDS path
  (`rmw_fastrtps_cpp`) internally so ROSIDL message/service semantics stay
  intact.
- `middleware: ros2` with `data: proto` uses the ROS2 protobuf envelope
  internally.
- `middleware: ros2` with `data: msg|srv` stays on native ROSIDL types and does
  not add a protobuf parse/envelope layer.

User-facing route config should use only `fastdds` or `cyclonedds` for those
families. Internal runtime metadata records the selected implementation
(`native_*`, `rmw_cyclonedds`, or `rmw_fastrtps`) so generated code and business
logic do not need to know the split. Explicit runtime aliases such as
`fastdds_rmw`, `fastdds_native`, `cyclonedds_rmw`, and `cyclonedds_native` are
not valid route middleware values.

For any ROS2/DDS-family transport, set the same domain on every participant
that must communicate. Use `domain_id` in middleware options/config; the alias
`ros_domain_id` is accepted and normalized to the same setting. If neither is
set, the runtime uses `ROS_DOMAIN_ID` where the backend supports it, otherwise
domain `0`.

Go ROS2 bridge/native selection is a build/deployment concern behind the same
route contract. Business code still edits only `config.yaml` routes and
`pkg/idl/public/interfaces.yaml`.

Native Fast DDS runtime support is implemented for C++, Python, and Go. The C++
backend uses the Fast DDS C++ API directly; Python loads a small ctypes shim;
Go uses a cgo shim behind the `pacific_rim_fastdds` build tag. Without that tag,
Go keeps a clear stub error for native Fast DDS and can still use the RMW path
for ROSIDL `msg|srv` routes.

For Go services, native ROS2 support is compiled into the service binary with
the `pacific_rim_ros2_rclgo` build tag. When that tag is present, the ROS2
backend registers an in-process rclgo bus and `middleware: ros2` routes use it
directly. This is a service image/binary build choice, not a PR command option.

If the binary does not include the native backend, deployments may explicitly
enable rosbridge fallback with `PACIFIC_RIM_ROS2_BRIDGE=true` and
`PACIFIC_RIM_ROS2_BRIDGE_URL=ws://<host>:9090`. The Go ROS2 bus then speaks the
rosbridge WebSocket protocol (`advertise`, `publish`, `subscribe`,
`call_service`, and `service_response`) against the configured ROS2 graph.
Without either native backend or rosbridge fallback, startup fails with a clear
error.

NATS/ROS2 bridging is a separate path for routes whose middleware is NATS and
whose deployment explicitly starts `nats_ros2_bridge_node`. It is not used as an
implicit fallback for `middleware: ros2`.
