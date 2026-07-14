# tools-bin

Workspace tooling for Pacific-Rim.

This project owns scaffolding and monorepo checks. It should remain independent
from runtime packages and modules.

## Interface Scaffold Generator

Generate interface scaffolds from a module's communication config and public IDL
definitions. The generator scans `pkg/idl` by default and also accepts
`--protocols <dir>` for explicit private or experimental schema sources. It no
longer scans `module/*/protocols` by default; shared contracts should be moved
to `pkg/idl`. The default IDL scope is `config.service.name`, so
`service.name: demo_action_service` maps to `pkg/idl/demo_action_service`; use a
route-level `idl_service` only when deliberately reusing another service's IDL.
By default, server/publisher and consumer routes write role-based generated
protocol files to the current service scope,
`pkg/idl/<service>/generated/<language>`: `ports`, `service`, `publisher`,
`client`, `subscriber`, `provider`, and `registry`. Provider routes add
byte-level contracts, provider slots, wrappers, ports, and middleware
registrars. Consumer routes add current-service client/subscriber adapters for
the upstream public contract; they do not generate files under the upstream
provider's pkg/idl tree. The invoking module keeps thin registration/typed
callback shims plus user-editable service/publisher/subscriber/client
implementations. `protocol_manifest.json` is emitted to
`pkg/idl/<service>/protocol_manifest.json`; `interface_scaffold_README.md` is
emitted next to the invoking module for review:

```bash
node bin/generate-interface-scaffold.mjs module/service/demo_action_service --dry-run
node bin/generate-interface-scaffold.mjs module/service/demo_action_service
```

The generator reads `communication.services/topics`, shared `topic_ref` and
`service_ref` targets from `pkg/idl/<service>/public/*.yaml`, ROS2 `.msg/.srv`,
and protobuf `.proto` files. When public manifest fields are repeated in a
module `config.yaml`, the local module config wins. It can also scan generated
language artifacts such as
AimRT-style ROS2 `type_support_pkg_main.cc`, generated Python modules, or
generated Go bindings as metadata. Generated artifacts are not protocol sources;
config routes should refer to the source protocol type names. The generator
keeps protobuf topic messages as messages and only marks protobuf RPC entries as
request/response services.

For ROS2 C++ modules, runtime registry output lives at
`src/runtime/ros2/generated_interface_registry.hpp` inside the module. It is a
thin typed ROS2 callback shim and injector for the pkg registrar, not infra
middleware/client registration. Business logic belongs in module-owned
handler/service/scheduler/executor/adapter code.
Existing module-local service implementations are not overwritten by ordinary
generation; use `--force` only when intentionally resetting generated skeletons.
