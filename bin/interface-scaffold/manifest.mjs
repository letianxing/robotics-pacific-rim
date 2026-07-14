import { relative } from "node:path";
import { rootDir } from "../workspace.mjs";
import { interfaceCompatibility } from "./compatibility.mjs";

export function buildInterfaceManifest({
  moduleName,
  runtimePackage,
  language = "generic",
  goModulePath = "",
  includeRuntimeRegistry = false,
  moduleRoot,
  configPath,
  protocolSources,
  config,
  catalog,
}) {
  const communication = config.communication ?? {};
  const services = communication.services ?? {};
  const topics = communication.topics ?? {};
  const middleware = communication.middleware ?? communication.middlewares ?? {};
  const defaultIdlService = inferDefaultIdlService(config, moduleName);
  validateNoConfigProviders(services, topics);

  const interfaces = [
    ...publicProviderInterfaces(catalog, defaultIdlService, middleware),
    ...Object.entries(services).map(([name, route]) => serviceInterface(name, route, catalog, defaultIdlService, middleware)),
    ...Object.entries(topics).map(([name, route]) => topicInterface(name, route, catalog, defaultIdlService, middleware)),
  ].sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
  for (const iface of interfaces) {
    iface.compatibility = interfaceCompatibility(iface);
  }
  const ddsTypedCodegen = collectDdsTypedCodegen(interfaces);

  return {
    module: moduleName,
    runtimePackage,
    idlService: defaultIdlService,
    language,
    goModulePath,
    includeRuntimeRegistry,
    moduleRoot: relative(rootDir, moduleRoot),
    config: relative(rootDir, configPath),
    protocolSources: protocolSources.map((source) => relative(rootDir, source)),
    ddsTypedCodegen,
    interfaces,
  };
}

function serviceInterface(name, route, catalog, defaultIdlService, middleware) {
  const publicService = resolveServiceRef(route.service_ref, catalog, defaultIdlService);
  route = mergePublicRouteFields(route, publicService, "service");
  const routeNames = routeNamesFor(name, route, null);
  route = normalizeHighLevelRoute("service", route, middleware);
  const contract = route.contract ?? publicService?.contract;
  const serviceType = route.service_type ?? (contract?.format === "ros2_srv" ? contract.type : "");
  const bindings = serviceBindings(route, publicService);
  const role = serviceRole(route);
  const idlService = route.idl_service ? normalizeServiceScope(route.idl_service) : publicService?.idlService ?? defaultIdlService;
  const protocols = [];
  const artifacts = [];
  if (serviceType) {
    addProtocol(protocols, catalog.ros2.services[serviceType] ?? externalProtocol("ros2_srv", serviceType));
    if (catalog.ros2.generatedArtifacts.services[serviceType]) {
      artifacts.push(...catalog.ros2.generatedArtifacts.services[serviceType]);
    }
  }
  const rpc = findProtoRpc(name, serviceType, catalog, idlService);
  if (rpc) {
    addProtocol(protocols, rpc);
  }
  if (contract?.format === "dds_idl_rpc" && contract.type) {
    const ddsRpc = findDdsIdlRpcByType(contract.type, catalog);
    addProtocol(protocols, ddsRpc ?? externalProtocol("dds_idl_rpc", contract.type));
    artifacts.push(...ddsTypedCodegenArtifacts(ddsTypedPlan(ddsRpc ?? externalProtocol("dds_idl_rpc", contract.type), "service", contract.type, defaultIdlService)));
  }
  const ddsTyped = contract?.format === "dds_idl_rpc"
    ? ddsTypedPlan(protocols.find((protocol) => protocol.format === "dds_idl_rpc" && (protocol.fullName === contract.type || protocol.type === contract.type)) ?? externalProtocol("dds_idl_rpc", contract.type), "service", contract.type, defaultIdlService)
    : null;

  return {
    name,
    kind: "service",
    role,
    idlService,
    serviceRef: publicService?.ref ?? route.service_ref ?? "",
    publicService: publicService ? {
      ref: publicService.ref,
      manifest: relative(rootDir, publicService.manifest),
      contract: publicService.contract,
      addresses: publicService.addresses,
      bindings: publicService.bindings,
    } : null,
    routeType: serviceType,
    contract: contract ?? null,
    bindings,
    routeNames: routeNames.length > 0 ? routeNames : routeNamesFor(name, route, bindings),
    protocols,
    artifacts,
    ddsTyped,
    generated: serviceGeneratedPaths(name, role),
  };
}

