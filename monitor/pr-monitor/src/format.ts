import { TypeBits, type EndpointInfo, type EndpointType, type MonitorOptions, type ProcessInfo } from "./model.js";

export function formatHz(value: number) {
  return `${formatFixed(value, 2)}Hz`;
}

export function formatOptionalHz(value: number | null) {
  return value === null ? "---" : formatHz(value);
}

export function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${formatFixed(value / 1024 / 1024 / 1024, 2)}GB`;
  if (value >= 1024 * 1024) return `${formatFixed(value / 1024 / 1024, 2)}MB`;
  if (value >= 1024) return `${formatFixed(value / 1024, 2)}KB`;
  return `${formatFixed(value, value >= 10 ? 0 : 2)}B`;
}

export function formatOptionalBytes(value: number | null) {
  return value === null ? "---" : formatBytes(value);
}

export function formatOptionalFixed(value: number | null, digits: number, suffix = "") {
  return value === null ? "---" : `${formatFixed(value, digits)}${suffix}`;
}

export function formatNumber(value: number, unitValue: number) {
  if (value >= unitValue * unitValue * unitValue) return `${formatFixed(value / unitValue / unitValue / unitValue, 1)}G`;
  if (value >= unitValue * unitValue) return `${formatFixed(value / unitValue / unitValue, 1)}M`;
  if (value >= unitValue) return `${formatFixed(value / unitValue, 1)}K`;
  if (value >= 100) return formatFixed(value, 0);
  if (value >= 10) return formatFixed(value, 1);
  return formatFixed(value, 2);
}

export function formatFixed(value: number, digits: number) {
  return Number.isFinite(value) ? value.toFixed(digits) : "0";
}

export function typeLabel(type: EndpointType, countMode: boolean, processes: ProcessInfo[] = []) {
  const parts = [
    type & TypeBits.publisher ? "Pub" : "---",
    type & TypeBits.subscriber ? "Sub" : undefined,
    type & TypeBits.server ? "Ser" : undefined,
    type & TypeBits.client ? "Cli" : undefined,
    type & TypeBits.setter ? "Set" : undefined,
    type & TypeBits.getter ? "Get" : undefined,
  ].filter((part): part is string => Boolean(part));

  if (!countMode) {
    if (parts.length === 1) {
      return `${parts[0]}|---`;
    }
    return `${parts[0] ?? "---"}|${parts[1] ?? "---"}`;
  }

  const leftCount = processes.filter((process) => (process.type & (TypeBits.publisher | TypeBits.server | TypeBits.setter)) !== 0).length;
  const rightCount = processes.length - leftCount;
  return `${parts[0] ?? "---"}${leftCount}|${parts[1] ?? "---"}${rightCount}`;
}

export function processTypeLabel(type: EndpointType) {
  if (type & TypeBits.publisher) return "Publisher";
  if (type & TypeBits.subscriber) return "Subscriber";
  if (type & TypeBits.server) return "Server";
  if (type & TypeBits.client) return "Client";
  if (type & TypeBits.getter) return "Getter";
  if (type & TypeBits.setter) return "Setter";
  return "Endpoint";
}

export function formatProfiler(processes: ProcessInfo[]) {
  const left = processes
    .filter((process) => (process.type & (TypeBits.publisher | TypeBits.server | TypeBits.setter | TypeBits.client)) !== 0)
    .reduce((sum, process) => sum + (process.profiler ?? 0), 0);
  const right = processes
    .filter((process) => (process.type & (TypeBits.subscriber | TypeBits.getter)) !== 0)
    .reduce((sum, process) => sum + (process.profiler ?? 0), 0);
  if (processes.every((process) => process.profiler === null)) {
    return "---|---";
  }
  return `${formatFixed(left, 2)}%|${formatFixed(right, 2)}%`;
}

export function buildInspectCommand(endpoint: EndpointInfo, options: MonitorOptions) {
  const getter =
    (endpoint.type & TypeBits.getter) !== 0 || ((endpoint.type & TypeBits.setter) !== 0 && (endpoint.type & TypeBits.publisher) === 0);
  const encoding = options.blobMode || endpoint.schemaType === "blob" ? "blob" : endpoint.serType;
  const transport = endpoint.url.split("://")[0] ?? "route";
  const schemaDir = endpoint.schemaType === "flatbuffers" ? options.fbsDir : options.protoDir;
  const dirArg = schemaDir ? ` --schema-dir ${schemaDir}` : "";
  return `pr inspect --transport ${transport} --route ${endpoint.url} --encoding ${encoding}${getter ? " --getter" : ""}${dirArg}${options.protoArgs ? ` ${options.protoArgs}` : ""}`;
}

export function padRight(value: string, width: number) {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}

export function padLeft(value: string, width: number) {
  if (value.length >= width) return value.slice(0, width);
  return " ".repeat(width - value.length) + value;
}

export function center(value: string, width: number) {
  if (value.length >= width) return value.slice(0, width);
  const left = Math.floor((width - value.length) / 2);
  return " ".repeat(left) + value + " ".repeat(width - value.length - left);
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
