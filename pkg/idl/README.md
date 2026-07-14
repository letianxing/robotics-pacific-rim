# pkg-idl

Public interface contracts shared by Pacific-Rim modules.

Put schemas here when another module, an upstream system, or a downstream system
needs to reference the API, message, service, or data format. Module repositories
consume these contracts through `config.yaml` type names such as
`demo_action/srv/PlanAction`, `demo_action/msg/RobotState`, or
`smoke_001/msg/SmokeStatus`.

Ownership rules:

- `pkg/idl` owns public `.proto`, ROS2 `.msg`, ROS2 `.srv`, public interface
  manifests, and future IDL-like source definitions.
- `module/*` must not own cross-module public protocol definitions. A module may
  keep a private schema only when it is not referenced outside that module.
- Generated language artifacts such as C++, Python, Go, or ROS2 type-support
  files are build outputs. Do not commit them as source contracts here.
- Serialization, deserialization, codec registries, and wire-format runtime
  helpers belong in `infra/protocol`.
- Middleware bootstrap, clients, fabric, route lookup, and bridge runtimes
  belong in `infra/communication`.

Layout:

- `<service>/ros2/msg/*.msg`: public ROS2 streaming messages.
- `<service>/ros2/srv/*.srv`: public ROS2 request/response services.
- `<service>/pb/*.proto`: public protobuf schemas and RPC service definitions.
- `<service>/public/*.yaml`: public interface manifests that can expose shared
  topics and shared services using the public message/service types above.

The old `<service>/ros2/<ros2_package>/msg|srv` layout is still readable for
existing IDL. New files should use the flat `ros2/msg` and `ros2/srv` folders.

The first directory level is always the service or shared domain name, such as
`demo_action_service`, `smoke_001_service`, or a generated middleware test
service. The second level is the IDL format, such as `ros2`, `pb`, or `dds_idl`.

HTTP, WebSocket, REST, JSON-RPC, SSE, and OpenAPI endpoint descriptions stay in
the owning module implementation or module documentation. If those transports
share a stable payload shape with other services, put the payload schema in
`pb/*.proto`; do not add transport-specific folders under `pkg/idl`.

Public interfaces are contracts, not only runtime config. When a module exposes
a topic or service for another service, upstream system, or downstream system
to consume, declare it under `<service>/public/interfaces.yaml` next to the
referenced message or service type:

```yaml
topics:
  robot_state:
    payload:
      format: ros2_msg
      type: demo_action/msg/RobotState
    bindings:
      - transport: ros2_topic
        direction: publish
        topic: /demo_action/robot_state
```

services:
  play_action:
    contract:
      format: ros2_srv
      type: demo_action/srv/PlayAction
    bindings:
      - transport: ros2_service
        service: /demo_action/play_action
      - transport: nats_rpc
        subject: robot.rpc.demo_action.play_action
```

Module `config.yaml` should reference public topics with `topic_ref` and public
services with `service_ref`. Keep runtime-only details such as middleware,
remaps, queue sizes, QoS, queue groups, timeouts, and deployment-specific
binding overrides locally. If no override is needed, do not repeat the public
address or payload/contract type:

```yaml
communication:
  topics:
    robot_state:
      topic_ref: demo_action_service.robot_state
      bindings:
        - transport: ros2_topic
          middleware: local_ros2
  services:
    play_action:
      service_ref: demo_action_service.play_action
      queue_group: demo_action_service
```

Private in-process, module-local, or internal system topics should stay out of
`pkg/idl`; define those directly in the owning module `config.yaml` with their
own `message_type` or `payload` and bindings.

See `Docs/new_module_pr_workflow.md` for the full config matrix covering
ROS2 msg, protobuf message, ROS2 srv, protobuf rpc, public topics, public
services, private routes, scaffold commands, and deployment flow.

Keep ROS2 package names stable when moving files into `pkg/idl`. For example,
a service may live under `pkg/idl/demo_action_service` while its ROS2 package
still generates as `demo_action/msg/...` and `demo_action/srv/...`; only the
source-file ownership changes.
