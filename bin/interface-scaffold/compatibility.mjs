export function interfaceCompatibility(iface) {
  const descriptors = iface.kind === "topic"
    ? topicDescriptors(iface)
    : serviceDescriptors(iface);
  return {
    descriptors,
    warnings: descriptors.flatMap((descriptor) => descriptor.warnings),
  };
}

function topicDescriptors(iface) {
  const schema = schemaFromPayload(iface.payload);
  const codec = codecFromSchema(schema, iface.payload?.codec);
  return iface.bindings.map((binding) => {
    const backend = backendFromBinding(binding);
    const pattern = "pubsub";
    const bindingName = binding.transport || "";
    const adapter = adapterFromBinding(binding);
    const dds = ddsRuntimeDescriptor(iface);
    const warnings = compatibilityWarnings({ schema, codec, backend, pattern, binding: bindingName, adapter, dds });
    return { schema, codec, backend, pattern, binding: bindingName, adapter, dds, warnings };
  });
}

function serviceDescriptors(iface) {
  const schema = schemaFromContract(iface.contract);
  const codec = codecFromSchema(schema, iface.contract?.codec);
  return iface.bindings.map((binding) => {
    const backend = backendFromBinding(binding);
    const pattern = "rpc";
    const bindingName = binding.transport || "";
    const standard = binding.standard || "";
    const adapter = adapterFromBinding(binding);
    const dds = ddsRuntimeDescriptor(iface);
    const warnings = compatibilityWarnings({ schema, codec, backend, pattern, binding: bindingName, standard, adapter, dds });
    return { schema, codec, backend, pattern, binding: bindingName, standard, adapter, dds, warnings };
  });
}

function ddsRuntimeDescriptor(iface) {
  if (!iface.ddsTyped) {
    return null;
  }
  return {
    mode: iface.ddsTyped.mode,
    preference: iface.ddsTyped.preference,
    fallback: iface.ddsTyped.fallback,
    type: iface.ddsTyped.type,
    source: iface.ddsTyped.source,
    memory: iface.ddsTyped.memory,
  };
}

function schemaFromPayload(payload) {
  const format = String(payload?.format || "").toLowerCase();
  if (format === "protobuf") {
    return { language: "protobuf", kind: "message", type: payload?.type || "" };
  }
  if (format === "ros2_msg" || format === "rosidl_msg") {
    return { language: "rosidl", kind: "message", type: payload?.type || "" };
  }
  if (format === "dds_idl" || format === "omg_idl") {
    return { language: "omg_idl", kind: "message", type: payload?.type || "" };
  }
  if (format === "json") {
    return { language: "json_schema", kind: "message", type: payload?.type || "" };
  }
  return { language: format || "unknown", kind: "message", type: payload?.type || "" };
}

function schemaFromContract(contract) {
  const format = String(contract?.format || "").toLowerCase();
  if (format === "protobuf_rpc") {
    return { language: "protobuf", kind: "service", type: contract?.type || "" };
  }
  if (format === "ros2_srv" || format === "rosidl_srv") {
    return { language: "rosidl", kind: "service", type: contract?.type || "" };
  }
  if (format === "dds_idl_rpc" || format === "omg_idl_rpc" || format === "dds_idl" || format === "omg_idl") {
    return { language: "omg_idl", kind: "service", type: contract?.type || "" };
  }
  if (format === "json_rpc") {
    return { language: "json_schema", kind: "service", type: contract?.type || "" };
  }
  return { language: format || "unknown", kind: "service", type: contract?.type || "" };
}

function codecFromSchema(schema, explicitCodec) {
  if (explicitCodec) {
    return String(explicitCodec);
  }
  if (schema.language === "protobuf") {
    return "protobuf";
  }
  if (schema.language === "rosidl") {
    return "cdr";
  }
  if (schema.language === "omg_idl") {
    return "cdr";
  }
  if (schema.language === "json_schema") {
    return "json";
  }
  return "bytes";
}

