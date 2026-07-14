# Robot Full Stack Skill

Use this skill when planning or implementing a Pacific-Rim robot stack, robot
profile, driver adapter, AI module, or deployment bundle.

## Required Reading

Before changing a service module, read:

1. `AGENTS.md`
2. `module/service/<service>/AGENTS.md`
3. The service skill referenced by that module
4. `pkg/robot/capabilities.json`
5. The selected profile under `deploy/robot-profiles/*.json`

## Principles

- Services communicate through declared protocols only. Do not import code from
  another `module/service/*` package to call it directly.
- Hardware adapters expose physical state and commands as capabilities:
  inertial state, joint state, base odometry, base velocity, battery, and
  diagnostics.
- AI-native modules consume semantic contracts and produce explicit outputs:
  intent, task plan, memory event, and internal state.
- Robot profiles are composition metadata. They select services and deployment
  targets, but they do not contain service business logic.
- Missing IDL is a product/configuration gap. Ask for Dashboard or
  `./pr data-format` contract creation instead of hand-editing `pkg/idl`
  source files.

## Workflow

1. Identify the robot class and target profile.
2. Map requirements to capability IDs from `pkg/robot/capabilities.json`.
3. Check which capabilities already have available contracts.
4. Scaffold or edit modules only after reading their local `AGENTS.md`.
5. Run `./pr robot:check` and the profile verification commands before deploy.
