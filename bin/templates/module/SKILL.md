# {{title}} Development Skill

Use this skill whenever an agent or engineer changes `module/service/{{name}}`.
Keep the module layered and avoid moving communication infrastructure or shared
protocol mechanics into business code.

## Module Role

`{{name}}` owns its service-specific business behavior, routes, and runtime
entrypoints. It may depend on shared `infra/*` and `pkg/*` libraries, but it
should not depend directly on another module.

## Folder Responsibilities

- `config`: pure configuration. Put middleware route bindings in
  `config/config.yaml`. Do not put code, includes, loaders, or mappers here.
- `src`: module-owned business source. Keep one responsibility per file.
- `src/api` or `<package>/api`: external API handlers and payload adaptation.
- `src/service` or `<package>/service`: use-case orchestration and business
  behavior implementation.
- `tools`: developer scripts and scaffold helpers. Do not make tool scripts
  hidden runtime dependencies.

## Layering Rules

The preferred call direction is:

`api handler -> service -> scheduler/executor -> adapter -> external systems`

Runtime code may receive transport callbacks first, but it should only bind the
transport and delegate inward. Business logic belongs in service/executor code,
not in config, protocols, or middleware bootstrap.

## Protocol And Communication Rules

- `pr create` stores this skill at `.skill/{{name}}/SKILL.md`. Keep module root
  free of duplicated `SKILL.md` files unless a legacy tool explicitly requires
  one.
- Define public IDL before writing handlers. Shared contracts belong under
  `pkg/idl/<service>/{pb,ros2,public}`, not inside this module. `<service>`
  defaults to `config.service.name`; use route-level `idl_service` only for
  intentional cross-service IDL reuse.
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
- Put middleware choices, route-local overrides, topic names, service names,
  subjects, DDS topics, and QoS in `config/config.yaml`.
- Do not put NATS, CycloneDDS, ROS2 bridge mechanics, retry loops, or shared
  serialization infrastructure in this module. Use `infra/communication` and
  `infra/protocol`.
- Generated language artifacts such as `.cc`, `.py`, or `.go` bindings are not
  source protocols. Config routes should reference source protocol type names.
- Ownership matrix:
  - This module publishes a shared topic: define the topic in
    `pkg/idl/{{name}}/public/interfaces.yaml`. Do not duplicate provider routes in
    local config; the scaffold reads publishers from public IDL.
  - This module provides a shared request/response service: define it in
    `pkg/idl/{{name}}/public/interfaces.yaml`. Do not duplicate provider routes in
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

After adding provider contracts under `pkg/idl` and consumer routes under `config/config.yaml`, run:

```bash
./tools/generate-interfaces.sh --dry-run
./tools/generate-interfaces.sh
```

The dashboard config editor performs the same flow: saving `config.yaml`
overwrites the file and automatically runs the scaffold for this module.

Server/publisher and consumer routes write role-based generated protocol files
under the current service scope:
`pkg/idl/<service>/generated/<language>` (`ports`, `service`, `publisher`,
`client`, `subscriber`, `provider`, `registry`). The pkg layer owns byte-level
contracts, wrappers, provider/subscriber slots, and middleware registrars.
Consumer routes generate current-service client/subscriber adapters for the
upstream public contract, not a copy under the upstream provider's pkg tree.
Module-local generated output is a thin registration/typed-callback shim plus
user-editable service, publisher, subscriber, or downstream client
implementations. Runtime registry files, when generated, are route/callback
bindings and pkg registrar injection points; infra still owns middleware
bootstrap, client registration, and fabric connection. Keep business behavior
in the correct module layer and inject it through supported generated provider
slots or consumer callbacks/helpers.
Existing service implementations are not overwritten by ordinary generation;
use `--force` only when intentionally resetting them. Scaffold generation
merges shared public manifest defaults with local `config.yaml`, and local
duplicated fields win.

## Generated Interface Business Logic

After any scaffold run, use this read/write order:

1. Read `pkg/idl/<idl_service>/public/interfaces.yaml` and the source
   `.proto`, `.msg`, or `.srv` file to confirm the public contract.
2. Read this service's `pkg/idl/<service>/protocol_manifest.json` and
   `pkg/idl/<service>/generated/<language>`. Provider routes satisfy
   `ports.*`; consumer routes use the current service's generated `client` or
   `subscriber` adapters while referencing the upstream provider contract. Do
   not expect or create a consumer-language copy under the upstream provider's
   pkg tree.
3. Read module-local generated API/register/runtime files to see how
   implementations are injected into the pkg registrar.
4. Write the business entrypoint in module-local `service/generated` files:
   provider routes use `*_service` or `*_publisher_service`, subscriber routes
   use `*_subscriber_service`, and downstream service calls use
   `*_client_service`. Move non-trivial behavior into normal service,
   scheduler, executor, domain, or adapter code.
5. Leave `pkg/idl/<idl_service>/generated/<language>/*` and module-local
   register/runtime shim files generated unless changing the scaffold itself.

Provider routes create business fill points. `direction: server` creates a
route-specific service implementation; `direction: publish` creates a
route-specific publisher implementation. Consumer routes also create
module-local fill points without copying provider IDL: `direction: subscribe`
creates a subscriber callback, and `direction: client` creates a downstream
client helper. Keep `topic_ref` and `service_ref` in `config/config.yaml`, then
call or react to those dependencies from the normal service/adapter layer.

Route-specific files under module-local `service/generated` are intentionally
user-editable even though they are scaffold-created. Ordinary generation creates
them only when missing, so do not run `--force` after adding business logic
unless you intentionally want to reset them.

## Agent Workflow

When using Codex, Claude Code, or another agent to build a new module feature,
the expected order is:

1. Clarify whether the new message, topic, or service is public or private.
2. Define public contracts first under `pkg/idl/<service>/{ros2,pb,public}`.
3. Reference shared routes from `config/config.yaml` with `topic_ref` or
   `service_ref`; keep middleware names, QoS, queue groups, remaps, and
   deployment-specific overrides local to config.
4. Run `./tools/generate-interfaces.sh --dry-run` and inspect the manifest.
5. Run `./tools/generate-interfaces.sh` only after the manifest looks correct.
6. For a real provider/consumer pair, run
   `node bin/test-communication-pair.mjs --provider module/service/<provider> --consumer module/service/<consumer> --kind topic|service`.
7. Implement business behavior using the generated interface business logic
   rules above.
8. Run the module build/test/deploy command only after IDL, config, and
   generated scaffolds are aligned.

Agents should not start by writing handler/service code before shared IDL and
config are settled. If a user prefers natural-language generation over the
dashboard, this file is the source of truth for the required sequence.

## Required Questions

When a user request is underspecified, the agent should pause and ask the
minimum necessary product/integration questions before writing IDL or config.
Do this especially before choosing transport, route ownership, or public API
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
- "Is this a Go service that needs native CycloneDDS in deployment? If yes,
  should the Docker/build command enable `pacific_rim_cyclonedds`?"

## File Size And Review Rules

- Keep every source/header/script under 300 lines.
- Split lifecycle, mapping, parsing, scheduling, execution, and publishing into
  separate files when they grow.
- Do not commit generated caches, build outputs, or temporary files.
- Add tests for the layer changed.