function backendFromBinding(binding) {
  const family = normalize(binding.metadata?.["middleware.family"] || binding.metadata?.middleware_family);
  if (family) {
    return family;
  }
  const transport = normalize(binding.transport);
  if (transport.startsWith("nats")) {
    return "nats";
  }
  if (transport.startsWith("cyclonedds") || transport.startsWith("dds")) {
    return "cyclonedds";
  }
  if (transport.startsWith("fastdds") || transport.startsWith("fastrtps")) {
    return "fastdds";
  }
  if (transport.startsWith("ros2")) {
    return "ros2";
  }
  if (transport.startsWith("grpc")) {
    return "grpc";
  }
  if (transport.startsWith("zenoh")) {
    return "zenoh";
  }
  if (transport.startsWith("mqtt")) {
    return "mqtt";
  }
  return transport || "unknown";
}

function adapterFromBinding(binding) {
  return normalize(binding.adapter || binding.metadata?.adapter || binding.metadata?.["ros2.adapter"]);
}

function compatibilityWarnings({ schema, codec, backend, pattern, binding, standard, adapter, dds }) {
  const normalizedBinding = normalize(binding);
  const warnings = [];
  const usesRos2ProtoAdapter = adapter === "ros2_proto_envelope" || adapter === "ros2_typed_mapper";
  if (schema.language === "unknown") {
    warnings.push("schema language is unknown; configure payload.format or contract.format");
  }
  if (
    normalizedBinding === "ros2_topic" &&
    !(schema.language === "rosidl" && schema.kind === "message") &&
    !(schema.language === "protobuf" && schema.kind === "message" && usesRos2ProtoAdapter)
  ) {
    warnings.push("ros2_topic is native for rosidl message; other schemas require an adapter");
  }
  if (
    normalizedBinding === "ros2_service" &&
    !(schema.language === "rosidl" && schema.kind === "service") &&
    !(schema.language === "protobuf" && schema.kind === "service" && usesRos2ProtoAdapter)
  ) {
    warnings.push("ros2_service is native for rosidl service; other schemas require an adapter");
  }
  if (backend === "nats" && pattern === "pubsub" && !["protobuf", "cdr", "json", "bytes"].includes(codec)) {
    warnings.push(`nats_topic needs a bytes-compatible codec, got ${codec}`);
  }
  if (backend === "nats" && pattern === "rpc" && !["protobuf", "cdr", "json", "bytes"].includes(codec)) {
    warnings.push(`nats_rpc needs a bytes-compatible request/reply codec, got ${codec}`);
  }
  if (normalizedBinding === "cyclonedds_topic" && !["protobuf", "cdr", "json", "bytes"].includes(codec)) {
    warnings.push(`cyclonedds_topic needs a bytes-compatible codec or typed DDS support, got ${codec}`);
  }
  if (normalizedBinding === "cyclonedds_rpc") {
    if (!["omg_dds_rpc", "rmw_cyclonedds", ""].includes(String(standard))) {
      warnings.push("cyclonedds_rpc standard must be omg_dds_rpc or rmw_cyclonedds");
    }
    if (!["protobuf", "cdr", "json", "bytes"].includes(codec)) {
      warnings.push(`cyclonedds_rpc needs a bytes-compatible request/reply codec or typed DDS support, got ${codec}`);
    }
  }
  if (normalizedBinding === "fastdds_topic" && !["protobuf", "cdr", "json", "bytes"].includes(codec)) {
    warnings.push(`fastdds_topic needs a bytes-compatible codec or typed DDS support, got ${codec}`);
  }
  if (normalizedBinding === "fastdds_rpc") {
    if (!["omg_dds_rpc", ""].includes(String(standard))) {
      warnings.push("fastdds_rpc standard must be omg_dds_rpc");
    }
    if (!["protobuf", "cdr", "json", "bytes"].includes(codec)) {
      warnings.push(`fastdds_rpc needs a bytes-compatible request/reply codec or typed DDS support, got ${codec}`);
    }
  }
  if (dds?.preference === "typed_preferred" && dds.memory?.bounded === false) {
    const fields = (dds.memory.unboundedFields ?? []).join(", ");
    warnings.push(`typed DDS can run, but loan/shared-memory is limited by unbounded fields${fields ? `: ${fields}` : ""}`);
  }
  if (normalizedBinding === "grpc" && schema.language !== "protobuf") {
    warnings.push("grpc is native for protobuf service; other schemas require an adapter");
  }
  return warnings;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replaceAll("-", "_");
}
