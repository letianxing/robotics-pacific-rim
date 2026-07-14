from dataclasses import dataclass
from typing import Any

from opentelemetry import context, trace
from opentelemetry.propagate import extract, inject
from opentelemetry.trace import Span as OtelSpan


@dataclass
class Span:
  name: str
  otel_span: OtelSpan
  token: object | None

  def end(self) -> None:
    self.otel_span.end()
    if self.token is not None:
      context.detach(self.token)
      self.token = None

  def set_attribute(self, key: str, value: Any) -> None:
    self.otel_span.set_attribute(key, value)

  @property
  def trace_id(self) -> str:
    return f"{self.otel_span.get_span_context().trace_id:032x}"

  @property
  def span_id(self) -> str:
    return f"{self.otel_span.get_span_context().span_id:016x}"

  def __enter__(self) -> "Span":
    return self

  def __exit__(self, exc_type, exc, traceback) -> None:
    if exc is not None:
      self.otel_span.record_exception(exc)
    self.end()


def start_span(name: str, attributes: dict[str, Any] | None = None) -> Span:
  otel_span = trace.get_tracer("pacific-rim").start_span(name, attributes=attributes or {})
  token = context.attach(trace.set_span_in_context(otel_span))
  return Span(name=name, otel_span=otel_span, token=token)


def start_span_from_carrier(
  name: str,
  carrier: dict[str, str],
  attributes: dict[str, Any] | None = None,
) -> Span:
  parent_context = extract(carrier)
  otel_span = trace.get_tracer("pacific-rim").start_span(
    name,
    context=parent_context,
    attributes=attributes or {},
  )
  token = context.attach(trace.set_span_in_context(otel_span, parent_context))
  return Span(name=name, otel_span=otel_span, token=token)


def get_active_trace_ids() -> dict[str, str]:
  span = trace.get_current_span()
  span_context = span.get_span_context()
  if not span_context.is_valid:
    return {}

  return {
    "traceId": f"{span_context.trace_id:032x}",
    "spanId": f"{span_context.span_id:016x}",
  }


def inject_trace_context(carrier: dict[str, str]) -> dict[str, str]:
  inject(carrier)
  return carrier


def current_traceparent() -> str:
  carrier: dict[str, str] = {}
  inject(carrier)
  return carrier.get("traceparent", "")


def route_span_name(name: str, metadata: dict[str, Any] | None = None, kind: str = "") -> str:
  metadata = metadata or {}
  configured = str(metadata.get("trace.span_name") or "")
  if configured:
    return configured
  span_name = str(metadata.get("logical_route") or name)
  if kind and "." not in span_name:
    span_name = f"{span_name}.{kind}"
  return span_name
