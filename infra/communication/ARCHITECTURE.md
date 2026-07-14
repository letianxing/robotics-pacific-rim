# infra-communication architecture

`infra/communication` owns reusable middleware communication implementations
for modules. It provides a small public surface:

- `MessageBus`: publish/subscribe and optional request/reply over bytes.
- `TypedMessageBus`: temporary typed helper over a `MessageBus`.
- `FanoutBus` / `FanoutMessageBus`: publish/subscribe over multiple buses.
- `CommunicationFabric`: config-bound middleware and route lookup.
- NATS and CycloneDDS concrete adapters.
- ROS2/NATS bridge runtime for compatibility with migrated ROS2 services.
- C++ ROS2 dual-domain runtime and serialized topic relay for modules that need
  native ROS domain compatibility bridges.

## Current Capability Matrix

| Capability | Python | Go | C++ |
| --- | --- | --- | --- |
| Core bus API | yes | yes | yes |
| Fanout bus | yes | yes | yes |
| NATS pub/sub | yes | adapter interface | adapter interface |
| NATS request/reply | yes | adapter interface | adapter interface |
| CycloneDDS pub/sub | yes | adapter interface | adapter interface |
| ROS2/NATS bridge runtime | yes | no | no |
| ROS2 domain runtime/topic relay | no | no | yes |
| Config `communication.middleware/topics/services` | yes | yes | manual parse by service |
| Multi-binding `bindings` expansion | yes | yes | manual parse by service |

“Adapter interface” means infra provides the common bus wrapper and byte-client
interface. A concrete SDK client is injected by the service or a lower-level
adapter.

## Directory Policy

Only directories with implemented code should exist:

```text
cpp/core
cpp/dds
cpp/nats
cpp/ros2/domain_bridge
go/core
go/dds
go/nats
python/pacific_rim_communication_infra/core
python/pacific_rim_communication_infra/dds
python/pacific_rim_communication_infra/nats
python/pacific_rim_communication_infra/ros2
```

Do not create placeholder directories for MQTT, Zenoh, HTTP, gRPC, TCP, UDP,
QUIC, AimRT, or CyberRT. Add them when the backend has a real `MessageBus`
implementation or bridge runtime.

## Protocol Boundary

Message definition and serialization are adjacent but separate concerns:

- `infra/communication`: transport, connection, route binding, fanout, bridge
  runtime.
- `infra/protocol`: shared codec interfaces/base codecs, and future home for
  shared IDL, protobuf, JSON Schema, FlatBuffers, CDR, and common
  serialization/deserialization logic.
- `module/*/protocols`: module-owned data structures and ROS/protobuf schemas.

Communication must not own codec implementations. Codec and envelope
serialization live in `infra/protocol`; communication imports them only when a
runtime needs typed helpers.

## Route Policy

Single middleware route:

```yaml
communication:
  topics:
    robot_state:
      transport: nats_topic
      middleware: action_nats
      subject: robot.state
```

Multiple middleware bindings:

```yaml
communication:
  topics:
    robot_state:
      message_type: pacific_rim.motion.RobotState
      bindings:
        - transport: ros2_topic
          topic: /robot/state
        - transport: nats_topic
          middleware: action_nats
          subject: robot.state
        - transport: cyclonedds_topic
          middleware: motion_dds
          topic: RobotState
```

Business mapper code and subject ownership stay in the owning module. Generic
bridge mechanics stay here.

For ROS2 domain bridges, keep context/node/executor lifecycle and serialized
topic relay in `cpp/ros2/domain_bridge`. Module-specific domain IDs, topic
allowlists, typed service bridges, and service names stay in the owning module
until a generic ROS2 service type-support plug-in layer exists.
