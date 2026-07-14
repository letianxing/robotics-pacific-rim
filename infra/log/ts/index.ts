import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import type { Attributes, Context } from "@opentelemetry/api";
import { getActiveTraceIds } from "../../trace/dist/index.js";

const defaultLoggerName = "pacific-rim";

export type LogOptions = {
  attributes?: Attributes;
  context?: Context;
  loggerName?: string;
  loggerVersion?: string;
  severityNumber?: SeverityNumber;
  severityText?: string;
  timestamp?: number;
};

export function getLogger(name = defaultLoggerName, version?: string): Logger {
  return logs.getLogger(name, version);
}

export function emitLog(message: string, options: LogOptions = {}): void {
  const logger = getLogger(options.loggerName, options.loggerVersion);
  const traceIds = getActiveTraceIds();

  logger.emit({
    attributes: {
      ...traceIds,
      ...options.attributes,
    },
    body: message,
    context: options.context,
    severityNumber: options.severityNumber ?? SeverityNumber.INFO,
    severityText: options.severityText ?? "INFO",
    timestamp: options.timestamp ?? Date.now(),
  });
}

export function info(message: string, attributes?: Attributes): void {
  emitLog(message, {
    attributes,
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
  });
}

export function warn(message: string, attributes?: Attributes): void {
  emitLog(message, {
    attributes,
    severityNumber: SeverityNumber.WARN,
    severityText: "WARN",
  });
}

export function error(message: string, attributes?: Attributes): void {
  emitLog(message, {
    attributes,
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
  });
}

export { SeverityNumber, logs };
