# Robot Capability Catalog

`pkg/robot` defines the shared robot capability vocabulary used by deployment
profiles, dashboard views, and AI-assisted module planning.

The catalog is intentionally separate from `pkg/idl`. Capability entries can
describe desired robot behavior before a concrete interface exists, while IDL
contracts remain owned by Dashboard or `./pr data-format`.

Use cases:

- Map service modules to robot capabilities such as inertial state, base
  velocity, audio input, or memory events.
- Keep robot profiles portable across humanoid, wheeled, biped, tracked, and
  reference robots.
- Give agents a stable vocabulary for generating module plans without directly
  coupling modules to each other.

Run `./pr robot:check` after editing capability or profile files.
