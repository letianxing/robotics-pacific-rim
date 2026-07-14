export const TypeBits = {
  publisher: 1 << 0,
  subscriber: 1 << 1,
  server: 1 << 2,
  client: 1 << 3,
  setter: 1 << 4,
  getter: 1 << 5,
} as const;

export type EndpointType = number;
export type SchemaType = "proto" | "flatbuffers" | "blob";

export interface ProcessInfo {
  type: EndpointType;
  host: string;
  ip: string;
  name: string;
  pid: number;
  profiler: number | null;
}

export interface EndpointInfo {
  type: EndpointType;
  url: string;
  runtimeUrl?: string;
  serType: string;
  schemaType: SchemaType;
  processList: ProcessInfo[];
  sources: string[];
  routeNames: string[];
}
