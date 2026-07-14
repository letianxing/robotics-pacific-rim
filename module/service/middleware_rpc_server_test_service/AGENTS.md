# middleware_rpc_server_test_service Agent Entry

Before changing this service, read repository-root path `.skill/middleware_rpc_server_test_service/SKILL.md`.

Service-local entry points:
- Service root: `module/service/middleware_rpc_server_test_service`
- Config: `module/service/middleware_rpc_server_test_service/config/config.yaml`, `module/service/middleware_rpc_server_test_service/src/config/config.yaml`, or `module/service/middleware_rpc_server_test_service/config.yaml`
- IDL contracts: `pkg/idl/middleware_rpc_server_test_service`
- Generated protocol code: `pkg/idl/middleware_rpc_server_test_service/generated`

Keep business logic inside this service and communicate with other services only through configured protocols.
