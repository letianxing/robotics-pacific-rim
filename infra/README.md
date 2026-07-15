# infra

Shared adapters and runtime libraries for the robotics platform.

Packages in this directory should stay domain-agnostic and reusable across
modules, deployment tooling, examples, and future language bindings, but may
bind to concrete runtime systems.

Current runtime coverage is intentionally partial:

- `infra/communication` currently implements NATS, ROS2, CycloneDDS, and Fast DDS
  paths, with language-specific coverage documented in
  `infra/communication/README.md`.
- Zenoh, gRPC, MQTT, AimRT, CyberRT, and similar transports are not implemented
  communication backends in this repository yet, even if some enum/contract names
  are reserved for future extension.
- Telemetry and execution support live in their own packages such as `infra/otel`,
  `infra/trace`, `infra/metric`, `infra/log`, and `infra/runtime`.

Rules:

- A `infra/*` project may depend on another `infra/*` project or a pure
  `pkg/*` contract project.
- A `infra/*` project must not depend on `module/*`, `deploy/*`, or `example/*`.
- Pure contracts and value objects belong in `pkg/*`; concrete adapters and
  runtime interfaces belong here before modules depend on them.
