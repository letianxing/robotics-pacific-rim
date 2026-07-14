# infra

Shared adapters and runtime libraries for the robotics platform.

Packages in this directory should stay domain-agnostic and reusable across
modules, deployment tooling, examples, and future language bindings, but may
bind to concrete runtime systems such as NATS, ROS2, CycloneDDS, Zenoh, gRPC,
MQTT, OpenTelemetry, or executors.

Rules:

- A `infra/*` project may depend on another `infra/*` project or a pure
  `pkg/*` contract project.
- A `infra/*` project must not depend on `module/*`, `deploy/*`, or `example/*`.
- Pure contracts and value objects belong in `pkg/*`; concrete adapters and
  runtime interfaces belong here before modules depend on them.
