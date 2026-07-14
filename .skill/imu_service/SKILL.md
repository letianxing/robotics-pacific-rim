# Imu Development Skill

Use this skill whenever an agent or engineer changes `module/service/imu_service`.
The module follows the standard layered module style: transport
entrypoints are thin, business behavior lives in service/executor code, and
IDL/config files stay declarative.

## Module Role

`imu_service` is a ROS2 C++ module. It owns runtime node, business services, and
configuration. Generated route/callback binding lives under `pkg/idl`; this
module must not absorb reusable middleware clients, fabric bootstrap logic,
shared codecs, public IDL, shared drivers, or another module's business
behavior.

## Folder Responsibilities

- `src/node.cpp`: process entry and ROS2 node construction only. Do not add
  business methods here.
- `src/api/handler`: thin handlers for external service/topic requests. Handlers
  normalize protocol payloads and call `src/service`; they do not own schedulers,
  executors, adapters, or middleware clients.
- `src/service`: use-case orchestration and business behavior implementation.
- `src/scheduler`: optional timing, ownership, priority, cancellation, and
  transition decisions.
- `src/executor`: optional concrete execution workflows and algorithms.
- `src/adapter`: optional external-system or hardware integration.
- `src/domain`: pure domain data/value objects only.
- `config`: installed config only. `config/config.yaml` binds logical routes to
  ROS2/NATS/CycloneDDS middleware.
- `tools`: developer scripts such as interface scaffold generation.

## Layering Rules

The preferred call direction is:

`api handler -> service -> scheduler/executor -> adapter -> external systems`

`runtime` sits at the transport boundary. A ROS2 callback may physically enter
runtime first, but runtime should delegate to API handlers or services. `domain`
is pure data and must not call runtime, service, scheduler, executor, or adapter.

## Protocol And Communication Rules

- `pr create` stores this skill at `.skill/imu_service/SKILL.md`. Keep module root
  free of duplicated `SKILL.md` files unless a legacy tool explicitly requires
  one.
- Define public protocols first under `pkg/idl/<service>/{pb,ros2,public}`.
  `<service>` defaults to `config.service.name`; use route-level `idl_service`
  only for intentional cross-service IDL reuse. Only keep a private module
  schema locally if no other module or external system can ever reference it.
- Shared topics and shared services belong in `pkg/idl/<service>/public/*.yaml`
  and should be referenced from module config with `topic_ref` and
  `service_ref`.
- The provider owns the public contract. If this module publishes a shared
  topic or serves a shared request/response API, define it in its own
  `public/*.yaml`. If this module only subscribes to that topic or calls that
  service, keep the route only in local `config/config.yaml`.
- protobuf `message` can be used as a topic payload over NATS or CycloneDDS
  byte transport. protobuf request/response contracts should stay transport-
  neutral: they may be carried by `nats_rpc`, `cyclonedds_rpc`, or another
  infra middleware, not only a grpc-style endpoint.
- The scaffold generates provider-side service handlers and publisher-side
  sending helpers for routes this module exposes. It also generates
  module-local subscriber callbacks and downstream service client helpers for
  routes this module consumes. Consumer routes stay in local config, generate
  current-service pkg/idl protocol adapters, and do not auto-call every
  `.proto rpc`.
- Generated protocol role files live under
  `pkg/idl/<service>/generated/<language>` with `DO NOT EDIT` comments. These
  pkg files contain byte-level contracts, provider/subscriber slots,
  handler/publisher/client/subscriber wrappers, and middleware registrars; do
  not edit or copy them into `module/service/imu_service`. Module-local generated
  files are thin typed ROS2 shims plus user-editable service, publisher,
  subscriber, or downstream client implementations. Consumer routes reference
  the upstream provider contract but generate client/subscriber adapters under
  this service's pkg/idl tree, not under the upstream provider.
- Business route config should expose only `data`, `type`, `middleware`, route
  address fields, and QoS. Do not ask users to select transport buses,
  CycloneDDS RPC standards, ROS2 bridge/native mode, or ROS2 adapters in module
  routes.
