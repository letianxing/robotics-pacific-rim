# imu_service Agent Entry

Before changing this service, read repository-root path `.skill/imu_service/SKILL.md`.

Service-local entry points:
- Service root: `module/service/imu_service`
- Config: `module/service/imu_service/config/config.yaml`
- Params: `module/service/imu_service/config/params.yaml`
- IDL contracts: `pkg/idl/imu_service`
- Generated protocol code: `pkg/idl/imu_service/generated`

Keep business logic inside this service and communicate with other services only through configured protocols.
