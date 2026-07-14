from typing import Any

from opentelemetry import metrics


class Counter:
  def __init__(self, name: str) -> None:
    self.name = name
    self.instrument = metrics.get_meter("pacific-rim").create_counter(name)

  def add(self, amount: float = 1, attributes: dict[str, Any] | None = None) -> None:
    self.instrument.add(amount, attributes or {})


class Histogram:
  def __init__(self, name: str) -> None:
    self.name = name
    self.instrument = metrics.get_meter("pacific-rim").create_histogram(name)

  def record(self, value: float, attributes: dict[str, Any] | None = None) -> None:
    self.instrument.record(value, attributes or {})


_counters: dict[str, Counter] = {}
_histograms: dict[str, Histogram] = {}


runtime_metric_names = {
  "message_count": "pacific_rim.message.count",
  "message_latency": "pacific_rim.message.latency",
  "module_health": "pacific_rim.module.health",
  "module_restarts": "pacific_rim.module.restarts",
}


def counter(name: str) -> Counter:
  if name not in _counters:
    _counters[name] = Counter(name)
  return _counters[name]


def histogram(name: str) -> Histogram:
  if name not in _histograms:
    _histograms[name] = Histogram(name)
  return _histograms[name]
