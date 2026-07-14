import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { collectFiles } from "./file-walk.mjs";
import { parseGeneratedArtifactFile, isGeneratedArtifactCandidate } from "./generated-artifacts.mjs";
import { parseDdsIdlFile } from "./dds-idl-parser.mjs";
import { parseProtoFile } from "./proto-parser.mjs";
import { parseRos2Message, parseRos2Service } from "./ros2-source-parser.mjs";
import { parseYamlSubset } from "./yaml.mjs";

export async function loadProtocolCatalog(protocolSources) {
  const sources = Array.isArray(protocolSources) ? protocolSources : [protocolSources];
  const catalog = emptyCatalog();

  for (const source of sources) {
    const files = await collectFiles(source);
    for (const file of files) {
      if (file.endsWith(".proto")) {
        mergeProtoCatalog(catalog.protobuf, await parseProtoFile(source, file));
      } else if (file.endsWith(".idl")) {
        mergeDdsIdlCatalog(catalog.ddsIdl, await parseDdsIdlFile(source, file));
      } else if (file.endsWith(".msg")) {
        addRos2SourceProtocol(catalog.ros2.messages, await parseRos2Message(source, file));
      } else if (file.endsWith(".srv")) {
        addRos2SourceProtocol(catalog.ros2.services, await parseRos2Service(source, file));
      } else if (isPublicInterfaceManifest(source, file)) {
        mergePublicInterfaceCatalog(catalog, await parsePublicInterfaceManifest(source, file));
      } else if (isGeneratedArtifactCandidate(file)) {
        mergeGeneratedArtifactCatalog(catalog.ros2, await parseGeneratedArtifactFile(source, file));
      }
    }
  }

  return catalog;
}

function emptyCatalog() {
  return {
    protobuf: {
      files: [],
      messages: {},
      rpcs: {},
    },
    ddsIdl: {
      files: [],
      messages: {},
      rpcs: {},
    },
    topics: {},
    publicServices: {},
    ros2: {
      messages: {},
      services: {},
      generatedArtifacts: {
        messages: {},
        services: {},
      },
    },
  };
}

function mergeProtoCatalog(target, source) {
  target.files.push(...source.files);
  Object.assign(target.messages, source.messages);
  Object.assign(target.rpcs, source.rpcs);
}

function mergeDdsIdlCatalog(target, source) {
  target.files.push(...source.files);
  Object.assign(target.messages, source.messages);
  Object.assign(target.rpcs, source.rpcs);
}

function mergeGeneratedArtifactCatalog(target, source) {
  mergeArtifacts(target.generatedArtifacts.messages, source.messages);
  mergeArtifacts(target.generatedArtifacts.services, source.services);
}

function addRos2SourceProtocol(target, item) {
  target[item.type] = item;
  for (const alias of item.aliases ?? []) {
    if (!target[alias]) {
      target[alias] = { ...item, type: alias, aliasOf: item.type };
    }
  }
}

function mergePublicInterfaceCatalog(target, source) {
  Object.assign(target.topics, source.topics);
  Object.assign(target.publicServices, source.services);
}

function mergeArtifacts(target, source) {
  for (const [type, artifacts] of Object.entries(source)) {
    target[type] ??= [];
    for (const artifact of artifacts) {
      if (!target[type].some((item) => item.file === artifact.file && item.language === artifact.language)) {
        target[type].push(artifact);
      }
    }
  }
}

function isPublicInterfaceManifest(protocolsDir, file) {
  const parts = relative(protocolsDir, file).replaceAll("\\", "/").split("/");
  return (parts.includes("public") || parts.includes("topics")) && /\.ya?ml$/.test(file);
}

async function parsePublicInterfaceManifest(protocolsDir, file) {
  const manifest = parseYamlSubset(await readFile(file, "utf8"));
  const idlService = idlServiceName(protocolsDir, file);
  return {
    topics: parsePublicTopics(manifest, file, idlService),
    services: parsePublicServices(manifest, idlService, file),
  };
}

function parsePublicTopics(manifest, file, idlService) {
  const topics = {};
  for (const [name, route] of topicEntries(manifest, file)) {
    const payload = normalizePayload(route);
    const topic = {
      format: "topic",
      name,
      idlService,
      ref: `${idlService}.${name}`,
      manifest: file,
      payload,
      addresses: normalizeAddresses(route.addresses),
      bindings: normalizeBindings(route.bindings),
      ...publicRouteOptions(route),
    };
    topics[topic.ref] = topic;
    for (const ref of publicBindingRefs(topic, false)) {
      addPublicRouteAlias(topics, ref, topic);
    }
  }
  return topics;
}

function parsePublicServices(manifest, idlService, file) {
  const services = {};
  if (!manifest.services || typeof manifest.services !== "object" || Array.isArray(manifest.services)) {
    return services;
  }
  for (const [name, route] of Object.entries(manifest.services)) {
    const contract = normalizeContract(route);
    const service = {
      format: "service",
      name,
      idlService,
      ref: `${idlService}.${name}`,
      manifest: file,
      contract,
      addresses: normalizeAddresses(route.addresses),
      bindings: normalizeBindings(route.bindings),
      ...publicRouteOptions(route),
    };
    services[service.ref] = service;
    for (const ref of publicBindingRefs(service, true)) {
      addPublicRouteAlias(services, ref, service);
    }
  }
  return services;
}

