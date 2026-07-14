# middleware_sub_test_service Interface Scaffold

Generated from:

- Config: module/service/middleware_sub_test_service/config/config.yaml
- Protocol sources:
  - pkg/idl
- Language: python

Server/publisher and consumer routes refresh role-based shared protocol files
under the current service scope:
pkg/idl/<service>/generated/<language>. Provider routes add route-specific
business ports, byte-level wrappers, provider slots, and middleware registrars.
Subscriber/client routes add current-service protocol receivers or clients for
the upstream public contract; they do not generate files under the upstream
provider's pkg/idl tree. Module-local output is limited to thin registration or
typed callback shims plus user-editable service/publisher/subscriber/client
implementations. Use --force only when intentionally resetting module-local
business implementation skeletons after IDL/config changes.

Layer direction:

external caller -> communication config -> runtime callback -> api handler -> service -> scheduler/executor -> adapter

Protocol rule:

- Public IDL source files live under pkg/idl.
- Generated protocol role files live under
  pkg/idl/<service>/generated/<language>. They are split by role
  (ports, service, publisher, client, subscriber, provider, registry). Provider
  routes add route-specific ports, wrappers, provider slots, and registrars.
  Consumer routes add current-service client/subscriber protocol adapters for
  the upstream contract. These files must not contain business logic, and each
  service should normally keep only its own implementation language there.
  Subscriber/client routes that consume another service do not generate another
  language copy under the provider's pkg/idl tree.
- Module-local generated files are thin shims plus user-editable
  service/publisher/subscriber/client implementations. The generated
  protocol_manifest.json lives under pkg/idl/<service>, next to the public
  contracts it summarizes. Provider routes implement pkg generated ports in
  module/service; consumer routes use module-local subscriber callbacks or
  downstream client helpers. Generated transport glue should stay stable.
- protobuf messages can model streaming topics.
- protobuf rpc entries should only model request/response services.
- ROS2 .msg maps to topics; ROS2 .srv maps to services.
- Public interface manifests live under pkg/idl/<service>/public/*.yaml.
  Provider routes for this module (topic publishers and service servers) are
  discovered from its public IDL. Local config.yaml is consumer-only and should
  contain only topic_ref/service_ref routes with subscribe/client direction.
- The scaffold writes user-editable implementation templates for routes this
  module provides to others (service servers and topic publishers) and for
  routes it consumes (topic subscriber callbacks and downstream service client
  helpers). Subscriber/client routes stay in local config, generate only
  current-service pkg/idl protocol adapters, and do not auto-call downstream
  RPCs.
- Generated language artifacts such as AimRT-style ROS2 type-support .cc files
  are scanned as metadata, not as protocol sources.
- Runtime registry files were not generated; keep existing runtime registration or add it manually.
