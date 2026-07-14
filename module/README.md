# module

Runtime-loadable robot capabilities live here. Service projects are grouped
under `module/service/<service_name>`.

Rules:

- Modules can depend on `pkg/*` contracts and `infra/*` adapters/runtime
  interfaces.
- A module must have one production runtime process as its main deployable
  entrypoint. Extra CLI binaries, diagnostics, firmware, CSV files, and hardware
  references are allowed only as tools/assets owned by that process.
- Modules should avoid direct source dependencies on each other. A module may
  depend on another deployable module's ROS package when that package owns a
  concrete hardware/runtime surface. If the interface becomes a stable
  cross-module contract, split that contract into `pkg/*`.
- If two modules need the same pure concept, extract it into `pkg/*`.
- If two modules need the same middleware/runtime adapter, extract it into
  `infra/*`.
- Deployment manifests belong in `deploy/*`.

Current checked-in sample services:

- `service/smoke_001_service`: ROS2 C++ smoke module.
- `service/middleware_*_service`: middleware integration test modules.
