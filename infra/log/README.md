# infra-log

OpenTelemetry log conventions and multi-language structured logging helpers.

This package emits logs through the OpenTelemetry Logs API and attaches active
`traceId` / `spanId` fields when a span is active. Exporters and collectors stay
outside runtime modules.

Exports:

- `emitLog(message, options)`
- `info(message, attributes)`
- `warn(message, attributes)`
- `error(message, attributes)`

Implementations:

- `ts/index.ts`: TypeScript OpenTelemetry Logs API helper.
- `python/pacific_rim_log`: Python logging helper exported through the OTel logging handler.
- `go/log.go`: Go slog plus OpenTelemetry Logs bridge.
- `cpp/include/pacific_rim/log/log.hpp`: C++ ROS2 logging helper with OTLP export.
