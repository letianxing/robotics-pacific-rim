# infra-trace

OpenTelemetry tracing conventions and multi-language runtime helpers.

This package owns trace naming and context propagation for Pacific-Rim modules.
It intentionally does not configure exporters; deployment projects decide where
trace data is sent.

Exports:

- `withSpan<T>(name, fn, options)`
- `startSpan(name, options, context)`
- `injectTraceContext(carrier)`
- `extractTraceContext(carrier)`
- `getActiveTraceIds()`

Protocol messages should carry W3C `traceparent` and `tracestate` values inside
metadata so ROS2 nodes, adapters, and non-JS runtimes can join the same trace.

Implementations:

- `ts/index.ts`: TypeScript OpenTelemetry Trace API helper.
- `python/pacific_rim_trace`: Python OpenTelemetry trace context helper.
- `go/trace.go`: Go OpenTelemetry trace helper.
- `cpp/include/pacific_rim/trace/trace.hpp`: C++ header-only trace helper with OTLP export.