function topicInterface(name, route, catalog, defaultIdlService, middleware) {
  const publicTopic = resolveTopicRef(route.topic_ref, catalog, defaultIdlService);
  route = mergePublicRouteFields(route, publicTopic, "topic");
  const routeNames = routeNamesFor(name, route, null);
  route = normalizeHighLevelRoute("topic", route, middleware);
  const payload = route.payload ?? publicTopic?.payload;
  const messageType = route.message_type ?? (payload?.format === "ros2_msg" ? payload.type : "");
  const bindings = topicBindings(route, publicTopic);
  const role = topicRole(route, bindings, publicTopic);
  const idlService = route.idl_service ? normalizeServiceScope(route.idl_service) : publicTopic?.idlService ?? defaultIdlService;
  const protocols = [];
  const artifacts = [];
  if (messageType) {
    addProtocol(protocols, catalog.ros2.messages[messageType] ?? externalProtocol("ros2_msg", messageType));
    if (catalog.ros2.generatedArtifacts.messages[messageType]) {
      artifacts.push(...catalog.ros2.generatedArtifacts.messages[messageType]);
    }
  }
  const message = findProtoMessage(name, messageType, catalog, idlService);
  if (message) {
    addProtocol(protocols, message);
  }
  if (payload?.format === "protobuf" && payload.type) {
    const protoMessage = findProtoMessageByType(payload.type, catalog);
    addProtocol(protocols, protoMessage ?? externalProtocol("protobuf_message", payload.type));
  }
  if (payload?.format === "dds_idl" && payload.type) {
    const ddsMessage = findDdsIdlMessageByType(payload.type, catalog);
    addProtocol(protocols, ddsMessage ?? externalProtocol("dds_idl", payload.type));
    artifacts.push(...ddsTypedCodegenArtifacts(ddsTypedPlan(ddsMessage ?? externalProtocol("dds_idl", payload.type), "topic", payload.type, defaultIdlService)));
  }
  const ddsTyped = payload?.format === "dds_idl"
    ? ddsTypedPlan(protocols.find((protocol) => protocol.format === "dds_idl" && (protocol.fullName === payload.type || protocol.type === payload.type)) ?? externalProtocol("dds_idl", payload.type), "topic", payload.type, defaultIdlService)
    : null;

  return {
    name,
    kind: "topic",
    role,
    idlService,
    topicRef: publicTopic?.ref ?? route.topic_ref ?? "",
    publicTopic: publicTopic ? {
      ref: publicTopic.ref,
      manifest: relative(rootDir, publicTopic.manifest),
      payload: publicTopic.payload,
      addresses: publicTopic.addresses,
      bindings: publicTopic.bindings,
    } : null,
    routeType: messageType,
    payload: payload ?? null,
    bindings,
    routeNames: routeNames.length > 0 ? routeNames : routeNamesFor(name, route, bindings),
    protocols,
    artifacts,
    ddsTyped,
    generated: topicGeneratedPaths(name, role),
  };
}

function mergePublicRouteFields(route, publicRoute, kind) {
  if (!publicRoute) {
    return route;
  }
  const merged = { ...route };
  if (merged.data === undefined && publicRoute[kind === "service" ? "contract" : "payload"]?.format) {
    const format = publicRoute[kind === "service" ? "contract" : "payload"].format;
    merged.data = kind === "service" ? publicDataFromContractFormat(format) : publicDataFromPayloadFormat(format);
  }
  if (merged.type === undefined && publicRoute[kind === "service" ? "contract" : "payload"]?.type) {
    merged.type = publicRoute[kind === "service" ? "contract" : "payload"].type;
  }
  if (kind === "service" && merged.contract === undefined && publicRoute.contract) {
    merged.contract = publicRoute.contract;
  }
  if (kind === "topic" && merged.payload === undefined && publicRoute.payload) {
    merged.payload = publicRoute.payload;
  }
  if (merged.addresses === undefined && publicRoute.addresses && Object.keys(publicRoute.addresses).length > 0) {
    merged.addresses = publicRoute.addresses;
  }
  return merged;
}

function publicDataFromPayloadFormat(format) {
  const normalized = normalizeTransport(format);
  if (normalized === "ros2_msg") {
    return "msg";
  }
  if (normalized === "protobuf") {
    return "proto";
  }
  if (normalized === "dds_idl") {
    return "dds_idl";
  }
  return normalized;
}

function publicDataFromContractFormat(format) {
  const normalized = normalizeTransport(format);
  if (normalized === "ros2_srv") {
    return "srv";
  }
  if (normalized === "protobuf_rpc") {
    return "proto";
  }
  if (normalized === "dds_idl_rpc") {
    return "dds_idl";
  }
  return normalized;
}

function serviceGeneratedPaths(name, role) {
  if (role !== "server") {
    return {};
  }
  const fileName = generatedRouteFileName(name);
  return {
    apiHandler: `api/handler/include/${fileName}_api_handler.hpp`,
    service: `service/generated/include/${fileName}_service.hpp`,
  };
}

function topicGeneratedPaths(name, role) {
  if (role !== "publisher") {
    return {};
  }
  const fileName = generatedRouteFileName(name);
  return {
    apiPublisher: `api/publisher/include/${fileName}_api_publisher.hpp`,
    publisherService: `service/generated/include/${fileName}_publisher_service.hpp`,
  };
}

