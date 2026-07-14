# infra-otel

Shared OpenTelemetry setup conventions for Pacific-Rim languages.

Default endpoint:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

Implementations:

- `ts`: TypeScript SDK initialization for traces, metrics, and logs.
- `python`: Python SDK initialization for traces, metrics, and logs.
- `go`: Go SDK initialization for traces, metrics, and logs.
- `cpp`: Header-only OTLP/HTTP helper used by ROS2 C++ modules.

Application code should initialize this package once at process startup, then
use `infra-log`, `infra-metric`, and `infra-trace` for signal creation. Deployment
owns the Collector and backend routing.
