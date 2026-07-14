import { metrics, type Attributes, type Meter } from "@opentelemetry/api";
import type {
  Counter,
  Histogram,
  ObservableCallback,
  ObservableGauge,
  UpDownCounter,
} from "@opentelemetry/api";

const defaultMeterName = "pacific-rim";

export type InstrumentOptions = {
  description?: string;
  meterName?: string;
  meterVersion?: string;
  unit?: string;
};

export const runtimeMetricNames = {
  messageCount: "pacific_rim.message.count",
  messageLatency: "pacific_rim.message.latency",
  moduleHealth: "pacific_rim.module.health",
  moduleRestarts: "pacific_rim.module.restarts",
} as const;

export function getMeter(name = defaultMeterName, version?: string): Meter {
  return metrics.getMeter(name, version);
}

export function counter(name: string, options: InstrumentOptions = {}): Counter<Attributes> {
  return getMeter(options.meterName, options.meterVersion).createCounter(name, options);
}

export function histogram(name: string, options: InstrumentOptions = {}): Histogram<Attributes> {
  return getMeter(options.meterName, options.meterVersion).createHistogram(name, options);
}

export function upDownCounter(name: string, options: InstrumentOptions = {}): UpDownCounter<Attributes> {
  return getMeter(options.meterName, options.meterVersion).createUpDownCounter(name, options);
}

export function observableGauge(
  name: string,
  callback: ObservableCallback<Attributes>,
  options: InstrumentOptions = {},
): ObservableGauge<Attributes> {
  const gauge = getMeter(options.meterName, options.meterVersion).createObservableGauge(name, options);
  gauge.addCallback(callback);
  return gauge;
}

export { metrics };
