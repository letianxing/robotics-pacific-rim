# module-{{name}}

{{title}} capability module.

This module may depend on shared `infra/*` projects. It should not depend directly
on another module.

Communication config lives in `config/config.yaml`. Keep consumer routes under
`communication.services/topics`; provider routes live in `pkg/idl/<service>/public/interfaces.yaml`; shared middleware bootstrap code stays in
`infra/communication`.

Public IDL lives under `pkg/idl/{{name}}/{pb,ros2}` by default. If a route
intentionally reuses another service's public IDL, set `idl_service` on that
route in `config/config.yaml`.
