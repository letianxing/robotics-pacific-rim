# pkg

Domain-neutral packages live here.

Packages in this directory define stable contracts, value objects, and pure
helpers that do not depend on a concrete runtime, middleware, process model, or
robot business module.

Rules:

- A `pkg/*` project may depend on another `pkg/*` project.
- A `pkg/*` project must not depend on `infra/*`, `module/*`, `deploy/*`, or
  `example/*`.
- Concrete adapters for NATS, CycloneDDS, Zenoh, ROS2, MQTT, or gRPC belong in
  `infra/*`.
- Shared cross-module IDL belongs in `pkg/idl`, grouped as
  `pkg/idl/<service>/{pb,ros2}`.
- Robot capability taxonomy and AI-native profile vocabulary belongs in
  `pkg/robot`; it may reference IDL paths but must not define source contracts
  there.
- Communication contract value objects, bootstrap, clients, route lookup, and
  fabric live under `infra/communication`.
