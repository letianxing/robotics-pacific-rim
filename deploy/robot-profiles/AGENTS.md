# Robot Profile Rules

- Keep active profiles deployable from existing `module/service/*` projects.
- Template profiles may name planned service slots, but they must set
  `"required": false` or place them under `plannedServices`.
- Do not add direct service-to-service code dependencies from a profile.
  Profiles only bind services by capability IDs and deployment intent.
- New protocol contracts must be created through Dashboard or
  `./pr data-format`; do not manually edit `pkg/idl` source contracts.