- The communication runtime expands only the user-facing middleware family
  plus data format: `middleware: cyclonedds` or `middleware: fastdds` with
  `data: proto` uses the native DDS protobuf byte/RPC path; the same
  middleware with `data: msg|srv` uses the matching ROS2 RMW path internally.
  `data: dds_idl` or `data: omg_idl` uses typed native DDS when generated
  TypeSupport is registered, with byte-envelope fallback for CycloneDDS or
  FastDDS topic/RPC routes.
  `middleware: ros2` plus `data: proto` uses the ROS2 protobuf envelope, and
  native ROS2 `.msg/.srv` routes use ROSIDL without protobuf conversion. Do
  not use explicit runtime aliases such as `*_native` or `*_rmw` in route
  config.
- Generated code and module main/bootstrap should inject the route from config;
  users only edit config and business logic.
- Public manifests should describe what this module publicly publishes or
  publicly serves. Private subscribe-side topics and downstream client-side
  service calls stay only in local `config/config.yaml`.
- Configure route names, middleware bindings, and deployment-specific overrides
  in `config/config.yaml`.
- Binding route names are generated from the logical route plus binding fields.
  Use explicit `bindings[].name` when a stable short route name matters; otherwise
  middleware, transport, standard, and address fields are included to avoid
  duplicate routes when the same middleware carries multiple standards.
- Do not place ROS2 service names, ROS2 topic names, NATS subjects, DDS topics,
  or middleware choices in API/service code.
- Generated `.cc`, `.py`, `.go`, or other language bindings/type-support files
  are artifacts, not source protocols. Config routes reference source protocol
  type names such as `my_pkg/srv/DoThing` or `my_pkg/msg/Event`.
- Reusable transport logic belongs in `infra/communication`; reusable codecs and
  data-format mechanics belong in `infra/protocol`.
- Ownership matrix:
  - This module publishes a shared topic: define the topic in
    `pkg/idl/imu_service/public/interfaces.yaml`. Do not duplicate provider routes in
    local config; the scaffold reads publishers from public IDL.
  - This module provides a shared request/response service: define it in
    `pkg/idl/imu_service/public/interfaces.yaml`. Do not duplicate provider routes in
    local config; the scaffold reads service servers from public IDL.
  - This module subscribes to another service's topic: keep only a local
    `topic_ref` route with `direction: subscribe`; do not copy the provider's
    public topic into this module.
  - This module calls another service: keep only a local `service_ref` route
    with `direction: client`; do not copy the provider's public service into
    this module.
- `queue_group` is optional and means consumer/server group affinity for
  transports that support it, especially NATS subscriptions and NATS RPC
  servers. Pure publish routes and single-instance providers usually omit it.
- `queue_size` is optional local buffering/QoS depth. For CycloneDDS/ROS2 topic
  bindings it can map to QoS depth when no explicit `qos.depth` is set. RPC
  routes usually omit it unless the adapter explicitly consumes it.

## Scaffold Workflow

After adding public IDL files and `config/config.yaml` routes, run:

```bash
./tools/generate-interfaces.sh --dry-run
./tools/generate-interfaces.sh
```

The scaffold output includes role-based shared protocol files under
`pkg/idl/<service>/generated/cpp`. Provider routes add provider slots,
byte-level wrappers, middleware registrars, and route-specific `ports` under
`pkg/idl/<service>/generated/cpp/ports.hpp`. Consumer routes add current-service
`client.hpp` or `subscriber.hpp` protocol adapters for upstream public
contracts. Module-local output is limited to typed ROS2 API handler/publisher
shims, user-editable service/publisher/subscriber/client implementation
skeletons, and
`src/runtime/ros2/generated_interface_registry.hpp`, which injects module
business implementations into the pkg registrar or binds consumer callbacks.
Provider routes implement the pkg generated ports in
`src/service/generated/include/*`; consumer routes delegate through
current-service generated client/subscriber adapters. Do not edit pkg generated
role files.
The registry is module-local
typed route/callback binding, not infra middleware/client registration. Existing
service implementation skeletons are not overwritten by ordinary generation;
pass `--force` only when intentionally resetting them. Then implement business
behavior in `src/service`, `src/scheduler`, `src/executor`, or `src/adapter` as
appropriate. Scaffold generation reads provider routes from public pkg interfaces and consumer routes from local `config.yaml`; local config must not duplicate provider routes.

The dashboard config editor performs the same flow: saving `config.yaml`
overwrites the file and automatically runs the scaffold for this module.

## Generated Interface Business Logic

After any scaffold run, use this read/write order:

1. Read `pkg/idl/<idl_service>/public/interfaces.yaml` and the source
   `.proto`, `.msg`, or `.srv` file to confirm the public contract.