function generatedRouteFileName(name) {
  return String(name ?? "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "route";
}

function externalProtocol(format, type) {
  return {
    format,
    type,
    name: typeLeaf(type),
    external: true,
    fields: [],
    requestFields: [],
    responseFields: [],
  };
}

function publicProviderInterfaces(catalog, defaultIdlService, middleware) {
  const services = uniquePublicRoutes(catalog.publicServices, defaultIdlService)
    .map((route) => serviceInterface(
      route.name,
      providerRouteFromPublic("service", route),
      catalog,
      defaultIdlService,
      middleware,
    ));
  const topics = uniquePublicRoutes(catalog.topics, defaultIdlService)
    .map((route) => topicInterface(
      route.name,
      providerRouteFromPublic("topic", route),
      catalog,
      defaultIdlService,
      middleware,
    ));
  return [...services, ...topics];
}

function uniquePublicRoutes(routes, defaultIdlService) {
  const byRef = new Map();
  for (const route of Object.values(routes ?? {})) {
    if (route?.idlService !== defaultIdlService || !route.ref) {
      continue;
    }
    byRef.set(route.ref, route);
  }
  return [...byRef.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function providerRouteFromPublic(kind, publicRoute) {
  const role = kind === "service" ? "server" : "publish";
  const bindings = publicProviderBindings(kind, publicRoute, role);
  const route = {
    [kind === "service" ? "service_ref" : "topic_ref"]: publicRoute.ref,
    direction: role,
    logical_route: publicRoute.name,
    middlewares: providerBindingMiddlewares(bindings),
    bindings,
  };
  for (const key of ["qos", "metadata", "queue_group", "queue_size", "enabled"]) {
    if (publicRoute[key] !== undefined) {
      route[key] = publicRoute[key];
    }
  }
  return route;
}

function publicProviderBindings(kind, publicRoute, role) {
  const explicitBindings = normalizeBindings(publicRoute.bindings);
  if (explicitBindings.length > 0) {
    return explicitBindings.map((binding) => ({
      ...binding,
      direction: binding.direction ?? role,
      middleware: binding.middleware ?? transportFamilyFromTransportName(binding.transport),
    }));
  }
  const addresses = publicRoute.addresses;
  if (!addresses || typeof addresses !== "object" || Array.isArray(addresses)) {
    return [];
  }
  return Object.entries(addresses)
    .map(([middlewareName, address]) => publicProviderBindingFromAddress(kind, publicRoute, role, middlewareName, address))
    .filter(Boolean);
}

function publicProviderBindingFromAddress(kind, publicRoute, role, middlewareName, address) {
  const family = normalizeTransportProtocol(middlewareName);
  if (!family) {
    return null;
  }
  const schema = kind === "service" ? publicRoute.contract : publicRoute.payload;
  const plan = executionPlan(family, schema?.format ?? "", kind);
  const binding = {
    direction: role,
    middleware: plan.middlewareName,
    transport: plan.transportName,
  };
  copyAddressFields(binding, { addresses: { [family]: address } }, kind, plan);
  applyExecutionMetadata(binding, {}, plan);
  applyDdsTypedExecutionMetadata(binding, schema?.format, schema?.type);
  const adapter = defaultRos2ByteAdapter(kind, binding.transport, schema?.format);
  if (adapter) {
    binding.adapter = adapter;
  }
  return binding;
}

function providerBindingMiddlewares(bindings) {
  return bindings
    .map((binding) => String(binding.middleware || transportFamilyFromTransportName(binding.transport) || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function validateNoConfigProviders(services, topics) {
  const failures = [
    ...providerConfigRoutes("service", services),
    ...providerConfigRoutes("topic", topics),
  ];
  if (failures.length > 0) {
    throw new Error([
      "Provider routes must be defined only in pkg/idl/<service>/public/interfaces.yaml.",
      "module config.yaml may only declare consumer routes with direction client or subscribe.",
      "Move these provider entries out of module config.yaml:",
      ...failures.map((failure) => `- ${failure}`),
    ].join("\n"));
  }
}

function providerConfigRoutes(kind, routes) {
  const failures = [];
  for (const [name, route] of Object.entries(routes ?? {})) {
    if (isProviderConfigRoute(kind, route)) {
      failures.push(`${kind} "${name}"`);
    }
  }
  return failures;
}

function isProviderConfigRoute(kind, route) {
  const direction = String(route?.direction ?? route?.role ?? "").trim().toLowerCase();
  if (!direction) {
    return true;
  }
  if (kind === "service") {
    return !["client", "consumer"].includes(direction);
  }
  return !["subscribe", "subscriber", "in", "consumer"].includes(direction);
}

function ddsTypedPlan(protocol, kind, configuredType, generatedService = "") {
  if (!protocol) {
    return null;
  }
  const type = protocol.fullName || protocol.aliasOf || protocol.type || configuredType || "";
  if (!type) {
    return null;
  }
  const idlService = protocol.idlService || "";
  const outputService = generatedService || idlService;
  const source = protocol.file ? relative(rootDir, protocol.file) : "";
  const plan = {
    mode: "typed_native_dds",
    preference: "typed_preferred",
    fallback: "byte_envelope",
    schemaLanguage: "omg_idl",
    schemaFormat: kind === "service" ? "dds_idl_rpc" : "dds_idl",
    type,
    idlService,
    source,
    codegen: source ? ddsTypedCodegenTargets(idlService, source, type, outputService) : [],
    runtime: {
      selector: "dds.mode=typed_preferred",
      supportKey: type,
      fallback: "dds.fallback=byte_envelope",
    },
    memory: protocol.memory ?? {
      bounded: null,
      loanFriendly: null,
      sharedMemoryFriendly: null,
      unboundedFields: [],
    },
  };
  if (kind === "service") {
    const service = protocol.service || type.split("/")[0]?.split("::").pop() || "";
    const operation = protocol.rpc || type.split("/")[1] || protocol.name || "";
    plan.rpc = {
      service,
      operation,
      requestType: ddsRpcGeneratedType(protocol.module, service, operation, "Request"),
      responseType: ddsRpcGeneratedType(protocol.module, service, operation, "Response"),
      requestFields: protocol.requestFields ?? [],
      responseFields: protocol.responseFields ?? [],
    };
  } else {
    plan.topic = {
      dataType: type,
      fields: protocol.fields ?? [],
    };
  }
  return plan;
}

function ddsRpcGeneratedType(moduleName, service, operation, suffix) {
  const prefix = [service, operation, suffix].filter(Boolean).join("_");
  return moduleName ? `${moduleName}::${prefix}` : prefix;
}

function ddsTypedCodegenTargets(idlService, source, type, outputService = "") {
  const service = outputService || idlService || "unknown_service";
  return [
    {
      format: "dds_typed_codegen_plan",
      middleware: "fastdds",
      language: "cpp",
      generator: "fastddsgen",
      input: source,
      outputDir: `pkg/idl/${service}/generated/dds/fastdds/cpp`,
      type,
    },
    {
      format: "dds_typed_codegen_plan",
      middleware: "cyclonedds",
      language: "cpp",
      generator: "idlc",
      input: source,
      outputDir: `pkg/idl/${service}/generated/dds/cyclonedds/cpp`,
      type,
    },
    {
      format: "dds_typed_codegen_plan",
      middleware: "cyclonedds",
      language: "python",
      generator: "idlc",
      input: source,
      outputDir: `pkg/idl/${service}/generated/dds/cyclonedds/python`,
      type,
    },
  ];
}

function ddsTypedCodegenArtifacts(plan) {
  return plan?.codegen?.map((target) => ({ ...target })) ?? [];
}

function collectDdsTypedCodegen(interfaces) {
  const byKey = new Map();
  for (const iface of interfaces) {
    for (const artifact of iface.artifacts ?? []) {
      if (artifact.format !== "dds_typed_codegen_plan") {
        continue;
      }
      const key = [
        artifact.middleware ?? "",
        artifact.language ?? "",
        artifact.generator ?? "",
        artifact.input ?? "",
        artifact.outputDir ?? "",
      ].join("|");
      const existing = byKey.get(key) ?? {
        ...artifact,
        types: [],
        routeNames: [],
      };
      if (artifact.type && !existing.types.includes(artifact.type)) {
        existing.types.push(artifact.type);
      }
      if (iface.name && !existing.routeNames.includes(iface.name)) {
        existing.routeNames.push(iface.name);
      }
      byKey.set(key, existing);
    }
  }
  return Array.from(byKey.values()).sort((left, right) => [
    left.middleware,
    left.language,
    left.input,
  ].join("|").localeCompare([
    right.middleware,
    right.language,
    right.input,
  ].join("|")));
}

function addProtocol(protocols, protocol) {
  if (!protocol) {
    return;
  }
  const key = protocolKey(protocol);
  if (protocols.some((existing) => protocolKey(existing) === key)) {
    return;
  }
  protocols.push(protocol);
}

function protocolKey(protocol) {
  return [
    protocol.format ?? "",
    protocol.type ?? "",
    protocol.fullName ?? "",
    protocol.service ?? "",
    protocol.rpc ?? "",
    protocol.file ?? "",
    protocol.name ?? "",
  ].join("|");
}

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings)) {
    return [];
  }
  return bindings.map((binding) => ({ ...binding }));
}

function routeNamesFor(name, route, bindings) {
  if (Array.isArray(route.middlewares) && route.middlewares.length > 0) {
    return route.middlewares.map((middleware) => `${name}_${canonicalRouteName(middleware)}`);
  }
  if (route.middleware !== undefined) {
    return [name];
  }
  if (bindings === null) {
    return [];
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return [name];
  }
  return bindings.map((binding, index) => `${name}_${canonicalRouteName(bindingName(binding, index))}`);
}

function bindingName(binding, index) {
  const values = [
    binding.name,
    binding.middleware,
    binding.transport,
    binding.standard,
    binding.service,
    binding.request,
    binding.request_channel,
    binding.response,
    binding.response_channel,
    binding.topic,
    binding.dds_topic,
    binding.subject,
    binding.nats_subject,
    binding.address,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return values.length > 0 ? values.join("_") : `binding_${index}`;
}

function canonicalRouteName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeHighLevelRoute(kind, route, middleware) {
  if (isMultiMiddlewareRoute(route)) {
    return normalizeMultiMiddlewareRoute(kind, route, middleware);
  }
  if (!isHighLevelRoute(route)) {
    return route;
  }
  const normalized = { ...route };
  const data = String(normalized.data ?? normalized.data_format ?? normalized.payload?.format ?? normalized.contract?.format ?? "").trim();
  const schemaType = kind === "service"
    ? String(normalized.contract?.type ?? normalized.type ?? normalized.service_type ?? normalized.message_type ?? normalized.ros_service_type ?? "").trim()
    : String(normalized.payload?.type ?? normalized.type ?? normalized.message_type ?? normalized.msg_type ?? normalized.ros_message_type ?? "").trim();
  const dataKind = kind === "service" ? serviceContractFormatFor(data, schemaType) : topicPayloadFormatFor(data, schemaType);
  const plan = executionPlan(String(normalized.middleware ?? "").trim(), dataKind, kind);
  const binding = {
    transport: plan.transportName,
  };
  if (plan.middlewareName) {
    binding.middleware = plan.middlewareName;
  }
  copyAddressFields(binding, normalized, kind, plan);
  for (const key of ["direction", "role", "queue_group", "queue_size", "qos", "metadata", "enabled"]) {
    if (normalized[key] !== undefined) {
      binding[key] = normalized[key];
    }
  }
  if (kind === "topic") {
    const payload = { ...(normalized.payload ?? {}) };
    payload.format ??= dataKind;
    payload.type ??= schemaType;
    normalized.payload = payload;
    if (payload.format === "ros2_msg" && normalized.message_type === undefined) {
      normalized.message_type = payload.type;
    }
    applyExecutionMetadata(binding, normalized, plan);
    applyDdsTypedExecutionMetadata(binding, payload.format, payload.type);
    const adapter = defaultRos2ByteAdapter("topic", binding.transport, payload.format);
    if (adapter && !adapterFromRoute(normalized)) {
      binding.adapter = adapter;
    }
  } else {
    const contract = { ...(normalized.contract ?? {}) };
    contract.format ??= dataKind;
    contract.type ??= schemaType;
    normalized.contract = contract;
    if (contract.format === "ros2_srv" && normalized.service_type === undefined) {
      normalized.service_type = contract.type;
    }
    applyExecutionMetadata(binding, normalized, plan);
    applyDdsTypedExecutionMetadata(binding, contract.format, contract.type);
    const adapter = defaultRos2ByteAdapter("service", binding.transport, contract.format);
    if (adapter && !adapterFromRoute(normalized)) {
      binding.adapter = adapter;
    }
  }
  normalized.bindings = [binding];
  return normalized;
}

function normalizeMultiMiddlewareRoute(kind, route, middleware) {
  const protocols = Array.isArray(route.middlewares) ? route.middlewares : [];
  const normalized = { ...route };
  delete normalized.middlewares;
  normalized.bindings = protocols.map((protocol) => {
    const single = normalizeHighLevelRoute(kind, { ...route, middleware: protocol, middlewares: undefined }, middleware);
    return { ...(single.bindings?.[0] ?? {}) };
  });
  if (kind === "topic") {
    const data = String(route.data ?? route.data_format ?? route.payload?.format ?? "").trim();
    const schemaType = String(route.payload?.type ?? route.type ?? route.message_type ?? route.msg_type ?? route.ros_message_type ?? "").trim();
    const payload = { ...(route.payload ?? {}) };
    payload.format ??= topicPayloadFormatFor(data, schemaType);
    payload.type ??= schemaType;
    normalized.payload = payload;
    if (payload.format === "ros2_msg" && normalized.message_type === undefined) {
      normalized.message_type = payload.type;
    }
  } else {
    const data = String(route.data ?? route.data_format ?? route.contract?.format ?? "").trim();
    const schemaType = String(route.contract?.type ?? route.type ?? route.service_type ?? route.message_type ?? route.ros_service_type ?? "").trim();
    const contract = { ...(route.contract ?? {}) };
    contract.format ??= serviceContractFormatFor(data, schemaType);
    contract.type ??= schemaType;
    normalized.contract = contract;
    if (contract.format === "ros2_srv" && normalized.service_type === undefined) {
      normalized.service_type = contract.type;
    }
  }
  return normalized;
}

function isHighLevelRoute(route) {
  return Boolean(
    route &&
    (route.data !== undefined || route.data_format !== undefined || route.type !== undefined || route.middleware !== undefined) &&
    route.transport === undefined &&
    !Array.isArray(route.bindings) &&
    !Array.isArray(route.routes),
  );
}

function isMultiMiddlewareRoute(route) {
  return Boolean(
    route &&
    Array.isArray(route.middlewares) &&
    route.middlewares.length > 0 &&
    route.transport === undefined &&
    !Array.isArray(route.bindings) &&
    !Array.isArray(route.routes),
  );
}

function normalizeTransportProtocol(value) {
  const normalized = normalizeTransport(value);
  if (["nats", "nats_topic", "nats_rpc"].includes(normalized)) {
    return "nats";
  }
  if (["cyclonedds", "cyclone_dds"].includes(normalized)) {
    return "cyclonedds";
  }
  if (["fastdds", "fast_dds", "fastrtps", "fast_rtps"].includes(normalized)) {
    return "fastdds";
  }
  if (["ros2", "ros2_topic", "ros2_service"].includes(normalized)) {
    return "ros2";
  }
  return "";
}

function executionPlan(protocol, _dataFormat, kind) {
  const normalizedProtocol = normalizeTransportProtocol(protocol);
  if (!normalizedProtocol) {
    const value = String(protocol ?? "").trim();
    throw new Error(value
      ? `Unsupported high-level route middleware "${value}"; use nats, cyclonedds, fastdds, or ros2`
      : "High-level route middleware is required; use nats, cyclonedds, fastdds, or ros2");
  }
  if (normalizedProtocol === "cyclonedds") {
    const format = kind === "service" ? serviceContractFormat(_dataFormat) : topicPayloadFormat(_dataFormat);
    if (isNativeDdsFormat(format, kind)) {
      return {
        transportName: kind === "service" ? "cyclonedds_rpc" : "cyclonedds_topic",
        middlewareName: "cyclonedds",
        family: "cyclonedds",
        implementation: "native_cyclonedds",
      };
    }
    return {
      transportName: kind === "service" ? "ros2_service" : "ros2_topic",
      middlewareName: "cyclonedds",
      runtimeName: "cyclonedds__rmw",
      family: "cyclonedds",
      implementation: "rmw_cyclonedds",
    };
  }
  if (normalizedProtocol === "fastdds") {
    const format = kind === "service" ? serviceContractFormat(_dataFormat) : topicPayloadFormat(_dataFormat);
    if (isNativeDdsFormat(format, kind)) {
      return {
        transportName: kind === "service" ? "fastdds_rpc" : "fastdds_topic",
        middlewareName: "fastdds",
        family: "fastdds",
        implementation: "native_fastdds",
      };
    }
    return {
      transportName: kind === "service" ? "ros2_service" : "ros2_topic",
      middlewareName: "fastdds",
      runtimeName: "fastdds__rmw",
      family: "fastdds",
      implementation: "rmw_fastrtps",
    };
  }
  if (normalizedProtocol === "ros2") {
    return {
      transportName: kind === "service" ? "ros2_service" : "ros2_topic",
      middlewareName: "ros2",
      family: "ros2",
      implementation: "",
    };
  }
  return {
    transportName: kind === "service" ? "nats_rpc" : "nats_topic",
    middlewareName: "nats",
    family: "nats",
    implementation: "",
  };
}

function isNativeDdsFormat(format, kind) {
  const normalized = normalizeTransport(format);
  if (kind === "service") {
    return ["protobuf_rpc", "dds_idl_rpc"].includes(normalized);
  }
  return ["protobuf", "dds_idl"].includes(normalized);
}

function applyExecutionMetadata(binding, route, plan) {
  const metadata = { ...(route.metadata ?? {}), ...(binding.metadata ?? {}) };
  if (plan.family) {
    metadata["middleware.family"] = plan.family;
  }
  const runtimeName = String(plan.runtimeName || plan.middlewareName || "").trim();
  if (runtimeName) {
    metadata["middleware.runtime"] = runtimeName;
  }
  if (plan.implementation) {
    metadata["middleware.implementation"] = plan.implementation;
    metadata.implementation = plan.implementation;
  }
  if (plan.implementation === "rmw_cyclonedds") {
    metadata.rmw_implementation = "rmw_cyclonedds_cpp";
  } else if (plan.implementation === "rmw_fastrtps") {
    metadata.rmw_implementation = "rmw_fastrtps_cpp";
  }
  if (Object.keys(metadata).length > 0) {
    binding.metadata = metadata;
  }
}

function applyDdsTypedExecutionMetadata(binding, format, type) {
  const normalized = normalizeTransport(format);
  if (normalized !== "dds_idl" && normalized !== "dds_idl_rpc") {
    return;
  }
  const metadata = { ...(binding.metadata ?? {}) };
  metadata["dds.mode"] ??= "typed_preferred";
  metadata["dds.fallback"] ??= "byte_envelope";
  metadata["dds.runtime"] ??= "typed_native";
  metadata["dds.codegen"] ??= "required_for_typed";
  metadata["dds.envelope.type"] ??= "PacificRimMessageEnvelope";
  if (type) {
    metadata["dds.type"] ??= type;
  }
  binding.metadata = metadata;
}

function topicPayloadFormat(data) {
  const normalized = normalizeTransport(data);
  if (["proto", "protobuf", "protobuf_message"].includes(normalized)) {
    return "protobuf";
  }
  if (["msg", "ros2_msg", "rosidl_msg"].includes(normalized)) {
    return "ros2_msg";
  }
  if (["dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl"].includes(normalized)) {
    return "dds_idl";
  }
  if (["bytes", "raw", "cdr", "cdr_bytes"].includes(normalized)) {
    return "bytes";
  }
  return normalized || "bytes";
}

function inferTopicPayloadFormat(type) {
  const value = String(type || "");
  if (value.includes("/msg/")) {
    return "ros2_msg";
  }
  if (value.includes("::")) {
    return "dds_idl";
  }
  return value ? "protobuf" : "";
}

function topicPayloadFormatFor(data, type) {
  if (normalizeTransport(data)) {
    return topicPayloadFormat(data);
  }
  return inferTopicPayloadFormat(type) || topicPayloadFormat(data);
}

function serviceContractFormat(data) {
  const normalized = normalizeTransport(data);
  if (["proto", "protobuf", "protobuf_rpc", "request_reply", "request_response"].includes(normalized)) {
    return "protobuf_rpc";
  }
  if (["srv", "ros2_srv", "rosidl_srv"].includes(normalized)) {
    return "ros2_srv";
  }
  if (["dds_idl", "omg_idl", "omg_dds_idl", "ddsidl", "omgidl", "dds_idl_rpc", "omg_idl_rpc", "omg_dds_rpc_idl"].includes(normalized)) {
    return "dds_idl_rpc";
  }
  if (normalized === "json") {
    return "json_rpc";
  }
  if (["bytes", "raw", "cdr", "cdr_bytes"].includes(normalized)) {
    return "bytes_rpc";
  }
  return normalized || "bytes_rpc";
}

function inferServiceContractFormat(type) {
  const value = String(type || "");
  if (value.includes("/srv/")) {
    return "ros2_srv";
  }
  if (value.includes("::")) {
    return "dds_idl_rpc";
  }
  return value ? "protobuf_rpc" : "";
}

function serviceContractFormatFor(data, type) {
  if (normalizeTransport(data)) {
    return serviceContractFormat(data);
  }
  return inferServiceContractFormat(type) || serviceContractFormat(data);
}

function adapterFromRoute(route) {
  return normalizeTransport(route.adapter ?? route.metadata?.adapter ?? route.metadata?.["ros2.adapter"] ?? "");
}

function copyAddressFields(binding, route, kind, plan) {
  const configuredAddress = addressForMiddleware(route, binding.middleware, plan);
  if (configuredAddress) {
    if (binding.transport === "nats_topic" || binding.transport === "nats_rpc") {
      binding.subject = configuredAddress;
    } else if (kind === "service") {
      binding.service = configuredAddress;
    } else {
      binding.topic = configuredAddress;
    }
  }
  const keys = kind === "service"
    ? ["subject", "nats_subject", "service", "request", "response", "request_channel", "response_channel", "standard", "address"]
    : ["subject", "nats_subject", "topic", "dds_topic", "address"];
  for (const key of keys) {
    if (route[key] !== undefined) {
      binding[key] = route[key];
    }
  }
  if (kind === "service") {
    applyDefaultServiceAddress(binding, route);
  } else {
    applyDefaultTopicAddress(binding, route);
  }
  normalizeRos2BindingAddress(binding, kind);
}

function addressForMiddleware(route, middleware, plan) {
  const addresses = route?.addresses;
  if (!addresses || typeof addresses !== "object" || Array.isArray(addresses)) {
    return "";
  }
  const normalizedMiddleware = normalizeTransport(middleware);
  const keys = [middleware, normalizedMiddleware, transportFamilyFromTransportName(plan?.transportName)].filter(Boolean);
  if (normalizedMiddleware === "fastdds" && !keys.includes("fastdds")) {
    keys.push("fastdds");
  }
  for (const key of keys) {
    if (addresses[key]) {
      return String(addresses[key]).trim();
    }
  }
  return "";
}

function transportFamilyFromTransportName(transportName) {
  const normalized = normalizeTransport(transportName);
  if (normalized === "ros2_topic" || normalized === "ros2_service") {
    return "ros2";
  }
  if (normalized === "cyclonedds_topic" || normalized === "cyclonedds_rpc") {
    return "cyclonedds";
  }
  if (normalized === "fastdds_topic" || normalized === "fastdds_rpc") {
    return "fastdds";
  }
  if (normalized === "nats_topic" || normalized === "nats_rpc") {
    return "nats";
  }
  return "";
}

function applyDefaultTopicAddress(binding, route) {
  if (binding.topic || binding.subject || binding.nats_subject || binding.dds_topic || binding.address) {
    return;
  }
  const routeName = route.logical_route || route.name || route.topic_ref || route.type || "topic";
  if (binding.transport === "nats_topic") {
    binding.subject = `robot.topic.${routeName}`;
  } else if (binding.transport === "ros2_topic") {
    binding.topic = routeName.startsWith("/") ? routeName : `/${routeName.replaceAll(".", "/")}`;
  } else if (binding.transport === "cyclonedds_topic" || binding.transport === "fastdds_topic") {
    binding.topic = routeName.replaceAll("/", ".").replace(/^\.+/, "");
  }
}

function applyDefaultServiceAddress(binding, route) {
  if (binding.service || binding.subject || binding.nats_subject || binding.request || binding.request_channel || binding.address) {
    return;
  }
  const routeName = route.logical_route || route.name || route.service_ref || route.type || "service";
  if (binding.transport === "nats_rpc") {
    binding.subject = `robot.rpc.${routeName}`;
  } else if (binding.transport === "ros2_service") {
    binding.service = routeName.startsWith("/") ? routeName : `/${routeName.replaceAll(".", "/")}`;
  } else if (binding.transport === "cyclonedds_rpc" || binding.transport === "fastdds_rpc") {
    const base = routeName.replaceAll("/", ".").replace(/^\.+/, "");
    binding.request = `${base}.request`;
    binding.response = `${base}.response`;
  }
}

function serviceBindings(route, publicService) {
  const routeBindings = normalizeBindings(route.bindings);
  const publicBindings = normalizeBindings(publicService?.bindings);
  if (routeBindings.length === 0) {
    return annotateDdsTypedBindings(publicBindings.map((binding) => applyRouteBindingOverrides(binding, route, "service")), route, "service");
  }
  if (publicBindings.length === 0) {
    return annotateDdsTypedBindings(routeBindings.map((binding) => applyRouteBindingOverrides(binding, route, "service")), route, "service");
  }
  const merged = routeBindings.map((binding) => {
    const index = publicBindings.findIndex((candidate) => sameTransport(candidate, binding));
    const base = index >= 0 ? publicBindings[index] : {};
    return applyRouteBindingOverrides({ ...base, ...binding }, route, "service");
  });
  return annotateDdsTypedBindings(merged, route, "service");
}

function topicBindings(route, publicTopic) {
  const routeBindings = normalizeBindings(route.bindings);
  const publicBindings = normalizeBindings(publicTopic?.bindings);
  if (routeBindings.length === 0) {
    return annotateDdsTypedBindings(publicBindings.map((binding) => applyRouteBindingOverrides(binding, route, "topic")), route, "topic");
  }
  if (publicBindings.length === 0) {
    return annotateDdsTypedBindings(routeBindings.map((binding) => applyRouteBindingOverrides(binding, route, "topic")), route, "topic");
  }
  const merged = routeBindings.map((binding) => {
    const index = publicBindings.findIndex((candidate) => sameTransport(candidate, binding));
    const base = index >= 0 ? publicBindings[index] : {};
    return applyRouteBindingOverrides({ ...base, ...binding }, route, "topic");
  });
  return annotateDdsTypedBindings(merged, route, "topic");
}

function annotateDdsTypedBindings(bindings, route, kind) {
  const format = kind === "service" ? route.contract?.format : route.payload?.format;
  const type = kind === "service" ? route.contract?.type : route.payload?.type;
  return bindings.map((binding) => {
    const annotated = { ...binding };
    applyDdsTypedExecutionMetadata(annotated, format, type);
    return annotated;
  });
}

function applyRouteBindingOverrides(binding, route, kind) {
  const result = { ...binding };
  const configuredAddress = addressForMiddleware(route, result.middleware, { transportName: result.transport });
  if (configuredAddress && !bindingHasAddress(result, kind)) {
    if (result.transport === "nats_topic" || result.transport === "nats_rpc") {
      result.subject = configuredAddress;
    } else if (kind === "service") {
      result.service = configuredAddress;
    } else {
      result.topic = configuredAddress;
    }
  }
  if (route.direction !== undefined) {
    result.direction = route.direction;
  } else if (route.role !== undefined && result.direction === undefined) {
    result.direction = route.role;
  }
  if (route.adapter !== undefined && result.adapter === undefined) {
    result.adapter = route.adapter;
  }
  const format = kind === "service" ? route.contract?.format : route.payload?.format;
  const adapter = defaultRos2ByteAdapter(kind, result.transport, format);
  if (adapter && result.adapter === undefined && !adapterFromRoute(route)) {
    result.adapter = adapter;
  }
  for (const key of ["queue_group", "queue_size", "enabled", "qos", "metadata"]) {
    if (route[key] !== undefined && result[key] === undefined) {
      result[key] = route[key];
    }
  }
  return result;
}

function bindingHasAddress(binding, kind) {
  if (kind === "service") {
    return Boolean(binding.service || binding.subject || binding.nats_subject || binding.request || binding.request_channel || binding.response || binding.response_channel || binding.address);
  }
  return Boolean(binding.topic || binding.dds_topic || binding.subject || binding.nats_subject || binding.address);
}

function normalizeRos2BindingAddress(binding, kind) {
  if (kind === "topic" && normalizeTransport(binding.transport) === "ros2_topic" && binding.topic !== undefined) {
    binding.topic = ros2Address(binding.topic);
  }
  if (kind === "service" && normalizeTransport(binding.transport) === "ros2_service" && binding.service !== undefined) {
    binding.service = ros2Address(binding.service);
  }
}

function ros2Address(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("/") || text.startsWith("~") || !text.includes(".")) {
    return text;
  }
  return `/${text.replaceAll(".", "/")}`;
}

function defaultRos2ByteAdapter(kind, transport, format) {
  const normalizedTransport = normalizeTransport(transport);
  const normalizedFormat = normalizeTransport(format);
  if (kind === "topic" && normalizedTransport === "ros2_topic") {
    if (normalizedFormat === "protobuf") {
      return "ros2_proto_envelope";
    }
    if (normalizedFormat === "ros2_msg" || normalizedFormat === "rosidl_msg") {
      return "ros2_typed_mapper";
    }
  }
  if (kind === "service" && normalizedTransport === "ros2_service") {
    if (normalizedFormat === "protobuf_rpc") {
      return "ros2_proto_envelope";
    }
    if (normalizedFormat === "ros2_srv" || normalizedFormat === "rosidl_srv") {
      return "ros2_typed_mapper";
    }
  }
  return "";
}

function sameTransport(left, right) {
  const leftTransport = normalizeTransport(left.transport);
  const rightTransport = normalizeTransport(right.transport);
  if (leftTransport && rightTransport && leftTransport === rightTransport) {
    return true;
  }
  const leftAddress = normalizeAddress(left);
  return leftAddress && leftAddress === normalizeAddress(right);
}

function normalizeTransport(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}

function normalizeAddress(binding) {
  return String(binding.topic || binding.subject || binding.service || binding.address || "").trim();
}

function findProtoRpc(name, serviceType, catalog, idlService) {
  const candidates = candidateNames(name, serviceType);
  return Object.values(catalog.protobuf.rpcs).find(
    (rpc) => rpc.idlService === idlService && candidates.has(normalizeName(rpc.rpc)),
  );
}

function findProtoMessage(name, messageType, catalog, idlService) {
  const candidates = candidateNames(name, messageType);
  return Object.values(catalog.protobuf.messages).find(
    (message) => message.idlService === idlService && candidates.has(normalizeName(message.name)),
  );
}

function findProtoMessageByType(type, catalog) {
  return Object.values(catalog.protobuf.messages).find(
    (message) => message.fullName === type || `${message.idlService}.${message.name}` === type,
  );
}

function findDdsIdlMessageByType(type, catalog) {
  return Object.values(catalog.ddsIdl?.messages ?? {}).find(
    (message) => message.fullName === type || message.type === type || `${message.idlService}::${message.name}` === type,
  );
}

function findDdsIdlRpcByType(type, catalog) {
  return Object.values(catalog.ddsIdl?.rpcs ?? {}).find(
    (rpc) => rpc.fullName === type || rpc.type === type,
  );
}

function resolveServiceRef(serviceRef, catalog, defaultIdlService) {
  if (!serviceRef) {
    return null;
  }
  const value = String(serviceRef);
  if (catalog.publicServices[value]) {
    return catalog.publicServices[value];
  }
  const scoped = `${defaultIdlService}.${value}`;
  return catalog.publicServices[scoped] ?? null;
}

function resolveTopicRef(topicRef, catalog, defaultIdlService) {
  if (!topicRef) {
    return null;
  }
  const value = String(topicRef);
  if (catalog.topics[value]) {
    return catalog.topics[value];
  }
  const scoped = `${defaultIdlService}.${value}`;
  return catalog.topics[scoped] ?? null;
}

function serviceRole(route) {
  const direction = String(route.direction || route.role || "server").trim().toLowerCase();
  if (direction === "client" || direction === "consumer") {
    return "client";
  }
  return "server";
}

function topicRole(route, bindings, publicTopic) {
  if (route.publish === true) {
    return "publisher";
  }
  if (route.subscribe === true) {
    return "subscriber";
  }
  const routeBindings = Array.isArray(route.bindings) ? route.bindings : [];
  const candidate = routeBindings.find((binding) => normalizeTransport(binding.transport) !== "ros2_topic")
    ?? bindings.find((binding) => normalizeTransport(binding.transport) !== "ros2_topic")
    ?? routeBindings[0]
    ?? bindings[0];
  const direction = String(
    candidate?.direction ??
    route.direction ??
    publicTopic?.bindings?.find((binding) => sameTransport(binding, candidate ?? {}))?.direction ??
    "publish",
  ).trim().toLowerCase();
  return direction === "subscribe" || direction === "in" ? "subscriber" : "publisher";
}

function inferDefaultIdlService(config, moduleName) {
  const serviceName =
    config.service?.idl_service ??
    config.service?.idl_scope ??
    config.service?.name ??
    config.trace?.service_name ??
    moduleName;
  return normalizeServiceScope(serviceName);
}

function normalizeServiceScope(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "module";
}

function candidateNames(routeName, typeName) {
  const values = new Set([
    normalizeName(routeName),
    normalizeName(toPascalCase(routeName)),
  ]);
  const leaf = typeName ? typeLeaf(typeName) : "";
  if (leaf) {
    values.add(normalizeName(leaf));
    values.add(normalizeName(toPascalCase(leaf)));
  }
  return values;
}

function normalizeName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function typeLeaf(value) {
  return String(value ?? "").split(/[/.]/).filter(Boolean).at(-1) ?? "";
}

function toPascalCase(value) {
  return String(value ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
