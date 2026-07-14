import os
import logging
from dataclasses import dataclass

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

DEFAULT_ENDPOINT = "http://otel-collector:4318"


@dataclass
class ObservabilityHandle:
  tracer_provider: TracerProvider
  meter_provider: MeterProvider
  logger_provider: LoggerProvider
  log_handler: LoggingHandler

  def shutdown(self) -> None:
    logging.getLogger().removeHandler(self.log_handler)
    self.tracer_provider.shutdown()
    self.meter_provider.shutdown()
    self.logger_provider.shutdown()


def init_observability(service_name: str, service_version: str = "0.1.0", endpoint: str | None = None) -> ObservabilityHandle:
  base_endpoint = endpoint or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", DEFAULT_ENDPOINT)
  resource = Resource.create({
    "service.name": service_name,
    "service.version": service_version,
  })

  tracer_provider = TracerProvider(resource=resource)
  tracer_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{base_endpoint}/v1/traces"))
  )
  trace.set_tracer_provider(tracer_provider)

  meter_provider = MeterProvider(
    resource=resource,
    metric_readers=[
      PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=f"{base_endpoint}/v1/metrics"),
        export_interval_millis=1000,
      )
    ],
  )
  metrics.set_meter_provider(meter_provider)

  logger_provider = LoggerProvider(resource=resource)
  logger_provider.add_log_record_processor(
    BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{base_endpoint}/v1/logs"))
  )
  set_logger_provider(logger_provider)
  log_handler = LoggingHandler(level=logging.NOTSET, logger_provider=logger_provider)
  root_logger = logging.getLogger()
  root_logger.setLevel(logging.INFO)
  root_logger.addHandler(log_handler)

  return ObservabilityHandle(
    tracer_provider=tracer_provider,
    meter_provider=meter_provider,
    logger_provider=logger_provider,
    log_handler=log_handler,
  )


__all__ = ["LoggingHandler", "ObservabilityHandle", "init_observability"]
