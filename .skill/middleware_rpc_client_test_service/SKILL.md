# Middleware Rpc Client Test Development Skill

Use this skill whenever an agent or engineer changes `module/service/middleware_rpc_client_test_service`.
The module follows the same layered style as `module/service/action_service`: transport
entrypoints are thin, business behavior lives in service/executor code, and
IDL/config files stay declarative.

## Module Role

`middleware_rpc_client_test_service` is a ROS2 C++ module. It owns runtime node,
business services, and configuration. It is a consumer-side sample: upstream
public contracts stay under the provider's `pkg/idl`, while this service gets
its own generated client protocol adapter under
`pkg/idl/middleware_rpc_client_test_service/generated/cpp`. This module must
not absorb reusable middleware clients, fabric bootstrap logic, shared codecs,
public IDL, shared drivers, or another module's business behavior.

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

- This skill lives at `.skill/middleware_rpc_client_test_service/SKILL.md`; do
  not duplicate it in the module root.
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
  current-service pkg/idl client/subscriber protocol adapters plus module-local
  subscriber callbacks and downstream service client helpers for routes this
  module consumes. Consumer routes stay in local config and do not auto-call
  every `.proto rpc`.
- Generated protocol role files live under
  `pkg/idl/<service>/generated/<language>` with `DO NOT EDIT` comments. Provider
  routes add ports/wrappers/registrars; consumer routes add current-service
  client/subscriber adapters that reference the upstream provider contract.
  Do not generate a consumer-language copy under the upstream provider's pkg
  tree. Module-local generated files include user-editable subscriber/client
  implementation files for consumed routes.
- If CycloneDDS request/reply is used for protobuf request/response, configure
  `transport: cyclonedds_rpc`, `standard: omg_dds_rpc|rmw_cyclonedds`, and
  `request`/`response`; the adapter belongs in `infra/communication/dds`, not
  in the module.
- For Go services, CycloneDDS must be a native in-process backend, not a ROS2
  bridge or sidecar. Users only edit config, but deployment must build with
  `CGO_ENABLED=1 -tags pacific_rim_cyclonedds` and include CycloneDDS `libddsc`.
  `rmw_cyclonedds` requires a real ROS2/rmw wire adapter; do not silently treat
  it as `omg_dds_rpc`.
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
  - Provider/publisher routes owned by this module go in
    `pkg/idl/middleware_rpc_client_test_service/public/interfaces.yaml`.
  - Subscriber/client routes consumed from another service stay only in local
    `config/config.yaml`.
  - Do not copy another provider's public topic/service into this module.
- `queue_group` is optional consumer/server grouping; `queue_size` is optional
  local buffering/QoS depth and is usually unnecessary for RPC unless an adapter
  explicitly consumes it.

## Scaffold Workflow

After adding public IDL files and `config/config.yaml` routes, run:

```bash
./tools/generate-interfaces.sh --dry-run
./tools/generate-interfaces.sh
```

The scaffold output for this client-only sample includes current-service
protocol adapters under `pkg/idl/middleware_rpc_client_test_service/generated/cpp`,
thin generated shims, `src/runtime/ros2/generated_interface_registry.hpp` route
metadata, and `src/service/generated/include/*_client_service.hpp`. The registry
is module-local route/callback binding plus pkg registrar delegation, not infra
middleware/client registration. Existing service implementation skeletons are
not overwritten by ordinary generation; pass `--force` only when intentionally
resetting them. Implement client-side business behavior in `src/service`,
`src/scheduler`, `src/executor`, or `src/adapter` as appropriate. Scaffold
generation reads provider routes from public pkg interfaces and consumer routes
from local `config.yaml`; local config must not duplicate provider routes.

The dashboard config editor performs the same flow: saving `config.yaml`
overwrites the file and automatically runs the scaffold for this module.

## Generated Interface Business Logic

This sample is currently consumer-side only, so the scaffold writes
current-service pkg/idl client protocol adapters, module-local route metadata,
`src/runtime/ros2/generated_interface_registry.hpp`, and
`src/service/generated/include/*_client_service.hpp`. For client or subscriber
routes, read this service's
`pkg/idl/middleware_rpc_client_test_service/protocol_manifest.json`, the
current-service generated adapter under
`pkg/idl/middleware_rpc_client_test_service/generated/cpp`, and the upstream
provider contract in `pkg/idl/<provider_service>/public/interfaces.yaml`; keep
this module's route in `config/config.yaml` with `service_ref` or `topic_ref`.

For `direction: client`, use the generated `*_client_service.hpp` helper from
normal `src/service`, `src/scheduler`, `src/executor`, or `src/adapter` code;
the scaffold should not auto-call downstream services at startup. For
`direction: subscribe`, write the receive entrypoint in generated
`*_subscriber_service.hpp` and move non-trivial reaction logic into the normal
service/adapter layer. Generated runtime/register files show route binding only
and should not contain business logic.

If this module later starts providing a service or publishing a topic, define
that owned public contract under
`pkg/idl/middleware_rpc_client_test_service/public/interfaces.yaml`, rerun the
scaffold, read `pkg/idl/<idl_service>/generated/cpp/ports.hpp`, and implement
the new provider fill point under `src/service/generated/include/*_service.hpp`
or `src/service/generated/include/*_publisher_service.hpp`.

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
6. Validate real provider/consumer wiring with
   `node bin/test-communication-pair.mjs --provider module/service/<provider> --consumer module/service/<consumer> --kind topic|service`.
7. Implement consumer business behavior in `src/service`, `src/scheduler`,
   `src/executor`, or `src/adapter`; use generated files only as route binding
   references.
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
