import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { asArray, asObject, asString, parseYamlSubset, type YamlObject } from "./yaml.js";
import { TypeBits, type EndpointInfo, type EndpointType, type SchemaType } from "./types.js";

export interface DiscoveryResult {
  endpoints: EndpointInfo[];
  sources: string[];
  errors: string[];
}

interface EndpointDraft {
  type: EndpointType;
  url: string;
  runtimeUrl?: string;
  serType: string;
  schemaType: SchemaType;
  source: string;
  routeName: string;
}

const discoveryGlobs = [
  ["pkg", "idl"],
  ["module", "service"],
] as const;

export async function discoverProjectEndpoints(rootDir = process.cwd()): Promise<DiscoveryResult> {
  const files = await discoverYamlFiles(rootDir);
  const contractIndex = new Map<string, ContractAddress[]>();
  const drafts: EndpointDraft[] = [];
  const sources: string[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const text = await readFile(file, "utf8");
      const parsed = parseYamlSubset(text);
      const relative = path.relative(rootDir, file);
      const before = drafts.length;
      collectInterfaceYaml(parsed, relative, drafts, contractIndex);
      collectCommunicationConfig(parsed, relative, drafts, contractIndex);
      collectBridgeConfig(parsed, relative, drafts);
      if (drafts.length > before) {
        sources.push(relative);
      }
    } catch (error) {
      errors.push(`${path.relative(rootDir, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const hiddenPublicRuntimeUrls = new Set(
    drafts
      .filter((draft) => draft.runtimeUrl && draft.runtimeUrl !== draft.url)
      .map((draft) => draft.runtimeUrl ?? ""),
  );
  const byUrl = new Map<string, EndpointInfo>();
  for (const draft of drafts) {
    if (!draft.runtimeUrl && hiddenPublicRuntimeUrls.has(draft.url) && isPublicInterfaceSource(draft.source)) {
      continue;
    }

    const existing = byUrl.get(draft.url);
    if (!existing) {
      byUrl.set(draft.url, endpointFromDraft(draft));
      continue;
    }

    existing.type |= draft.type;
    if (!existing.runtimeUrl && draft.runtimeUrl) {
      existing.runtimeUrl = draft.runtimeUrl;
    }
    if (existing.serType === "unknown" && draft.serType !== "unknown") {
      existing.serType = draft.serType;
    }
    if (!existing.sources.includes(draft.source)) {
      existing.sources.push(draft.source);
    }
    if (!existing.routeNames.includes(draft.routeName)) {
      existing.routeNames.push(draft.routeName);
    }
  }

  return {
    endpoints: [...byUrl.values()].sort(compareEndpoints),
    sources,
    errors,
  };
}

async function discoverYamlFiles(rootDir: string) {
  const result: string[] = [];
  for (const parts of discoveryGlobs) {
    await walk(path.join(rootDir, ...parts), result);
  }
  return result.filter((file) => {
    const name = path.basename(file);
    return (
      file.endsWith(".yaml") &&
      (name === "interfaces.yaml" ||
        name === "config.yaml" ||
        name === "params.yaml" ||
        name.includes("bridge"))
    );
  });
}

async function walk(dir: string, output: string[]) {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, output);
    } else if (entry.isFile()) {
      output.push(full);
    }
  }
}

interface ContractAddress {
  schemaType: SchemaType;
  serType: string;
  url: string;
  runtimeUrl?: string;
}

function collectInterfaceYaml(
  parsed: YamlObject,
  source: string,
  drafts: EndpointDraft[],
  contractIndex: Map<string, ContractAddress[]>,
) {
  collectInterfaceSection(parsed, "services", source, drafts, contractIndex);
  collectInterfaceSection(parsed, "topics", source, drafts, contractIndex);
}

function collectInterfaceSection(
  parsed: YamlObject,
  sectionName: "services" | "topics",
  source: string,
  drafts: EndpointDraft[],
  contractIndex: Map<string, ContractAddress[]>,
) {
  const section = asObject(parsed[sectionName]);
  if (!section) return;
  const serviceName = idlServiceNameFromSource(source);

  for (const [name, rawRoute] of Object.entries(section)) {
    const route = asObject(rawRoute);
    if (!route) continue;

    const contract = asObject(route.contract) ?? asObject(route.payload);
    const serType = asString(contract?.type) || asString(route.type) || "unknown";
    const schemaType = schemaTypeForFormat(asString(contract?.format) || asString(route.data));
    const role = asString(route.role);
    const direction = asString(route.direction);
    const defaultType = endpointTypeFor(sectionName, role, direction);
    const addresses = asObject(route.addresses);
    const contractAddresses: ContractAddress[] = [];

    if (addresses) {
      for (const [transport, rawAddress] of Object.entries(addresses)) {
        const url = routeUrl(transport, asString(rawAddress));
        if (!url) continue;
        contractAddresses.push({ schemaType, serType, url });
        drafts.push({
          type: defaultType,
          url,
          serType,
          schemaType,
          source,
          routeName: name,
        });
      }
    }

    if (serviceName && contractAddresses.length > 0) {
      contractIndex.set(`${serviceName}.${name}`, contractAddresses);
    }

    for (const rawBinding of asArray(route.bindings)) {
      const binding = asObject(rawBinding);
      if (!binding) continue;
      const url = urlFromBinding(binding);
      if (!url) continue;
      drafts.push({
        type: endpointTypeFor(sectionName, role, asString(binding.direction) || direction) || defaultType,
        url,
        serType,
        schemaType,
        source,
        routeName: name,
      });
    }
  }
}

function collectCommunicationConfig(
  parsed: YamlObject,
  source: string,
  drafts: EndpointDraft[],
  contractIndex: Map<string, ContractAddress[]>,
) {
  const communication = asObject(parsed.communication);
  if (!communication) return;
  collectCommunicationRoutes(asObject(communication.services), "services", source, drafts, contractIndex);
  collectCommunicationRoutes(asObject(communication.topics), "topics", source, drafts, contractIndex);
}

function collectBridgeConfig(parsed: YamlObject, source: string, drafts: EndpointDraft[]) {
  const adapter = asObject(parsed.adapter);
  const communication = asObject(adapter?.communication);
  if (!communication) return;
  collectCommunicationRoutes(asObject(communication.services), "services", source, drafts);
  collectCommunicationRoutes(asObject(communication.topics), "topics", source, drafts);
}

function collectCommunicationRoutes(
  section: YamlObject | undefined,
  sectionName: "services" | "topics",
  source: string,
  drafts: EndpointDraft[],
  contractIndex?: Map<string, ContractAddress[]>,
) {
  if (!section) return;

  for (const [name, rawRoute] of Object.entries(section)) {
    const route = asObject(rawRoute);
    if (!route) continue;

    const routeType = asString(route.service_type) || asString(route.message_type) || asString(asObject(route.payload)?.type) || "unknown";
    const schemaType = schemaTypeForFormat(asString(asObject(route.payload)?.format));
    const directTransport = asString(route.transport);
    const directUrl = urlFromBinding(route);
    if (directTransport && directUrl) {
      drafts.push({
        type: endpointTypeFor(sectionName, "", asString(route.direction)),
        url: directUrl,
        serType: routeType,
        schemaType,
        source,
        routeName: name,
      });
    }
    const bridgedRosUrl = directTransport === "nats_topic" ? routeUrl("ros2", asString(route.ros_topic)) : "";
    if (directTransport && bridgedRosUrl) {
      drafts.push({
        type: endpointTypeFor(sectionName, "", asString(route.direction)),
        url: bridgedRosUrl,
        serType: routeType,
        schemaType,
        source,
        routeName: name,
      });
    }
    const ref = asString(sectionName === "services" ? route.service_ref : route.topic_ref);
    if (ref && contractIndex) {
      const contractAddresses = contractIndex.get(ref) ?? [];
      const middlewares = asArray(route.middlewares).map(asString).filter(Boolean);
      const selectedAddresses =
        middlewares.length > 0
          ? middlewares
              .map((middleware) => addressForMiddleware(contractAddresses, middleware))
              .filter((address): address is ContractAddress => Boolean(address))
          : contractAddresses;

      for (const address of selectedAddresses) {
        drafts.push({
          type: endpointTypeFor(sectionName, "", asString(route.direction)),
          url: address.url,
          runtimeUrl: address.runtimeUrl,
          serType: routeType === "unknown" ? address.serType : routeType,
          schemaType: schemaType === "proto" ? address.schemaType : schemaType,
          source,
          routeName: name,
        });
      }
    }

    for (const rawBinding of asArray(route.bindings)) {
      const binding = asObject(rawBinding);
      if (!binding) continue;
      const url = urlFromBinding(binding);
      if (!url) continue;
      drafts.push({
        type: endpointTypeFor(sectionName, "", asString(binding.direction) || asString(route.direction)),
        url,
        serType: routeType,
        schemaType,
        source,
        routeName: name,
      });
    }
  }
}

function endpointFromDraft(draft: EndpointDraft): EndpointInfo {
  return {
    type: draft.type,
    url: draft.url,
    runtimeUrl: draft.runtimeUrl,
    serType: draft.serType,
    schemaType: draft.schemaType,
    processList: [],
    sources: [draft.source],
    routeNames: [draft.routeName],
  };
}

function urlFromBinding(binding: YamlObject) {
  const transport = asString(binding.transport);
  if (transport === "ros2_service") return routeUrl("ros2", asString(binding.service));
  if (transport === "ros2_topic") return routeUrl("ros2", asString(binding.topic) || asString(binding.ros_topic));
  if (transport === "nats_rpc") return routeUrl("nats", asString(binding.subject));
  if (transport === "nats_topic") return routeUrl("nats", asString(binding.subject));
  if (transport === "grpc") return routeUrl("grpc", asString(binding.service));
  if (transport === "cyclonedds" || transport === "dds_topic") return routeUrl("cyclonedds", asString(binding.topic));
  return "";
}

function routeUrl(scheme: string, value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  return `${scheme}://${normalized.replace(/^\/+/, "")}`;
}

function addressForMiddleware(addresses: ContractAddress[], middleware: string): ContractAddress | undefined {
  const normalized = normalizeMiddleware(middleware);
  if (isCycloneDdsRmwMiddleware(middleware)) {
    const ros2Address = addresses.find((address) => transportFromUrl(address.url) === "ros2");
    if (ros2Address) {
      return {
        ...ros2Address,
        url: replaceUrlScheme(ros2Address.url, "cyclonedds"),
        runtimeUrl: ros2Address.url,
      };
    }
  }

  return addresses.find((address) => transportFromUrl(address.url) === normalized);
}

function normalizeMiddleware(value: string) {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "ros2_topic" || normalized === "ros2_service" || normalized === "rmw_ros2") return "ros2";
  if (normalized === "nats_topic" || normalized === "nats_rpc") return "nats";
  if (normalized === "dds" || normalized === "dds_topic" || normalized === "cyclonedds_topic" || normalized === "cyclonedds_native") {
    return "cyclonedds";
  }
  if (isCycloneDdsRmwMiddleware(normalized)) return "cyclonedds";
  return normalized;
}

function isCycloneDdsRmwMiddleware(value: string) {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return (
    normalized === "cyclonedds" ||
    normalized === "cyclone_dds" ||
    normalized === "rmw_cyclonedds" ||
    normalized === "rmw_cyclonedds_cpp" ||
    normalized === "cyclonedds_rmw" ||
    normalized === "cyclonedds_rmw_cyclonedds"
  );
}

function replaceUrlScheme(url: string, scheme: string) {
  return `${scheme}://${url.replace(/^[a-z0-9+.-]+:\/\//i, "")}`;
}

function transportFromUrl(url: string) {
  return url.split("://")[0] ?? "";
}

function idlServiceNameFromSource(source: string) {
  const match = source.match(/^pkg\/idl\/([^/]+)\/public\/interfaces\.yaml$/);
  return match?.[1] ?? "";
}

function isPublicInterfaceSource(source: string) {
  return /^pkg\/idl\/[^/]+\/public\/interfaces\.yaml$/.test(source);
}

function endpointTypeFor(sectionName: "services" | "topics", role: string, direction: string): EndpointType {
  const normalized = `${role} ${direction}`.toLowerCase();
  if (normalized.includes("client")) return TypeBits.client;
  if (normalized.includes("server")) return TypeBits.server;
  if (normalized.includes("publish")) return TypeBits.publisher;
  if (normalized.includes("subscribe")) return TypeBits.subscriber;
  return sectionName === "services" ? TypeBits.server : TypeBits.publisher;
}

function schemaTypeForFormat(format: string): SchemaType {
  const normalized = format.toLowerCase();
  if (normalized.includes("flat")) return "flatbuffers";
  if (normalized.includes("blob")) return "blob";
  return "proto";
}

function compareEndpoints(left: EndpointInfo, right: EndpointInfo) {
  const leftScheme = left.url.split("://")[0] ?? "";
  const rightScheme = right.url.split("://")[0] ?? "";
  if (leftScheme !== rightScheme) return leftScheme.localeCompare(rightScheme);
  return left.url.localeCompare(right.url);
}
