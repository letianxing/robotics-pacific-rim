# Robot Catalog Rules

- Do not edit `pkg/idl` source contracts from this package. If a capability
  requires a missing message, service, or topic contract, call that out and use
  Dashboard or `./pr data-format` to create it.
- `capabilities.json` is taxonomy and planning metadata only. It must not embed
  generated code or service business logic.
- Capabilities are stable semantic IDs. Prefer adding versioned contract fields
  over renaming an existing capability ID.
- Service modules remain isolated. A profile may bind modules together only by
  named capabilities and protocol routes, never by direct code imports.
