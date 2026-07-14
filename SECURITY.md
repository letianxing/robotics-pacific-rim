# Security Policy

## Supported Versions

This project is currently pre-1.0. Security fixes are applied to the `main`
branch.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability. Report it by
email to:

```text
letianxing@users.noreply.github.com
```

Include:

- Affected component or package.
- Reproduction steps or proof of concept.
- Impact assessment.
- Suggested fix, if known.

We aim to acknowledge reports within 7 days.

## Dependency Audit Policy

CI fails on high or critical npm advisories. Moderate advisories are reviewed and
tracked when they come from upstream toolchains without a compatible non-breaking
upgrade path.

Current accepted moderate upstream toolchain advisories in the Dashboard
workspace:

- `next -> postcss`: pending a compatible Next release that depends on
  `postcss >= 8.5.10`.
- `expo -> xcode -> uuid`: pending an Expo/config-plugins release that depends on
  `uuid >= 11.1.1` or removes the vulnerable path.
- `drizzle-kit -> @esbuild-kit/esm-loader -> esbuild`: pending a drizzle-kit
  release that removes the deprecated esbuild-kit loader path.

Production high vulnerabilities should be fixed before release.

## Secrets

Never commit secrets. Local configuration belongs in `.env` files generated from
the provided `.env.example` templates.
