# infra-metric

OpenTelemetry metrics conventions and multi-language runtime helpers.

This package owns meter and instrument naming for Pacific-Rim modules. Exporters
and scrape endpoints belong in deployment projects.

Exports:

- `counter(name, options)`
- `histogram(name, options)`
- `upDownCounter(name, options)`
- `observableGauge(name, callback, options)`
- `runtimeMetricNames`

Default runtime metric names use the `pacific_rim.*` prefix.

Implementations:

- `ts/index.ts`: TypeScript OpenTelemetry Metrics API helper.
- `python/pacific_rim_metric`: Python OpenTelemetry Metrics helper.
- `go/metric.go`: Go OpenTelemetry Metrics helper.
- `cpp/include/pacific_rim/metric/metric.hpp`: C++ header-only metric helper with OTLP export.
