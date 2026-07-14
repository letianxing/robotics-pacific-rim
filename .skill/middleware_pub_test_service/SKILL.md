# Middleware Pub Test Development Skill

Use this skill whenever an agent or engineer changes `module/service/middleware_pub_test_service`.
The module follows the same layered style as `module/service/action_service`: transport
entrypoints are thin, business behavior lives in service code, and
IDL/config files stay declarative.

## Module Role

`middleware_pub_test_service` is a ROS2 Go module. It owns API handlers, service use cases, and
configuration. It must not absorb reusable middleware clients, fabric bootstrap
logic, shared codecs, public IDL, shared drivers, or another module's business
behavior.

## Folder Responsibilities

- `cmd/middleware_pub_test/main.go`: process entry, signal handling, observability
  hooks, and communication runtime startup only.
- `internal/api`: thin handlers and payload adaptation. API code calls
  `internal/service`; it does not own middleware clients or long-running
  business state.
- `internal/service`: use-case orchestration and business behavior.
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

- This skill lives at `.skill/middleware_pub_test_service/SKILL.md`; do not
  duplicate it in the module root.
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
  routes this module consumes. Consumer routes still stay in local config and
  generate current-service pkg/idl protocol adapters and do not auto-call every `.proto rpc`.
- Generated protocol role files live under
  `pkg/idl/<service>/generated/<language>` with `DO NOT EDIT` comments.
  Provider routes add ports, wrappers, provider slots, and registrars; consumer
  routes add current-service client/subscriber adapters for upstream contracts.
  Module-local generated files import/include those abstractions and provide
  user-editable service/publisher/subscriber/client implementation files. Do
  not generate consumer adapters under the upstream provider's pkg tree.
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
    `pkg/idl/middleware_pub_test_service/public/interfaces.yaml`.
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
```

Use the dry-run manifest to confirm that services, topics, protobuf RPCs, and
protobuf messages are classified correctly. Running `./tools/generate-interfaces.sh`
generates role-based shared protocol files under `pkg/idl/<service>/generated/go`.
Provider routes add provider slots, route-specific `ports`, wrappers, and
middleware registrars; consumer routes add current-service client/subscriber
adapters for upstream public contracts. The module layer keeps a thin register
shim under `internal/api/generated`, injection defaults under
`internal/service/generated/service.go`, and user-editable service/publisher/
subscriber/client implementations under `internal/service/generated`. Provider
routes implement pkg generated ports from `pkg/idl/<service>/generated/go/ports.go`;
consumer routes delegate through current-service pkg protocol role files. Do not edit pkg generated role files. `cmd/middleware_pub_test/main.go` already calls
the module-local generated registration hook. Infra bootstrap owns middleware
client/backend registration and fabric connection; generated Go code only binds
configured routes to module handlers. Existing service implementations are not
overwritten by ordinary generation; use `--force` only to intentionally reset
them. Scaffold generation reads provider routes from public pkg interfaces and consumer routes from local `config.yaml`; local config must not duplicate provider routes.

The dashboard config editor performs the same flow: saving `config.yaml`
overwrites the file and automatically runs the scaffold for this module.

## Generated Interface Business Logic

After any scaffold run, use this read/write order:

1. Read `pkg/idl/<idl_service>/public/interfaces.yaml` and the source
   `.proto`, `.msg`, or `.srv` file to confirm the public contract.
2. Read this service's `pkg/idl/<service>/protocol_manifest.json` and
   `pkg/idl/<service>/generated/go`. Provider routes satisfy `ports.go`;
   consumer routes use current-service generated `client.go` or `subscriber.go`
   while referencing the upstream provider contract. Do not create a consumer
   adapter under the upstream provider's pkg tree.
3. Read `internal/api/generated/register.go` to see how module-local
   implementations are injected into the pkg registrar.
4. Write the business entrypoint in `internal/service/generated`:
   use `*_service.go` for `direction: server`,
   `*_publisher_service.go` for `direction: publish`,
   `*_subscriber_service.go` for `direction: subscribe`, and
   `*_client_service.go` for `direction: client`.
5. Move non-trivial behavior from that generated entrypoint into normal
   `internal/service`, domain, or adapter code, then call it from the generated
   implementation.

Do not edit `pkg/idl/<idl_service>/generated/go/*`,
`internal/api/generated/*`, or `internal/service/generated/service.go` for
normal business work. They are generated provider slots, registrars, or
injection helpers. The user-editable files are the route-specific service,
publisher, subscriber, and client implementation files under
`internal/service/generated`; ordinary generation creates them only when
missing, so do not run `--force` after adding business logic unless you
intentionally want to reset them.

Provider routes create business fill points. A server route implements an
`Execute(ctx, payload)` style service method; a publisher route implements an
`Execute(ctx, endpoint, payload)` style publisher method. Consumer routes create current-service pkg/idl protocol adapters plus
module-local fill points: `direction: subscribe` creates a subscriber callback,
and `direction: client` creates a downstream client helper. Keep `topic_ref` and `service_ref` in
`config/config.yaml`, then call or react to those dependencies from the normal
service/adapter layer.

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
