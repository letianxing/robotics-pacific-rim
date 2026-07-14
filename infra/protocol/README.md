# infra-protocol

Transport-neutral protocol helpers shared by runtime modules and adapters.

This package is the lowest-level shared boundary. Other `infra/*` projects may
depend on it, but it should avoid dependencies on higher-level packages.

## Responsibilities

- Common codec interfaces and base codecs.
- Shared serialization/deserialization helpers, including common message
  envelope JSON codecs.
- Shared data-format descriptors for protobuf, ROS2 `.msg`, ROS2 `.srv`, ROS2
  IDL, and ROS2 type-support packages.
- Shared wire-encoding descriptors such as CDR. CDR is not an IDL or generated
  `.cc` source format; it is a serialized payload encoding used by DDS/ROS2
  transports.
- Future shared JSON Schema, FlatBuffers, and ROS2 type-support
  serialization helpers.

It does not own NATS, DDS, ROS2, HTTP, gRPC, or any other middleware runtime.
Those live under `infra/communication`.

## Current Layout

```text
cpp/include/pacific_rim/protocol/codec.hpp
cpp/include/pacific_rim/protocol/encodings/
cpp/include/pacific_rim/protocol/formats/
go/codec
go/codec/encodings
go/codec/formats
python/pacific_rim_protocol/codec.py
python/pacific_rim_protocol/encodings/
python/pacific_rim_protocol/envelope.py
python/pacific_rim_protocol/formats/
```

`formats/` is split by format family:

- `base`: common `DataFormat`, `DataFormatKind`, and content-type lookup.
- `protobuf`: protobuf descriptors and future protobuf-specific helpers.
- `ros2`: ROS2 `.msg`, `.srv`, IDL, and type-support descriptors.

`encodings/` is split from `formats/` because encodings describe how a payload
is serialized on the wire, not what source contract defines the data. `cdr`
lives there.

The old `formats/cdr` helpers remain only as compatibility shims that return a
raw-bytes data format annotated with `encoding=cdr`. New code should use the
`encodings/cdr` helpers and keep the source contract in protobuf, ROS2 `.msg`,
ROS2 `.srv`, ROS2 IDL, or ROS2 type-support descriptors. Generated `.cc`, `.py`,
`.go`, or other language files are artifacts derived from those source
contracts, not first-class IDL sources.

## Ownership Boundary

Public business schemas belong in `pkg/idl/<service>/{pb,ros2}` so upstream and
downstream modules can inspect one shared contract location. For example,
action-service keeps public `.msg`, `.srv`, and protobuf IDL under
`pkg/idl/action_service`, while action-service-specific field mappers stay under
`module/service/action_service/src/api`.

Use `infra/protocol` for the reusable mechanics around those schemas:

- raw bytes, JSON, protobuf codecs;
- common envelope codecs;
- format/type descriptors such as `action_service/srv/PlayAction` or
  `std_msgs/msg/String`;
- encoding descriptors such as CDR;
- future ROS2 CDR/type-support serializers that are independent of any one
  business module.

Do not put action names, scheduler policy, field mapping, or module-owned
request/response semantics here.
