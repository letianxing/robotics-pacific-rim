# Contributing

Thanks for taking the time to improve Robotics Pacific Rim.

## Development Setup

Use Node.js 20 or newer. The repository also uses Go, Docker, and ROS2 tooling for
some modules.

```bash
npm ci
cd dashboard && npm ci && cd ..
./setup.sh --no-db
node bin/pr.mjs check
node test/run.mjs
```

`./setup.sh` generates a local `./pr` executable. If you have not run it yet, most
commands can be invoked with `node bin/pr.mjs`.

## Contribution Rules

- Keep framework changes small and focused.
- Do not commit `.env`, local caches, generated Docker image archives, or machine
  specific paths.
- Do not edit `pkg/idl/**` source contracts by hand. Use Dashboard or
  `./pr data-format`.
- Do not put business logic into generated files under `pkg/idl/**/generated/**`
  or `module/service/**/generated/**`.
- Keep services communicating through declared protocols, not direct code calls.

## Checks Before Pull Request

Run these commands before opening a pull request:

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high --prefix dashboard
node bin/pr.mjs check
node test/run.mjs
```

If your change touches Dashboard packages, also run:

```bash
cd dashboard
npm run check
npm run check-types
```

## Reporting Issues

When filing an issue, include:

- The command you ran.
- The full error output.
- OS, Node.js version, Docker version, and ROS distro if relevant.
- A minimal service/config example when the issue involves generated interfaces.

## Pull Request Expectations

- Explain the behavior change and why it is needed.
- Include tests for framework, generator, or runtime behavior changes.
- Update docs when user-facing commands, config fields, or workflows change.
- Mention any follow-up risks, especially dependency or platform compatibility
  constraints.
