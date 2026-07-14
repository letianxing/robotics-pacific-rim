import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { metrics, trace } from "@opentelemetry/api";

export type ObservabilityOptions = {
  endpoint?: string;
  serviceName: string;
  serviceVersion?: string;
};

export type ObservabilityHandle = {
  loggerProvider: LoggerProvider;
  meterProvider: MeterProvider;
  shutdown: () => Promise<void>;
  tracerProvider: NodeTracerProvider;
};

const defaultEndpoint = "http://otel-collector:4318";

export function initObservability(options: ObservabilityOptions): ObservabilityHandle {
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? defaultEndpoint;
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.1.0",
  });

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    ],
  });
  tracerProvider.register();

  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 1000,
      }),
    ],
    resource,
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs` })),
    ],
    resource,
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  return {
    loggerProvider,
    meterProvider,
    tracerProvider,
    shutdown: async () => {
      await Promise.all([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}

export { logs, metrics, trace };