function publicBindingRefs(route, serviceRoute) {
  const refs = [];
  const add = (value) => {
    const ref = String(value || "").trim();
    if (ref && !refs.includes(ref)) {
      refs.push(ref);
    }
  };
  if (serviceRoute) {
    add(route.service);
    add(route.ros_service);
  } else {
    add(route.topic);
    add(route.ros_topic);
  }
  add(route.address);
  if (route.addresses && typeof route.addresses === "object" && !Array.isArray(route.addresses)) {
    for (const value of Object.values(route.addresses)) {
      add(value);
    }
  }
  for (const binding of route.bindings ?? []) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      continue;
    }
    if (serviceRoute) {
      add(binding.service);
      add(binding.ros_service);
    } else {
      add(binding.topic);
      add(binding.ros_topic);
    }
    add(binding.address);
  }
  return refs;
}

function addPublicRouteAlias(catalog, ref, route) {
  const normalized = String(ref || "").trim();
  if (normalized && !catalog[normalized]) {
    catalog[normalized] = route;
  }
}

function topicEntries(manifest, file) {
  if (manifest.topics && typeof manifest.topics === "object" && !Array.isArray(manifest.topics)) {
    return Object.entries(manifest.topics);
  }
  if (manifest.services && typeof manifest.services === "object") {
    return [];
  }
  const name = manifest.name || basename(file).replace(/\.[^.]+$/, "");
  return [[name, manifest]];
}

function normalizePayload(route) {
  if (route.data || route.type) {
    const type = route.type || route.message_type || "";
    return {
      format: route.data ? topicPayloadFormat(route.data) : inferPayloadFormat(type),
      type,
    };
  }
  if (route.payload && typeof route.payload === "object" && !Array.isArray(route.payload)) {
    return {
      format: route.payload.format || inferPayloadFormat(route.payload.type),
      type: route.payload.type || "",
    };
  }
  const messageType = route.message_type || "";
  return {
    format: messageType ? "ros2_msg" : "",
    type: messageType,
  };
}

function normalizeContract(route) {
  if (route.data || route.type) {
    const type = route.type || route.service_type || "";
    return {
      format: route.data ? serviceContractFormat(route.data) : inferContractFormat(type),
      type,
      responseType: route.response_type || route.responseType || "",
    };
  }
  if (route.contract && typeof route.contract === "object" && !Array.isArray(route.contract)) {
    return {
      format: route.contract.format || inferContractFormat(route.contract.type),
      type: route.contract.type || "",
      responseType: route.contract.response_type || route.contract.responseType || "",
    };
  }
  const serviceType = route.service_type || "";
  return {
    format: serviceType ? "ros2_srv" : "",
    type: serviceType,
    responseType: "",
  };
}

function topicPayloadFormat(data) {
  const normalized = normalizeToken(data);
  if (["msg", "ros2_msg", "rosidl_msg"].includes(normalized)) {
    return "ros2_msg";
  }
  if (["proto", "protobuf", "protobuf_message"].includes(normalized)) {
    return "protobuf";
  }
  if (["dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl"].includes(normalized)) {
    return "dds_idl";
  }
  if (["bytes", "raw", "cdr", "cdr_bytes"].includes(normalized)) {
    return "bytes";
  }
  return normalized || "";
}

function serviceContractFormat(data) {
  const normalized = normalizeToken(data);
  if (["srv", "ros2_srv", "rosidl_srv"].includes(normalized)) {
    return "ros2_srv";
  }
  if (["proto", "protobuf", "protobuf_rpc", "request_reply", "request_response"].includes(normalized)) {
    return "protobuf_rpc";
  }
  if (["dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl", "dds_idl_rpc", "omg_idl_rpc", "omg_dds_rpc_idl"].includes(normalized)) {
    return "dds_idl_rpc";
  }
  if (["bytes", "raw", "cdr", "cdr_bytes"].includes(normalized)) {
    return "bytes_rpc";
  }
  return normalized || "";
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings)) {
    return [];
  }
  return bindings.map((binding) => ({ ...binding }));
}

function normalizeAddresses(addresses) {
  if (!addresses || typeof addresses !== "object" || Array.isArray(addresses)) {
    return {};
  }
  return { ...addresses };
}

function publicRouteOptions(route) {
  const options = {};
  for (const key of ["qos", "metadata", "queue_group", "queue_size", "enabled"]) {
    if (route?.[key] !== undefined) {
      options[key] = cloneRouteOption(route[key]);
    }
  }
  return options;
}

function cloneRouteOption(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneRouteOption(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneRouteOption(item)]));
  }
  return value;
}

function inferContractFormat(type) {
  const value = String(type || "");
  if (value.includes("/srv/")) {
    return "ros2_srv";
  }
  if (value.includes("::")) {
    return "dds_idl_rpc";
  }
  if (value) {
    return "protobuf_rpc";
  }
  return "";
}

function inferPayloadFormat(type) {
  const value = String(type || "");
  if (value.includes("/msg/")) {
    return "ros2_msg";
  }
  if (value.includes("::")) {
    return "dds_idl";
  }
  if (value) {
    return "protobuf";
  }
  return "";
}

function idlServiceName(protocolsDir, file) {
  const parts = relative(protocolsDir, file).replaceAll("\\", "/").split("/").filter(Boolean);
  return parts[0] || "unknown_service";
}