2. Read this service's `pkg/idl/<service>/protocol_manifest.json` and
   `pkg/idl/<service>/generated/cpp`. Provider routes satisfy `ports.hpp`;
   consumer routes use current-service generated `client.hpp` or
   `subscriber.hpp` while referencing the upstream provider contract. Do not
   expect or create a consumer-language copy under the upstream provider's pkg
   tree.
3. Read module-local generated shims such as
   `src/api/handler/include/*_api_handler.hpp`,
   `src/api/publisher/include/*_api_publisher.hpp`, and
   `src/runtime/ros2/generated_interface_registry.hpp` to see how route
   callbacks are bound and injected into the pkg registrar.
4. Write the business entrypoint in `src/service/generated/include`:
   use `*_service.hpp` for `direction: server`,
   `*_publisher_service.hpp` for `direction: publish`,
   `*_subscriber_service.hpp` for `direction: subscribe`, and
   `*_client_service.hpp` for `direction: client`.
5. Move non-trivial behavior from that generated entrypoint into normal
   `src/service`, `src/scheduler`, `src/executor`, or `src/adapter` code, then
   call it from the generated implementation.

Do not edit `pkg/idl/<idl_service>/generated/cpp/*`, generated API
handler/publisher shims, or `src/runtime/ros2/generated_interface_registry.hpp`
for normal business work. They are generated ports, wrappers, registrars, and
typed callback binding. The user-editable files are the route-specific service,
publisher, subscriber, and client implementation headers under
`src/service/generated/include`; ordinary generation creates them only when
missing, so do not run `--force` after adding business logic unless you
intentionally want to reset them.

Provider routes create business fill points. A server route implements an
`Execute(...)`/`ExecuteBytes(...)` service class; a publisher route implements a
publisher service class. Consumer routes also create module-local fill points
without copying provider IDL: `direction: subscribe` creates a subscriber
callback, and `direction: client` creates a downstream client helper. Keep
`topic_ref` and `service_ref` in `config/config.yaml`, then call or react to
those dependencies from the normal service/adapter layer.

## Agent Workflow

When using Codex, Claude Code, or another agent to evolve this module, the
expected sequence is:

1. Decide whether the new route or schema is public or private.
2. Define public msg/srv/proto/public-manifest files under
   `pkg/idl/<service>/{ros2,pb,public}` first.
3. Update `config/config.yaml` with `topic_ref` or `service_ref` for shared
   routes and keep middleware names, QoS, queue groups, remaps, and overrides
   local to config.
4. Run `./tools/generate-interfaces.sh --dry-run` and inspect the manifest.
5. Run `./tools/generate-interfaces.sh` after the manifest is correct.
6. For a real provider/consumer pair, run
   `node bin/test-communication-pair.mjs --provider module/service/<provider> --consumer module/service/<consumer> --kind topic|service`.
7. Implement the real business code using the generated interface business
   logic rules above.
8. Build, test, or deploy only after IDL, config, and generated bindings agree.

Agents should follow this order even when the user never opens the dashboard.

## Required Questions

When a user request is underspecified, the agent should stop and ask the
minimum necessary integration questions before writing IDL or `config.yaml`.
This matters most before picking middleware, route ownership, or public API
shape.

The agent should explicitly confirm:

- Which existing service or external system this module needs to talk to.
- Whether that dependency is upstream or downstream relative to this module.
- Whether the new surface is a topic or a request/response service.
- Whether the user wants ROS2 native, CycloneDDS, NATS, or a combination.
- Whether the route should stay private in module config or become public in
  `pkg/idl/<service>/public/*.yaml`.
- Which messages, interfaces, or events must be exposed to other modules.

Typical clarification prompts:

- "You currently have CycloneDDS and NATS available. Which one should this
  topic/service use, or should it stay ROS2 native?"
- "Which service under the current module tree are you integrating with?"
- "Is that service your upstream caller or your downstream dependency?"
- "Which topic, service, message, or event do you need to expose to it?"
- "Should this contract be shared in public pkg, or remain private to the
  module?"
- "If this uses CycloneDDS request/reply, should `standard` be `omg_dds_rpc`
  or `rmw_cyclonedds`?"

## File Size And Review Rules

- Keep every source/header/script under 300 lines.
- Split lifecycle, mapping, parsing, scheduling, execution, and publishing into
  separate files when they grow.
- Add focused tests for changed layers.
- Do not commit generated caches, build outputs, or temporary scaffold output.
