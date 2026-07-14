#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { loadProtocolCatalog } from "./interface-scaffold/protocols.mjs";
import { parseYamlSubset } from "./interface-scaffold/yaml.mjs";
import { pathExists, rootDir } from "./workspace.mjs";

await main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.provider || !args.consumer) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const providerRoot = safeModuleRoot(args.provider, "provider");
  const consumerRoot = safeModuleRoot(args.consumer, "consumer");
  const providerConfig = await loadModuleConfig(providerRoot);
  const consumerConfig = await loadModuleConfig(consumerRoot);
  const providerService = providerConfig.service?.name ?? serviceNameFromRoot(providerRoot);
  const consumerService = consumerConfig.service?.name ?? serviceNameFromRoot(consumerRoot);
  const catalog = await loadProtocolCatalog(join(rootDir, "pkg", "idl"));
  const publicRoutes = publicRoutesFor(catalog, providerService, args.kind);
  const consumerRoutes = consumerRoutesFor(consumerConfig, args.kind);
  const matches = matchRoutes(publicRoutes, consumerRoutes, args);

  if (matches.length === 0) {
    throw new Error(
      `No matching ${args.kind || "topic/service"} route from ${providerService} to ${consumerService}. ` +
        "Provider must publish/serve it in pkg/idl/<service>/public, and consumer must reference it from config.yaml.",
    );
  }

  const report = {
    provider: {
      service: providerService,
      root: relative(rootDir, providerRoot),
      config: relative(rootDir, await moduleConfigPath(providerRoot)),
    },
    consumer: {
      service: consumerService,
      root: relative(rootDir, consumerRoot),
      config: relative(rootDir, await moduleConfigPath(consumerRoot)),
    },
    matches: matches.map((match) => ({
      kind: match.publicRoute.kind,
      ref: match.publicRoute.ref,
      consumerRoute: match.consumerRoute.name,
      schema: match.publicRoute.schema,
      publicBindings: match.publicRoute.bindings,
      consumerBindings: match.consumerRoute.bindings,
      sharedTransports: match.sharedTransports,
      notes: match.notes,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv) {
  const args = { kind: "auto", live: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value === "--live") {
      args.live = true;
    } else if (["--provider", "--consumer", "--kind", "--ref", "--transport"].includes(value)) {
      args[value.slice(2)] = argv[++index];
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  if (!["auto", "topic", "service"].includes(args.kind)) {
    throw new Error("--kind must be auto, topic, or service");
  }
  return args;
}

function safeModuleRoot(value, label) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!/^module\/service\/[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`${label} must be module/service/<name>`);
  }
  return resolve(rootDir, normalized);
}

async function loadModuleConfig(moduleRoot) {
  return parseYamlSubset(await readFile(await moduleConfigPath(moduleRoot), "utf8"));
}

async function moduleConfigPath(moduleRoot) {
  const candidates = [
    join(moduleRoot, "src", "config", "config.yaml"),
    join(moduleRoot, "config", "config.yaml"),
    join(moduleRoot, "config.yaml"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Missing config.yaml under ${relative(rootDir, moduleRoot)}`);
}

function serviceNameFromRoot(moduleRoot) {
  return relative(join(rootDir, "module", "service"), moduleRoot).split(/[\\/]/).at(-1);
}

function publicRoutesFor(catalog, providerService, kind) {
  const routes = [];
  if (kind === "auto" || kind === "topic") {
    for (const route of Object.values(catalog.topics || {})) {
      if (route.idlService === providerService) {
        routes.push({
          kind: "topic",
          ref: route.ref,
          name: route.name,
          schema: route.payload,
          bindings: route.bindings || [],
          manifest: route.manifest,
        });
      }
    }
  }
  if (kind === "auto" || kind === "service") {
    for (const route of Object.values(catalog.publicServices || {})) {
      if (route.idlService === providerService) {
        routes.push({
          kind: "service",
          ref: route.ref,
          name: route.name,
          schema: route.contract,
          bindings: route.bindings || [],
          manifest: route.manifest,
        });
      }
    }
  }
  return routes;
}

function consumerRoutesFor(config, kind) {
  const routes = [];
  if (kind === "auto" || kind === "topic") {
    for (const [name, route] of Object.entries(config.communication?.topics || {})) {
      if (route?.topic_ref) {
        routes.push({
          kind: "topic",
          name,
          ref: route.topic_ref,
          schema: route.payload,
          direction: route.direction,
          bindings: route.bindings || [],
        });
      }
    }
  }
  if (kind === "auto" || kind === "service") {
    for (const [name, route] of Object.entries(config.communication?.services || {})) {
      if (route?.service_ref) {
        routes.push({
          kind: "service",
          name,
          ref: route.service_ref,
          schema: route.contract,
          direction: route.direction,
          bindings: route.bindings || [],
        });
      }
    }
  }
  return routes;
}

function matchRoutes(publicRoutes, consumerRoutes, args) {
  return publicRoutes.flatMap((publicRoute) => {
    if (args.ref && publicRoute.ref !== args.ref) {
      return [];
    }
    return consumerRoutes
      .filter((consumerRoute) => consumerRoute.kind === publicRoute.kind && consumerRoute.ref === publicRoute.ref)
      .map((consumerRoute) => validateRoutePair(publicRoute, consumerRoute, args))
      .filter(Boolean);
  });
}

function validateRoutePair(publicRoute, consumerRoute, args) {
  const notes = [];
  const expectedDirection = publicRoute.kind === "topic" ? "subscribe" : "client";
  if (consumerRoute.direction && consumerRoute.direction !== expectedDirection) {
    notes.push(`consumer direction is ${consumerRoute.direction}; expected ${expectedDirection}`);
  }
  if (consumerRoute.schema) {
    notes.push("consumer overrides schema from public interface");
  }
  const publicTransports = transportMap(publicRoute.bindings);
  const consumerTransports = transportMap(consumerRoute.bindings);
  const sharedTransports = [...publicTransports.keys()].filter((transport) => consumerTransports.has(transport));
  const requestedTransport = args.transport ? normalizeTransport(args.transport) : "";
  if (requestedTransport && !sharedTransports.includes(requestedTransport)) {
    return null;
  }
  if (sharedTransports.length === 0 && publicRoute.bindings.length > 0 && consumerRoute.bindings.length > 0) {
    throw new Error(`${publicRoute.ref} has no shared transport between public interface and consumer config`);
  }
  for (const transport of sharedTransports) {
    validateCompatibility(
      publicRoute.kind,
      publicRoute.schema,
      transport,
      publicTransports.get(transport),
      consumerTransports.get(transport),
    );
  }
  return { publicRoute, consumerRoute, sharedTransports, notes };
}

function transportMap(bindings = []) {
  const map = new Map();
  for (const binding of bindings) {
    const transport = normalizeTransport(binding?.transport);
    if (transport) {
      map.set(transport, binding);
    }
  }
  return map;
}

function normalizeTransport(value) {
  return String(value || "").trim().replace(/-/g, "_");
}

function isRos2ProtoAdapter(adapter) {
  return adapter === "ros2_proto_envelope" || adapter === "ros2_typed_mapper";
}

function validateCompatibility(kind, schema, transport, publicBinding = {}, consumerBinding = {}) {
  const format = String(schema?.format || "").trim();
  if (!format) {
    return;
  }
  const adapter = normalizeTransport(
    consumerBinding?.adapter ||
    consumerBinding?.metadata?.adapter ||
    consumerBinding?.metadata?.["ros2.adapter"] ||
    publicBinding?.adapter ||
    publicBinding?.metadata?.adapter ||
    publicBinding?.metadata?.["ros2.adapter"],
  );
  if (
    kind === "topic" &&
    transport === "ros2_topic" &&
    !["ros2_msg", "rosidl_msg"].includes(format) &&
    !(format === "protobuf" && isRos2ProtoAdapter(adapter))
  ) {
    throw new Error("ros2_topic requires ros2_msg/rosidl_msg payload unless a proto adapter is explicitly implemented");
  }
  if (
    kind === "service" &&
    transport === "ros2_service" &&
    !["ros2_srv", "rosidl_srv"].includes(format) &&
    !(format === "protobuf_rpc" && isRos2ProtoAdapter(adapter))
  ) {
    throw new Error("ros2_service requires ros2_srv/rosidl_srv contract unless an adapter is explicitly implemented");
  }
  if (kind === "service" && transport === "grpc" && format !== "protobuf_rpc") {
    throw new Error("grpc requires protobuf_rpc contract");
  }
  if (
    ["fastdds_topic", "cyclonedds_topic", "dds_topic"].includes(transport) &&
    format &&
    !["protobuf", "dds_idl", "ros2_msg", "rosidl_msg", "bytes"].includes(format)
  ) {
    throw new Error("native DDS topic requires protobuf, dds_idl, ros2_msg, or bytes-compatible payload");
  }
  if (
    ["fastdds_rpc", "cyclonedds_rpc", "dds_rpc"].includes(transport) &&
    format &&
    !["protobuf_rpc", "dds_idl_rpc", "ros2_srv", "rosidl_srv", "bytes_rpc"].includes(format)
  ) {
    throw new Error("native DDS RPC requires protobuf_rpc, dds_idl_rpc, ros2_srv, or bytes-compatible contract");
  }
}

function printUsage() {
  console.log(`Pacific-Rim communication pair test

Usage:
  node bin/test-communication-pair.mjs --provider module/service/foo_service --consumer module/service/bar_service
  node bin/test-communication-pair.mjs --provider module/service/foo_service --consumer module/service/bar_service --kind topic --ref foo_service.robot_state
  node bin/test-communication-pair.mjs --provider module/service/foo_service --consumer module/service/bar_service --kind service --transport cyclonedds_rpc

The check validates real project config/public pkg alignment. It does not
replace end-to-end business assertions inside running services.
`);
}
