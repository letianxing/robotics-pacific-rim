# {{title}} Development Skill

Use this skill whenever an agent or engineer changes `module/service/{{name}}`.
The module follows the same layered style as generated service modules: transport
entrypoints are thin, business behavior lives in service code, and
IDL/config files stay declarative.

## Module Role

`{{name}}` is a ROS2 Python module. It owns runtime node, API handlers, service
use cases, and configuration. It must not absorb reusable middleware clients,
fabric bootstrap logic, shared codecs, public IDL, shared drivers, or another
module's business behavior.

## Folder Responsibilities

- `{{packageName}}/node.py`: process entry, ROS2 node lifecycle, and
  communication runtime startup only.
- `{{packageName}}/api`: thin handlers and payload adaptation. API code calls
  `{{packageName}}/service`; it does not own middleware clients or long-running
  business state.
- `{{packageName}}/service`: use-case orchestration and business behavior.
- `config`: installed config only. `config/config.yaml` binds logical routes to
  ROS2/NATS/CycloneDDS middleware.
- `tools`: developer scripts such as interface scaffold generation.

## Layering Rules

The preferred call direction is:

`api handler -> service -> scheduler/executor -> adapter -> external systems`

Runtime code may receive transport callbacks first, but it should only bind the
transport and delegate inward. Domain-like data should stay pure and must not
call runtime, middleware, or service orchestration.

## Protocol And Communication Rules

- `pr create` stores this skill at `.skill/{{name}}/SKILL.md`. Keep module root
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
  not edit or copy them into `module/service/{{name}}`. Module-local generated
  files are thin shims plus user-editable service, publisher, subscriber, or
  downstream client implementations. Consumer routes reference the upstream
  provider contract but generate client/subscriber adapters under this service's
  pkg/idl tree, not under the upstream provider.
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

After adding public IDL files and `config/config.yaml` routes, run:

```bash
./tools/generate-interfaces.sh --dry-run
```

Use the dry-run manifest to confirm that services, topics, protobuf RPCs, and
protobuf messages are classified correctly. Running `./tools/generate-interfaces.sh`
generates role-based shared protocol files under
`pkg/idl/<service>/generated/python`. Provider routes add provider slots,
byte-level wrappers, route-specific `ports`, and middleware registrars.
Consumer routes add current-service `client.py` or `subscriber.py` protocol
adapters for upstream public contracts. It writes a module-local thin register
shim under `{{packageName}}/api/generated` and user-editable implementations
under `{{packageName}}/service/generated`. Provider routes implement public
ports from `pkg/idl/<service>/generated/python/ports.py`; consumer routes
delegate through current-service generated client/subscriber adapters. Do not
edit pkg generated role files.
`{{packageName}}/node.py` already
calls the module-local generated registration hook. Infra bootstrap owns
middleware client/backend registration and fabric connection; generated Python
code only binds configured routes to module business implementations. Existing
service implementations are not overwritten by ordinary generation; use
`--force` only to intentionally reset them. Scaffold generation merges public
provider routes from public IDL and consumer routes from local `config.yaml`; local config must not duplicate provider routes.

The dashboard config editor performs the same flow: saving `config.yaml`
overwrites the file and automatically runs the scaffold for this module.

## Generated Interface Business Logic

After any scaffold run, use this read/write order:

1. Read `pkg/idl/<idl_service>/public/interfaces.yaml` and the source
   `.proto`, `.msg`, or `.srv` file to confirm the public contract.
2. Read this service's `pkg/idl/<service>/protocol_manifest.json` and
   `pkg/idl/<service>/generated/python`. Provider routes satisfy `ports.py`;
   consumer routes use current-service generated `client.py` or `subscriber.py`
   while referencing the upstream provider contract. Do not expect or create a
   consumer-language copy under the upstream provider's pkg tree.
3. Read `{{packageName}}/api/generated/register.py` to see how module-local
   implementations are injected into the pkg registrar.
4. Write the business entrypoint in `{{packageName}}/service/generated`:
   use `*_service.py` for `direction: server`,
   `*_publisher_service.py` for `direction: publish`,
   `*_subscriber_service.py` for `direction: subscribe`, and
   `*_client_service.py` for `direction: client`.
5. Move non-trivial behavior from that generated entrypoint into normal
   `{{packageName}}/service`, domain, or adapter code, then call it from the
   generated implementation.

Do not edit `pkg/idl/<idl_service>/generated/python/*`,
`{{packageName}}/api/generated/*`, or generated provider/default wiring for
normal business work. They are generated provider slots, registrars, or
injection helpers. The user-editable files are the route-specific service,
publisher, subscriber, and client implementation files under
`{{packageName}}/service/generated`;
ordinary generation creates them only when missing, so do not run `--force`
after adding business logic unless you intentionally want to reset them.

Provider routes create business fill points. A server route implements an
`execute(...)` style service method; a publisher route implements a publisher
service method. Consumer routes also create module-local fill points without
copying provider IDL: `direction: subscribe` creates a subscriber callback, and
`direction: client` creates a downstream client helper. Keep `topic_ref` and
`service_ref` in `config/config.yaml`, then call or react to those dependencies
from the normal service/adapter layer.

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

- Keep every source/script under 300 lines.
- Split lifecycle, mapping, parsing, scheduling, execution, and publishing into
  separate files when they grow.
- Add focused tests for changed layers.
- Do not commit generated caches, build outputs, or temporary scaffold output.
