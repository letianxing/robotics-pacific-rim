#pragma once

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "infra/communication/cpp/core/security.hpp"
#include "pacific_rim/communication/contracts.hpp"
#include "yaml-cpp/yaml.h"

namespace pacific_rim::communication::core {

struct ServiceCommunicationConfig {
  std::map<std::string, MiddlewareConfig> middleware;
  std::vector<PubSubRoute> pubsub_routes;
  std::vector<RpcRoute> rpc_routes;
  std::string trace_service_name;
  bool require_explicit_security_profile{false};
  std::map<std::string, SecurityProfile> security_profiles;
};

struct PublicInterfaceCatalog {
  std::map<std::string, YAML::Node> topics;
  std::map<std::string, YAML::Node> services;
};

struct RouteExecutionPlan {
  TransportKind transport{TransportKind::kInProcess};
  std::string transport_name;
  std::string middleware_name;
  std::string runtime_name;
  std::string family;
  std::string implementation;
  std::map<std::string, std::string> options;
};

inline std::string RuntimeMiddlewareName(const RouteExecutionPlan& plan) {
  return plan.runtime_name.empty() ? plan.middleware_name : plan.runtime_name;
}

inline std::map<std::string, std::string> MergeOptions(
    const std::map<std::string, std::string>& base,
    const std::map<std::string, std::string>& overlay) {
  auto out = base;
  for (const auto& [key, value] : overlay) {
    out[key] = value;
  }
  return out;
}

inline TransportKind TransportFromString(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (value == "ros2" || value == "ros2_topic" || value == "ros2_service") {
    return TransportKind::kRos2;
  }
  if (value == "nats" || value == "nats_topic" || value == "nats_rpc") {
    return TransportKind::kNats;
  }
  if (value == "dds" || value == "cyclonedds" || value == "cyclone_dds" ||
      value == "dds_topic" || value == "cyclonedds_topic" ||
      value == "dds_rpc" || value == "cyclonedds_rpc") {
    return TransportKind::kCycloneDds;
  }
  if (value == "fastdds" || value == "fast_dds" || value == "fastrtps" ||
      value == "fast_rtps" || value == "fastdds_topic" ||
      value == "fastdds_rpc") {
    return TransportKind::kFastDds;
  }
  if (value == "zenoh") {
    return TransportKind::kZenoh;
  }
  if (value == "grpc") {
    return TransportKind::kGrpc;
  }
  if (value == "mqtt") {
    return TransportKind::kMqtt;
  }
  if (value.empty() || value == "in_process") {
    return TransportKind::kInProcess;
  }
  throw std::invalid_argument("unsupported communication middleware " + value);
}

inline TransportKind OptionalTransportFromString(std::string value) {
  if (value.empty()) {
    return TransportKind::kInProcess;
  }
  return TransportFromString(std::move(value));
}

inline TransportKind RouteTransportFromString(
    const std::string& value,
    const std::string& fallback) {
  return TransportFromString(value.empty() ? fallback : value);
}

inline TransportKind MiddlewareTransportFromString(
    const std::string& name,
    const std::string& transport_name) {
  if (!transport_name.empty()) {
    return TransportFromString(transport_name);
  }
  if (!name.empty()) {
    return TransportFromString(name);
  }
  return TransportKind::kInProcess;
}

inline std::string Scalar(const YAML::Node& node, const std::string& key) {
  YAML::Node value;
  try {
    if (!node || !node.IsDefined()) {
      return "";
    }
    value = node[key];
  } catch (...) {
    return "";
  }
  if (!value || !value.IsDefined() || !value.IsScalar()) {
    return "";
  }
  try {
    return value.as<std::string>();
  } catch (...) {
    return "";
  }
}

inline bool Enabled(const YAML::Node& node) {
  return !node["enabled"] || node["enabled"].as<bool>();
}

inline bool BoolValue(const YAML::Node& node, const std::string& key, bool fallback = false) {
  if (!node[key]) {
    return fallback;
  }
  try {
    return node[key].as<bool>();
  } catch (...) {
    return fallback;
  }
}

inline std::string FirstNonEmpty(std::initializer_list<std::string> values) {
  for (const auto& value : values) {
    if (!value.empty()) {
      return value;
    }
  }
  return "";
}

inline std::string TrimCopy(std::string value) {
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), [](unsigned char ch) {
    return !std::isspace(ch);
  }));
  value.erase(std::find_if(value.rbegin(), value.rend(), [](unsigned char ch) {
    return !std::isspace(ch);
  }).base(), value.end());
  return value;
}

inline std::vector<std::string> PublicBindingRefs(const YAML::Node& route, bool service_route) {
  std::vector<std::string> refs;
  auto add = [&refs](const std::string& value) {
    const auto ref = TrimCopy(value);
    if (!ref.empty() && std::find(refs.begin(), refs.end(), ref) == refs.end()) {
      refs.push_back(ref);
    }
  };
  if (service_route) {
    add(Scalar(route, "service"));
    add(Scalar(route, "ros_service"));
  } else {
    add(Scalar(route, "topic"));
    add(Scalar(route, "ros_topic"));
  }
  add(Scalar(route, "address"));
  const auto addresses = route["addresses"];
  if (addresses && addresses.IsMap()) {
    for (const auto& item : addresses) {
      add(item.second.as<std::string>(""));
    }
  }
  const auto bindings = route["bindings"];
  if (bindings && bindings.IsSequence()) {
    for (const auto& binding : bindings) {
      if (!binding || !binding.IsMap()) {
        continue;
      }
      if (service_route) {
        add(Scalar(binding, "service"));
        add(Scalar(binding, "ros_service"));
      } else {
        add(Scalar(binding, "topic"));
        add(Scalar(binding, "ros_topic"));
      }
      add(Scalar(binding, "address"));
    }
  }
  return refs;
}

inline void AddPublicRouteAlias(
    std::map<std::string, YAML::Node>* catalog,
    const std::string& ref,
    const YAML::Node& route) {
  const auto normalized_ref = TrimCopy(ref);
  if (catalog == nullptr || normalized_ref.empty()) {
    return;
  }
  if (catalog->count(normalized_ref) == 0) {
    (*catalog)[normalized_ref] = route;
  }
}

inline std::string PayloadType(const YAML::Node& node) {
  const auto payload = node["payload"];
  if (!payload || !payload.IsMap()) {
    return "";
  }
  return Scalar(payload, "type");
}

inline std::string ContractType(const YAML::Node& node) {
  const auto contract = node["contract"];
  if (!contract || !contract.IsMap()) {
    return "";
  }
  return Scalar(contract, "type");
}

inline std::string NormalizeToken(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

inline void ApplyMiddlewareTransportDefaults(
    std::map<std::string, std::string>* options,
    const std::string& transport_name) {
  if (options == nullptr) {
    return;
  }
  const auto normalized = NormalizeToken(transport_name);
  auto put_if_absent = [options](const std::string& key, const std::string& value) {
    if (options->find(key) == options->end()) {
      (*options)[key] = value;
    }
  };
  if (normalized == "fastdds" || normalized == "fast_dds" ||
             normalized == "fastrtps" || normalized == "fast_rtps" ||
             normalized == "fastdds_topic" ||
             normalized == "fastdds_rpc") {
    put_if_absent("middleware.family", "fastdds");
    put_if_absent("implementation", "native_fastdds");
  }
}

inline std::string RouteName(std::string value) {
  for (auto& ch : value) {
    if (!std::isalnum(static_cast<unsigned char>(ch))) {
      ch = '_';
    }
  }
  while (!value.empty() && value.front() == '_') {
    value.erase(value.begin());
  }
  while (!value.empty() && value.back() == '_') {
    value.pop_back();
  }
  return value;
}

inline void AddBindingPart(std::vector<std::string>* parts, const std::string& value) {
  if (!value.empty()) {
    parts->push_back(value);
  }
}

inline std::string JoinBindingParts(const std::vector<std::string>& parts) {
  std::string out;
  for (const auto& part : parts) {
    if (part.empty()) {
      continue;
    }
    if (!out.empty()) {
      out += "_";
    }
    out += part;
  }
  return out;
}

inline std::string TopicBindingName(const YAML::Node& node, int index) {
  std::vector<std::string> parts;
  AddBindingPart(&parts, Scalar(node, "name"));
  AddBindingPart(&parts, Scalar(node, "middleware"));
  AddBindingPart(&parts, Scalar(node, "transport"));
  AddBindingPart(&parts, Scalar(node, "topic"));
  AddBindingPart(&parts, Scalar(node, "dds_topic"));
  AddBindingPart(&parts, Scalar(node, "subject"));
  AddBindingPart(&parts, Scalar(node, "nats_subject"));
  AddBindingPart(&parts, Scalar(node, "address"));
  const auto joined = JoinBindingParts(parts);
  return joined.empty() ? std::to_string(index) : joined;
}

inline std::string ServiceBindingName(const YAML::Node& node, int index) {
  std::vector<std::string> parts;
  AddBindingPart(&parts, Scalar(node, "name"));
  AddBindingPart(&parts, Scalar(node, "middleware"));
  AddBindingPart(&parts, Scalar(node, "transport"));
  AddBindingPart(&parts, Scalar(node, "standard"));
  AddBindingPart(&parts, Scalar(node, "service"));
  AddBindingPart(&parts, Scalar(node, "request"));
  AddBindingPart(&parts, Scalar(node, "request_channel"));
  AddBindingPart(&parts, Scalar(node, "response"));
  AddBindingPart(&parts, Scalar(node, "response_channel"));
  AddBindingPart(&parts, Scalar(node, "subject"));
  AddBindingPart(&parts, Scalar(node, "nats_subject"));
  AddBindingPart(&parts, Scalar(node, "address"));
  const auto joined = JoinBindingParts(parts);
  return joined.empty() ? std::to_string(index) : joined;
}

inline void FlattenScalarMap(
    const YAML::Node& node,
    const std::string& prefix,
    std::map<std::string, std::string>* target) {
  if (!node || target == nullptr) {
    return;
  }
  if (node.IsScalar()) {
    try {
      (*target)[prefix] = node.as<std::string>();
    } catch (...) {
    }
    return;
  }
  if (!node.IsMap()) {
    return;
  }
  for (const auto& item : node) {
    const auto key = item.first.as<std::string>();
    const auto flattened_key = prefix.empty() ? key : prefix + "." + key;
    FlattenScalarMap(item.second, flattened_key, target);
  }
}

inline std::map<std::string, std::string> Metadata(
    const YAML::Node& node,
    const std::string& logical_route,
    const std::string& binding_name) {
  std::map<std::string, std::string> metadata;
  if (node["metadata"]) {
    FlattenScalarMap(node["metadata"], "", &metadata);
  }
  if (node["qos"]) {
    FlattenScalarMap(node["qos"], "qos", &metadata);
  }
  if (node["security_profile"]) {
    metadata["security.profile"] = node["security_profile"].as<std::string>();
  }
  if (node["middleware"]) {
    metadata["middleware"] = node["middleware"].as<std::string>();
  }
  const auto adapter = FirstNonEmpty({
      Scalar(node, "adapter"),
      metadata.count("adapter") ? metadata["adapter"] : "",
      metadata.count("ros2.adapter") ? metadata["ros2.adapter"] : "",
  });
  if (!adapter.empty()) {
    metadata["adapter"] = NormalizeToken(adapter);
    metadata["ros2.adapter"] = NormalizeToken(adapter);
  }
  const auto ros_message_type = Scalar(node, "ros_message_type");
  if (!ros_message_type.empty()) {
    metadata["ros_message_type"] = ros_message_type;
    metadata["ros2.message_type"] = ros_message_type;
  }
  const auto ros_service_type = Scalar(node, "ros_service_type");
  if (!ros_service_type.empty()) {
    metadata["ros_service_type"] = ros_service_type;
    metadata["ros2.service_type"] = ros_service_type;
  }
  const auto payload = node["payload"];
  const auto contract = node["contract"];
  std::string schema_format;
  std::string schema_type;
  if (payload && payload.IsMap()) {
    schema_format = NormalizeToken(Scalar(payload, "format"));
    schema_type = Scalar(payload, "type");
  }
  if (contract && contract.IsMap()) {
    schema_format = NormalizeToken(Scalar(contract, "format"));
    schema_type = Scalar(contract, "type");
  }
  if (schema_format == "proto" || schema_format == "protobuf_message") {
    schema_format = "protobuf";
  } else if (schema_format == "request_reply" || schema_format == "request_response") {
    schema_format = "protobuf_rpc";
  } else if (schema_format == "omg_idl" || schema_format == "omg_dds_idl" ||
             schema_format == "ddsidl" || schema_format == "omgidl") {
    schema_format = "dds_idl";
  } else if (schema_format == "omg_idl_rpc" ||
             schema_format == "omg_dds_rpc_idl") {
    schema_format = "dds_idl_rpc";
  }
  if (schema_format == "protobuf" || schema_format == "protobuf_rpc") {
    metadata["codec"] = "protobuf";
    metadata["schema.format"] = schema_format;
    if (!schema_type.empty()) {
      metadata["schema.type"] = schema_type;
    }
  } else if (schema_format == "dds_idl" || schema_format == "dds_idl_rpc") {
    metadata["codec"] = "cdr";
    metadata["schema.format"] = schema_format;
    metadata["schema.language"] = "omg_idl";
    metadata["dds.mode"] = "typed_preferred";
    metadata["dds.fallback"] = "byte_envelope";
    metadata["dds.runtime"] = "typed_native";
    metadata["dds.codegen"] = "required_for_typed";
    metadata["dds.envelope.type"] = "PacificRimMessageEnvelope";
    if (!schema_type.empty()) {
      metadata["schema.type"] = schema_type;
      metadata["dds.type"] = schema_type;
    }
  }
  if (!logical_route.empty()) {
    metadata["logical_route"] = logical_route;
  }
  if (!binding_name.empty()) {
    metadata["binding_name"] = binding_name;
  }
  return metadata;
}

inline std::string AdapterFromNode(const YAML::Node& node) {
  auto metadata = Metadata(node, "", "");
  return FirstNonEmpty({
      Scalar(node, "adapter"),
      metadata.count("adapter") ? metadata["adapter"] : "",
      metadata.count("ros2.adapter") ? metadata["ros2.adapter"] : "",
  });
}

inline bool IsRos2ProtoAdapter(const std::string& adapter) {
  const auto normalized = NormalizeToken(adapter);
  return normalized == "ros2_proto_envelope" || normalized == "ros2_typed_mapper";
}

inline std::string EndpointTypeFor(
    TransportKind transport,
    const std::map<std::string, std::string>& metadata,
    std::initializer_list<std::string> fallback_types) {
  const auto adapter = metadata.count("adapter") > 0 ? metadata.at("adapter") : "";
  if (transport == TransportKind::kRos2 && NormalizeToken(adapter) == "ros2_typed_mapper") {
    const auto ros_message = metadata.find("ros_message_type");
    if (ros_message != metadata.end() && !ros_message->second.empty()) {
      return ros_message->second;
    }
    const auto ros_service = metadata.find("ros_service_type");
    if (ros_service != metadata.end() && !ros_service->second.empty()) {
      return ros_service->second;
    }
    const auto ros2_message = metadata.find("ros2.message_type");
    if (ros2_message != metadata.end() && !ros2_message->second.empty()) {
      return ros2_message->second;
    }
    const auto ros2_service = metadata.find("ros2.service_type");
    if (ros2_service != metadata.end() && !ros2_service->second.empty()) {
      return ros2_service->second;
    }
  }
  return FirstNonEmpty(fallback_types);
}

inline MiddlewareConfig MiddlewareFromNode(const std::string& name, const YAML::Node& node) {
  MiddlewareConfig config;
  if (node.IsScalar()) {
    const auto transport_name = node.as<std::string>();
    config.transport = MiddlewareTransportFromString(name, transport_name);
    config.name = name;
    ApplyMiddlewareTransportDefaults(&config.options, transport_name);
    return config;
  }
  const auto transport_name = FirstNonEmpty({
      Scalar(node, "transport"),
      Scalar(node, "kind"),
      name,
  });
  config.transport = MiddlewareTransportFromString(name, transport_name);
  config.name = FirstNonEmpty({Scalar(node, "name"), name});
  if (node["options"]) {
    FlattenScalarMap(node["options"], "", &config.options);
  }
  if (node["qos"]) {
    FlattenScalarMap(node["qos"], "qos", &config.options);
  }
  if (node["security_profile"]) {
    config.options["security.profile"] = node["security_profile"].as<std::string>();
  }
  for (const auto& item : node) {
    const auto key = item.first.as<std::string>();
    if (key != "transport" && key != "kind" && key != "options" && key != "qos" &&
        key != "enabled" && key != "security_profile") {
      FlattenScalarMap(item.second, key, &config.options);
    }
  }
  ApplyMiddlewareTransportDefaults(&config.options, transport_name);
  return config;
}

inline SecurityProfile SecurityProfileFromNode(const std::string& name, const YAML::Node& node) {
  SecurityProfile profile;
  profile.name = name;
  profile.algorithm = SecurityAlgorithmFromString(Scalar(node, "algorithm"));
  profile.encrypt_key_id = FirstNonEmpty({Scalar(node, "encrypt_key_id"), Scalar(node, "key_id")});
  profile.aad_context = Scalar(node, "aad_context");
  profile.fail_open = BoolValue(node, "fail_open", false);
  if (node["replay_window"]) {
    profile.replay_window = node["replay_window"].as<std::uint64_t>();
  }
  auto add_key = [&profile](const YAML::Node& key_node, bool fallback_from_profile) {
    SecurityKey key;
    key.key_id = fallback_from_profile
                     ? FirstNonEmpty({Scalar(key_node, "key_id"), profile.encrypt_key_id})
                     : Scalar(key_node, "key_id");
    if (key.key_id.empty()) {
      throw std::invalid_argument("security key_id is required");
    }
    const auto key_env = Scalar(key_node, "key_env");
    key.master_key = SecuritySecretFromEnv(key_env);
    const auto salt_env = Scalar(key_node, "salt_env");
    if (!salt_env.empty()) {
      key.salt = SecuritySecretFromEnv(salt_env);
    }
    key.decrypt_only = BoolValue(key_node, "decrypt_only", false);
    profile.keys[key.key_id] = std::move(key);
  };
  if (node["keys"] && node["keys"].IsSequence()) {
    for (const auto& key_node : node["keys"]) {
      add_key(key_node, false);
    }
  } else {
    add_key(node, true);
  }
  if (profile.encrypt_key_id.empty()) {
    throw std::invalid_argument("security encrypt_key_id or key_id is required");
  }
  const auto encrypt_key = profile.keys.find(profile.encrypt_key_id);
  if (encrypt_key == profile.keys.end()) {
    throw std::invalid_argument("security encrypt key is not configured: " + profile.encrypt_key_id);
  }
  if (encrypt_key->second.decrypt_only) {
    throw std::invalid_argument("security encrypt key is decrypt_only: " + profile.encrypt_key_id);
  }
  return profile;
}

inline void LoadSecurityProfiles(const YAML::Node& communication, ServiceCommunicationConfig* config) {
  const auto security = communication["security"];
  if (!security || !security.IsMap() || config == nullptr) {
    return;
  }
  config->require_explicit_security_profile = BoolValue(security, "require_explicit_profile", false);
  const auto profiles = security["profiles"];
  if (!profiles || !profiles.IsMap()) {
    return;
  }
  for (const auto& item : profiles) {
    const auto name = item.first.as<std::string>();
    const auto profile_node = item.second;
    if (!Enabled(profile_node)) {
      continue;
    }
    config->security_profiles[name] = SecurityProfileFromNode(name, profile_node);
  }
}

inline std::string DefaultRouteAddress(
    const std::string& route_name,
    TransportKind transport,
    bool service_route) {
  if (route_name.empty()) {
    return "";
  }
  auto normalized = route_name;
  if (transport == TransportKind::kNats) {
    return std::string(service_route ? "robot.rpc." : "robot.topic.") + normalized;
  }
  if (transport == TransportKind::kRos2) {
    std::replace(normalized.begin(), normalized.end(), '.', '/');
    return normalized.front() == '/' ? normalized : "/" + normalized;
  }
  if (transport == TransportKind::kCycloneDds || transport == TransportKind::kFastDds) {
    std::replace(normalized.begin(), normalized.end(), '/', '.');
    return service_route ? normalized + ".request" : normalized;
  }
  return normalized;
}

inline std::string MiddlewareAddress(
    const YAML::Node& node,
    const std::string& middleware,
    TransportKind transport) {
  const auto addresses = node["addresses"];
  if (!addresses || !addresses.IsMap()) {
    return "";
  }
  auto lookup = [&addresses](const std::string& key) {
    if (key.empty()) {
      return std::string();
    }
    return Scalar(addresses, key);
  };
  auto value = lookup(middleware);
  if (!value.empty()) {
    return value;
  }
  value = lookup(NormalizeToken(middleware));
  if (!value.empty()) {
    return value;
  }
  if (transport == TransportKind::kNats) {
    return lookup("nats");
  }
  if (transport == TransportKind::kRos2) {
    return lookup("ros2");
  }
  if (transport == TransportKind::kCycloneDds) {
    value = lookup("cyclonedds");
    return value.empty() ? lookup("dds") : value;
  }
  if (transport == TransportKind::kFastDds) {
    return lookup("fastdds");
  }
  return "";
}

inline std::string ChannelAddress(
    const YAML::Node& node,
    TransportKind transport,
    const std::string& route_name = "",
    bool service_route = false) {
  const auto configured_address = MiddlewareAddress(node, Scalar(node, "middleware"), transport);
  if (!configured_address.empty()) {
    return configured_address;
  }
  if (transport == TransportKind::kNats) {
    return FirstNonEmpty({
        Scalar(node, "subject"),
        Scalar(node, "nats_subject"),
        Scalar(node, "address"),
        DefaultRouteAddress(route_name, transport, service_route),
    });
  }
  if (transport == TransportKind::kCycloneDds ||
      transport == TransportKind::kFastDds) {
    return FirstNonEmpty({
        Scalar(node, "topic"),
        Scalar(node, "dds_topic"),
        Scalar(node, "address"),
        Scalar(node, "service"),
        Scalar(node, "request"),
        Scalar(node, "request_channel"),
        DefaultRouteAddress(route_name, transport, service_route),
    });
  }
  return FirstNonEmpty({
      Scalar(node, "address"),
      Scalar(node, "service"),
      Scalar(node, "ros_service"),
      Scalar(node, "topic"),
      Scalar(node, "ros_topic"),
      Scalar(node, "subject"),
      DefaultRouteAddress(route_name, transport, service_route),
  });
}

inline Endpoint EndpointFromRoute(
    const YAML::Node& node,
    TransportKind transport,
    const std::string& address,
    const std::string& type,
    const std::map<std::string, std::string>& metadata) {
  Endpoint endpoint;
  endpoint.transport = transport;
  endpoint.address = address;
  endpoint.message_type = type;
  endpoint.metadata = metadata;
  return endpoint;
}

inline YAML::Node MergedNode(const YAML::Node& base, const YAML::Node& binding) {
  YAML::Node merged(YAML::NodeType::Map);
  for (const auto& item : base) {
    const auto key = item.first.as<std::string>();
    if (key != "bindings" && key != "routes") {
      merged[key] = item.second;
    }
  }
  for (const auto& item : binding) {
    const auto key = item.first.as<std::string>();
    if ((key == "metadata" || key == "qos") && merged[key] && merged[key].IsMap() &&
        item.second.IsMap()) {
      YAML::Node merged_map(YAML::NodeType::Map);
      for (const auto& base_item : merged[key]) {
        merged_map[base_item.first.as<std::string>()] = base_item.second;
      }
      for (const auto& binding_item : item.second) {
        merged_map[binding_item.first.as<std::string>()] = binding_item.second;
      }
      merged[key] = merged_map;
    } else {
      merged[key] = item.second;
    }
  }
  return merged;
}

inline void ApplyRouteBindingOverrides(YAML::Node* binding, const YAML::Node& route) {
  if (binding == nullptr) {
    return;
  }
  for (const auto* key : {"queue_group", "queue_size", "enabled", "qos", "metadata"}) {
    if (!(*binding)[key] && route[key]) {
      (*binding)[key] = route[key];
    }
  }
}

inline std::string BindingAddress(const YAML::Node& node) {
  return FirstNonEmpty({
      Scalar(node, "topic"),
      Scalar(node, "subject"),
      Scalar(node, "service"),
      Scalar(node, "address"),
  });
}

inline bool SameBinding(const YAML::Node& left, const YAML::Node& right) {
  std::string left_transport = Scalar(left, "transport");
  std::string right_transport = Scalar(right, "transport");
  std::replace(left_transport.begin(), left_transport.end(), '-', '_');
  std::replace(right_transport.begin(), right_transport.end(), '-', '_');
  std::transform(left_transport.begin(), left_transport.end(), left_transport.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  std::transform(right_transport.begin(), right_transport.end(), right_transport.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (!left_transport.empty() && left_transport == right_transport) {
    return true;
  }
  const auto left_address = BindingAddress(left);
  return !left_address.empty() && left_address == BindingAddress(right);
}

inline std::string DdsRpcStandard(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (value.empty() || value == "omg" || value == "dds_rpc" || value == "omg_dds_rpc") {
    return "omg_dds_rpc";
  }
  if (value == "rmw" || value == "rmw_cyclonedds" ||
      value == "rmw_cyclonedds_cpp" || value == "ros2_rmw") {
    return "rmw_cyclonedds";
  }
  return value;
}

inline bool HasRouteBindings(const YAML::Node& node) {
  const auto bindings = node["bindings"] ? node["bindings"] : node["routes"];
  return bindings && bindings.IsSequence();
}

inline bool IsHighLevelRoute(const YAML::Node& node) {
  return (!Scalar(node, "data").empty() ||
          !Scalar(node, "data_format").empty() ||
          !Scalar(node, "type").empty() ||
          !Scalar(node, "middleware").empty() ||
          !PayloadType(node).empty() ||
          !ContractType(node).empty() ||
          !Scalar(node, "message_type").empty() ||
          !Scalar(node, "service_type").empty()) &&
         Scalar(node, "transport").empty() &&
         !HasRouteBindings(node);
}

inline std::string TopicPayloadFormat(const std::string& data) {
  const auto normalized = NormalizeToken(data);
  if (normalized == "proto" || normalized == "protobuf" || normalized == "protobuf_message") {
    return "protobuf";
  }
  if (normalized == "msg" || normalized == "ros2_msg" || normalized == "rosidl_msg") {
    return "ros2_msg";
  }
  if (normalized == "dds_idl" || normalized == "omg_idl" ||
      normalized == "omg_dds_idl" || normalized == "ddsidl" ||
      normalized == "omgidl") {
    return "dds_idl";
  }
  if (normalized == "bytes" || normalized == "raw" || normalized == "cdr" || normalized == "cdr_bytes") {
    return "bytes";
  }
  return normalized.empty() ? "bytes" : normalized;
}

inline std::string InferTopicPayloadFormat(const std::string& type) {
  if (type.find("/msg/") != std::string::npos) {
    return "ros2_msg";
  }
  if (type.find("::") != std::string::npos) {
    return "dds_idl";
  }
  return type.empty() ? "" : "protobuf";
}

inline std::string TopicPayloadFormatFor(const std::string& data, const std::string& type) {
  if (!NormalizeToken(data).empty()) {
    return TopicPayloadFormat(data);
  }
  const auto inferred = InferTopicPayloadFormat(type);
  return inferred.empty() ? TopicPayloadFormat(data) : inferred;
}

inline std::string ServiceContractFormat(const std::string& data) {
  const auto normalized = NormalizeToken(data);
  if (normalized == "proto" || normalized == "protobuf" || normalized == "protobuf_rpc" ||
      normalized == "request_reply" || normalized == "request_response") {
    return "protobuf_rpc";
  }
  if (normalized == "srv" || normalized == "ros2_srv" || normalized == "rosidl_srv") {
    return "ros2_srv";
  }
  if (normalized == "dds_idl" || normalized == "omg_idl" ||
      normalized == "omg_dds_idl" || normalized == "ddsidl" ||
      normalized == "omgidl" || normalized == "dds_idl_rpc" ||
      normalized == "omg_idl_rpc" || normalized == "omg_dds_rpc_idl") {
    return "dds_idl_rpc";
  }
  if (normalized == "json") {
    return "json_rpc";
  }
  if (normalized == "bytes" || normalized == "raw" || normalized == "cdr" || normalized == "cdr_bytes") {
    return "bytes_rpc";
  }
  return normalized.empty() ? "bytes_rpc" : normalized;
}

inline std::string InferServiceContractFormat(const std::string& type) {
  if (type.find("/srv/") != std::string::npos) {
    return "ros2_srv";
  }
  if (type.find("::") != std::string::npos) {
    return "dds_idl_rpc";
  }
  return type.empty() ? "" : "protobuf_rpc";
}

inline std::string ServiceContractFormatFor(const std::string& data, const std::string& type) {
  if (!NormalizeToken(data).empty()) {
    return ServiceContractFormat(data);
  }
  const auto inferred = InferServiceContractFormat(type);
  return inferred.empty() ? ServiceContractFormat(data) : inferred;
}

inline bool IsNativeDdsTopicFormat(const std::string& format) {
  const auto normalized = NormalizeToken(format);
  return normalized == "protobuf" || normalized == "dds_idl";
}

inline bool IsNativeDdsServiceFormat(const std::string& format) {
  const auto normalized = NormalizeToken(format);
  return normalized == "protobuf_rpc" || normalized == "dds_idl_rpc";
}

inline void NormalizePublicTopicItem(YAML::Node* route) {
  if (route == nullptr) {
    return;
  }
  auto& item = *route;
  if (item["payload"] && item["payload"].IsMap()) {
    if (!item["payload"]["format"]) {
      const auto type = Scalar(item["payload"], "type");
      const auto inferred = InferTopicPayloadFormat(type);
      if (!inferred.empty()) {
        item["payload"]["format"] = inferred;
      }
    }
    if (!item["message_type"] && NormalizeToken(Scalar(item["payload"], "format")) == "ros2_msg") {
      const auto type = Scalar(item["payload"], "type");
      if (!type.empty()) {
        item["message_type"] = type;
      }
    }
    return;
  }
  const auto data = FirstNonEmpty({Scalar(item, "data"), Scalar(item, "data_format")});
  const auto type = Scalar(item, "type");
  if (data.empty() && type.empty()) {
    return;
  }
  YAML::Node payload(YAML::NodeType::Map);
  payload["format"] = TopicPayloadFormatFor(data, type);
  payload["type"] = type;
  item["payload"] = payload;
  if (!item["message_type"] && Scalar(payload, "format") == "ros2_msg" && !type.empty()) {
    item["message_type"] = type;
  }
}

inline void NormalizePublicServiceItem(YAML::Node* route) {
  if (route == nullptr) {
    return;
  }
  auto& item = *route;
  if (item["contract"] && item["contract"].IsMap()) {
    if (!item["contract"]["format"]) {
      const auto type = Scalar(item["contract"], "type");
      const auto inferred = InferServiceContractFormat(type);
      if (!inferred.empty()) {
        item["contract"]["format"] = inferred;
      }
    }
    if (!item["service_type"] && NormalizeToken(Scalar(item["contract"], "format")) == "ros2_srv") {
      const auto type = Scalar(item["contract"], "type");
      if (!type.empty()) {
        item["service_type"] = type;
      }
    }
    return;
  }
  const auto data = FirstNonEmpty({Scalar(item, "data"), Scalar(item, "data_format")});
  const auto type = Scalar(item, "type");
  if (data.empty() && type.empty()) {
    return;
  }
  YAML::Node contract(YAML::NodeType::Map);
  contract["format"] = ServiceContractFormatFor(data, type);
  contract["type"] = type;
  const auto response_type = FirstNonEmpty({Scalar(item, "response_type"), Scalar(item, "responseType")});
  if (!response_type.empty()) {
    contract["response_type"] = response_type;
  }
  item["contract"] = contract;
  if (!item["service_type"] && Scalar(contract, "format") == "ros2_srv" && !type.empty()) {
    item["service_type"] = type;
  }
}

inline std::string NormalizeRouteMiddlewareProtocol(const std::string& value) {
  const auto normalized = NormalizeToken(value);
  if (normalized == "nats" || normalized == "nats_topic" || normalized == "nats_rpc") {
    return "nats";
  }
  if (normalized == "cyclonedds" || normalized == "cyclone_dds") {
    return "cyclonedds";
  }
  if (normalized == "fastdds" || normalized == "fast_dds" ||
      normalized == "fastrtps" || normalized == "fast_rtps") {
    return "fastdds";
  }
  if (normalized == "ros2" || normalized == "ros2_topic" || normalized == "ros2_service") {
    return "ros2";
  }
  if (normalized.empty()) {
    throw std::invalid_argument("high-level route middleware is required; use nats, cyclonedds, fastdds, or ros2");
  }
  throw std::invalid_argument("unsupported high-level route middleware " + value + "; use nats, cyclonedds, fastdds, or ros2");
}

inline RouteExecutionPlan CycloneDdsRmwPlan(const std::string& transport_name) {
  RouteExecutionPlan plan;
  plan.transport = TransportKind::kRos2;
  plan.transport_name = transport_name;
  plan.middleware_name = "cyclonedds";
  plan.runtime_name = "cyclonedds__rmw";
  plan.family = "cyclonedds";
  plan.implementation = "rmw_cyclonedds";
  plan.options["middleware.family"] = "cyclonedds";
  plan.options["implementation"] = "rmw_cyclonedds";
  plan.options["rmw_implementation"] = "rmw_cyclonedds_cpp";
  return plan;
}

inline RouteExecutionPlan FastDdsRmwPlan(const std::string& transport_name) {
  RouteExecutionPlan plan;
  plan.transport = TransportKind::kRos2;
  plan.transport_name = transport_name;
  plan.middleware_name = "fastdds";
  plan.runtime_name = "fastdds__rmw";
  plan.family = "fastdds";
  plan.implementation = "rmw_fastrtps";
  plan.options["middleware.family"] = "fastdds";
  plan.options["implementation"] = "rmw_fastrtps";
  plan.options["rmw_implementation"] = "rmw_fastrtps_cpp";
  return plan;
}

inline RouteExecutionPlan NativeCycloneDdsPlan(const std::string& transport_name) {
  RouteExecutionPlan plan;
  plan.transport = TransportKind::kCycloneDds;
  plan.transport_name = transport_name;
  plan.middleware_name = "cyclonedds";
  plan.runtime_name = "cyclonedds";
  plan.family = "cyclonedds";
  plan.implementation = "native_cyclonedds";
  plan.options["middleware.family"] = "cyclonedds";
  plan.options["implementation"] = "native_cyclonedds";
  return plan;
}

inline RouteExecutionPlan NativeFastDdsPlan(const std::string& transport_name) {
  RouteExecutionPlan plan;
  plan.transport = TransportKind::kFastDds;
  plan.transport_name = transport_name;
  plan.middleware_name = "fastdds";
  plan.runtime_name = "fastdds";
  plan.family = "fastdds";
  plan.implementation = "native_fastdds";
  plan.options["middleware.family"] = "fastdds";
  plan.options["implementation"] = "native_fastdds";
  return plan;
}

inline RouteExecutionPlan TopicExecutionPlan(
    const std::string& protocol,
    const std::string& data_format) {
  const auto normalized = NormalizeRouteMiddlewareProtocol(protocol);
  if (normalized == "cyclonedds") {
    if (IsNativeDdsTopicFormat(TopicPayloadFormat(data_format))) {
      return NativeCycloneDdsPlan("cyclonedds_topic");
    }
    return CycloneDdsRmwPlan("ros2_topic");
  }
  if (normalized == "fastdds") {
    if (IsNativeDdsTopicFormat(TopicPayloadFormat(data_format))) {
      return NativeFastDdsPlan("fastdds_topic");
    }
    return FastDdsRmwPlan("ros2_topic");
  }
  RouteExecutionPlan plan;
  if (normalized == "ros2") {
    plan.transport = TransportKind::kRos2;
    plan.transport_name = "ros2_topic";
    plan.middleware_name = "ros2";
    plan.family = "ros2";
    return plan;
  }
  plan.transport = TransportKind::kNats;
  plan.transport_name = "nats_topic";
  plan.middleware_name = "nats";
  plan.family = "nats";
  return plan;
}

inline RouteExecutionPlan ServiceExecutionPlan(
    const std::string& protocol,
    const std::string& data_format) {
  const auto normalized = NormalizeRouteMiddlewareProtocol(protocol);
  if (normalized == "cyclonedds") {
    if (IsNativeDdsServiceFormat(ServiceContractFormat(data_format))) {
      return NativeCycloneDdsPlan("cyclonedds_rpc");
    }
    return CycloneDdsRmwPlan("ros2_service");
  }
  if (normalized == "fastdds") {
    if (IsNativeDdsServiceFormat(ServiceContractFormat(data_format))) {
      return NativeFastDdsPlan("fastdds_rpc");
    }
    return FastDdsRmwPlan("ros2_service");
  }
  RouteExecutionPlan plan;
  if (normalized == "ros2") {
    plan.transport = TransportKind::kRos2;
    plan.transport_name = "ros2_service";
    plan.middleware_name = "ros2";
    plan.family = "ros2";
    return plan;
  }
  plan.transport = TransportKind::kNats;
  plan.transport_name = "nats_rpc";
  plan.middleware_name = "nats";
  plan.family = "nats";
  return plan;
}

inline void AddExecutionMetadata(
    YAML::Node* route,
    const RouteExecutionPlan& plan) {
  if (route == nullptr) {
    return;
  }
  YAML::Node metadata = (*route)["metadata"] && (*route)["metadata"].IsMap()
                            ? YAML::Clone((*route)["metadata"])
                            : YAML::Node(YAML::NodeType::Map);
  if (!plan.family.empty()) {
    metadata["middleware.family"] = plan.family;
  }
  const auto runtime_name = RuntimeMiddlewareName(plan);
  if (!runtime_name.empty()) {
    metadata["middleware.runtime"] = runtime_name;
  }
  if (!plan.implementation.empty()) {
    metadata["middleware.implementation"] = plan.implementation;
    metadata["implementation"] = plan.implementation;
  }
  if (plan.implementation == "rmw_cyclonedds") {
    metadata["rmw_implementation"] = "rmw_cyclonedds_cpp";
  } else if (plan.implementation == "rmw_fastrtps") {
    metadata["rmw_implementation"] = "rmw_fastrtps_cpp";
  }
  (*route)["metadata"] = metadata;
}

inline YAML::Node NormalizeTopicRouteNode(const YAML::Node& node) {
  if (!IsHighLevelRoute(node)) {
    return node;
  }
  auto route = YAML::Clone(node);
  const auto data = FirstNonEmpty({
      Scalar(route, "data"),
      Scalar(route, "data_format"),
      Scalar(route["payload"], "format"),
  });
  const auto payload_type = FirstNonEmpty({
      Scalar(route["payload"], "type"),
      Scalar(route, "type"),
      Scalar(route, "message_type"),
      Scalar(route, "msg_type"),
      Scalar(route, "ros_message_type"),
  });
  const auto payload_format = TopicPayloadFormatFor(data, payload_type);
  const auto plan = TopicExecutionPlan(Scalar(route, "middleware"), payload_format);
  route["transport"] = plan.transport_name;
  if (!plan.middleware_name.empty()) {
    route["middleware"] = plan.middleware_name;
  }
  YAML::Node payload = route["payload"] && route["payload"].IsMap()
                           ? YAML::Clone(route["payload"])
                           : YAML::Node(YAML::NodeType::Map);
  if (!payload["format"]) {
    payload["format"] = payload_format;
  }
  if (!payload["type"]) {
    payload["type"] = payload_type;
  }
  route["payload"] = payload;
  if (Scalar(payload, "format") == "ros2_msg" && Scalar(route, "message_type").empty()) {
    route["message_type"] = Scalar(payload, "type");
  }
  AddExecutionMetadata(&route, plan);
  if (plan.transport_name == "ros2_topic" && Scalar(payload, "format") == "protobuf" &&
      AdapterFromNode(route).empty()) {
    route["adapter"] = "ros2_proto_envelope";
  }
  return route;
}

inline YAML::Node NormalizeServiceRouteNode(const YAML::Node& node) {
  if (!IsHighLevelRoute(node)) {
    return node;
  }
  auto route = YAML::Clone(node);
  const auto data = FirstNonEmpty({
      Scalar(route, "data"),
      Scalar(route, "data_format"),
      Scalar(route["contract"], "format"),
  });
  const auto contract_type = FirstNonEmpty({
      Scalar(route["contract"], "type"),
      Scalar(route, "type"),
      Scalar(route, "service_type"),
      Scalar(route, "message_type"),
      Scalar(route, "ros_service_type"),
  });
  const auto contract_format = ServiceContractFormatFor(data, contract_type);
  const auto plan = ServiceExecutionPlan(Scalar(route, "middleware"), contract_format);
  route["transport"] = plan.transport_name;
  if (!plan.middleware_name.empty()) {
    route["middleware"] = plan.middleware_name;
  }
  YAML::Node contract = route["contract"] && route["contract"].IsMap()
                            ? YAML::Clone(route["contract"])
                            : YAML::Node(YAML::NodeType::Map);
  if (!contract["format"]) {
    contract["format"] = contract_format;
  }
  if (!contract["type"]) {
    contract["type"] = contract_type;
  }
  route["contract"] = contract;
  if (Scalar(contract, "format") == "ros2_srv" && Scalar(route, "service_type").empty()) {
    route["service_type"] = Scalar(contract, "type");
  }
  AddExecutionMetadata(&route, plan);
  if (plan.transport_name == "ros2_service" && Scalar(contract, "format") == "protobuf_rpc" &&
      AdapterFromNode(route).empty()) {
    route["adapter"] = "ros2_proto_envelope";
  }
  return route;
}

inline void AddReferencedDefaultMiddleware(
    const YAML::Node& routes,
    bool service_routes,
    ServiceCommunicationConfig* config) {
  if (!routes || config == nullptr) {
    return;
  }
  auto plan_for = [service_routes](const YAML::Node& node, const std::string& protocol) {
    if (service_routes) {
      const auto contract_type = FirstNonEmpty({
          Scalar(node["contract"], "type"),
          Scalar(node, "type"),
          Scalar(node, "service_type"),
          Scalar(node, "message_type"),
          Scalar(node, "ros_service_type"),
      });
      return ServiceExecutionPlan(protocol, ServiceContractFormatFor(FirstNonEmpty({
                                                Scalar(node, "data"),
                                                Scalar(node, "data_format"),
                                                Scalar(node["contract"], "format"),
                                            }), contract_type));
    }
    const auto payload_type = FirstNonEmpty({
        Scalar(node["payload"], "type"),
        Scalar(node, "type"),
        Scalar(node, "message_type"),
        Scalar(node, "msg_type"),
        Scalar(node, "ros_message_type"),
    });
    return TopicExecutionPlan(protocol, TopicPayloadFormatFor(FirstNonEmpty({
                                            Scalar(node, "data"),
                                            Scalar(node, "data_format"),
                                            Scalar(node["payload"], "format"),
                                        }), payload_type));
  };
  auto consider = [config, plan_for](const YAML::Node& node) {
    if (!IsHighLevelRoute(node)) {
      return;
    }
    const auto protocol = Scalar(node, "middleware");
    if (protocol.empty()) {
      return;
    }
    const auto plan = plan_for(node, protocol);
    const auto runtime_name = RuntimeMiddlewareName(plan);
    if (plan.transport == TransportKind::kInProcess || runtime_name.empty() ||
        config->middleware.count(runtime_name) > 0) {
      return;
    }
    MiddlewareConfig generated;
    generated.transport = plan.transport;
    generated.name = runtime_name;
    const auto base = config->middleware.find(plan.middleware_name);
    generated.options = MergeOptions(
        base == config->middleware.end() ? std::map<std::string, std::string>{} : base->second.options,
        plan.options);
    config->middleware[generated.name] = generated;
  };
  auto consider_middlewares = [consider](const YAML::Node& route) {
    const auto middlewares = route["middlewares"];
    if (!middlewares || !middlewares.IsSequence()) {
      consider(route);
      return;
    }
    for (const auto& middleware : middlewares) {
      auto expanded = YAML::Clone(route);
      expanded["middleware"] = middleware.as<std::string>();
      expanded.remove("middlewares");
      expanded.remove("bindings");
      expanded.remove("routes");
      consider(expanded);
    }
  };
  for (const auto& item : routes) {
    const auto route = item.second;
    const auto bindings = route["bindings"] ? route["bindings"] : route["routes"];
    if (!bindings) {
      consider_middlewares(route);
      continue;
    }
    for (const auto& binding : bindings) {
      consider(MergedNode(route, binding));
    }
  }
}

inline bool IsCycloneDdsRpcTransport(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value == "cyclonedds_rpc" || value == "dds_rpc";
}

inline bool IsNativeDdsRpcTransport(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value == "cyclonedds_rpc" || value == "dds_rpc" || value == "fastdds_rpc";
}

inline bool IsNativeDdsTopicTransport(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value == "cyclonedds_topic" || value == "dds_topic" || value == "fastdds_topic";
}

inline void ValidateTopicCompatibility(
    const std::string& route_name,
    const YAML::Node& node,
    TransportKind transport) {
  auto binding = Scalar(node, "transport");
  std::replace(binding.begin(), binding.end(), '-', '_');
  std::transform(binding.begin(), binding.end(), binding.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (binding.empty()) {
    binding = "nats_topic";
  }
  const auto payload = node["payload"];
  std::string format_value;
  if (payload && payload.IsMap()) {
    format_value = Scalar(payload, "format");
  }
  std::transform(format_value.begin(), format_value.end(), format_value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (format_value.empty() && (!Scalar(node, "message_type").empty() || !Scalar(node, "msg_type").empty())) {
    format_value = "ros2_msg";
  }
  if (transport == TransportKind::kRos2 && binding == "ros2_topic" &&
      !format_value.empty() && format_value != "ros2_msg" && format_value != "rosidl_msg") {
    if (format_value == "protobuf" && IsRos2ProtoAdapter(AdapterFromNode(node))) {
      return;
    }
    throw std::invalid_argument(
        "topic " + route_name + ": ros2_topic is native for rosidl message; " +
        format_value + " requires an adapter");
  }
  if (transport == TransportKind::kFastDds &&
      !format_value.empty() &&
      !IsNativeDdsTopicFormat(format_value)) {
    throw std::invalid_argument(
        "topic " + route_name + ": fastdds_topic is native for protobuf or OMG IDL CDR data; " +
        "use middleware fastdds with data msg for ROS IDL data");
  }
  if (IsNativeDdsRpcTransport(binding)) {
    throw std::invalid_argument(
        "topic " + route_name + ": " + binding +
        " is request/reply; use communication.services");
  }
}

inline void ValidateServiceCompatibility(
    const std::string& route_name,
    const YAML::Node& node,
    TransportKind transport) {
  auto binding = Scalar(node, "transport");
  std::replace(binding.begin(), binding.end(), '-', '_');
  std::transform(binding.begin(), binding.end(), binding.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (binding.empty()) {
    binding = "nats_rpc";
  }
  std::string format_value;
  const auto contract = node["contract"];
  if (contract && contract.IsMap()) {
    format_value = Scalar(contract, "format");
  }
  std::transform(format_value.begin(), format_value.end(), format_value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (format_value.empty() && (!Scalar(node, "service_type").empty() || !Scalar(node, "message_type").empty())) {
    format_value = "ros2_srv";
  }
  if (transport == TransportKind::kRos2 && binding == "ros2_service" &&
      !format_value.empty() && format_value != "ros2_srv" && format_value != "rosidl_srv") {
    if (format_value == "protobuf_rpc" && IsRos2ProtoAdapter(AdapterFromNode(node))) {
      return;
    }
    throw std::invalid_argument(
        "service " + route_name + ": ros2_service is native for rosidl service; " +
        format_value + " requires an adapter");
  }
  if (binding == "grpc" && !format_value.empty() && format_value != "protobuf_rpc") {
    throw std::invalid_argument(
        "service " + route_name + ": grpc is native for protobuf service; " +
        format_value + " requires an adapter");
  }
  if (transport == TransportKind::kFastDds &&
      !format_value.empty() &&
      !IsNativeDdsServiceFormat(format_value)) {
    throw std::invalid_argument(
        "service " + route_name + ": fastdds_rpc is native for protobuf RPC or OMG DDS-RPC CDR data; " +
        "use middleware fastdds with data srv for ROS IDL data");
  }
  if (IsNativeDdsTopicTransport(binding)) {
    throw std::invalid_argument(
        "service " + route_name + ": " + binding +
        " is pub/sub; use cyclonedds_rpc or fastdds_rpc for request/reply");
  }
  if (binding == "cyclonedds_rpc" || binding == "dds_rpc") {
    const auto standard = DdsRpcStandard(Scalar(node, "standard"));
    if (standard != "omg_dds_rpc" && standard != "rmw_cyclonedds") {
      throw std::invalid_argument(
          "service " + route_name + ": cyclonedds_rpc standard must be omg_dds_rpc or rmw_cyclonedds");
    }
  }
  if (binding == "fastdds_rpc") {
    const auto standard = DdsRpcStandard(Scalar(node, "standard"));
    if (standard != "omg_dds_rpc") {
      throw std::invalid_argument(
          "service " + route_name + ": fastdds_rpc standard must be omg_dds_rpc");
    }
  }
}

inline YAML::Node MergePublicBindings(const YAML::Node& raw_bindings, const YAML::Node& public_bindings, const YAML::Node& route) {
  YAML::Node merged(YAML::NodeType::Sequence);
  if (!raw_bindings || !raw_bindings.IsSequence()) {
    if (public_bindings && public_bindings.IsSequence()) {
      for (const auto& item : public_bindings) {
        auto binding = YAML::Clone(item);
        ApplyRouteBindingOverrides(&binding, route);
        merged.push_back(binding);
      }
    }
    return merged;
  }
  std::vector<bool> used(public_bindings && public_bindings.IsSequence() ? public_bindings.size() : 0, false);
  for (const auto& item : raw_bindings) {
    YAML::Node binding = YAML::Clone(item);
    if (public_bindings && public_bindings.IsSequence()) {
      std::size_t index = 0;
      for (const auto& candidate : public_bindings) {
        if (SameBinding(candidate, item)) {
          binding = MergedNode(candidate, item);
          if (index < used.size()) {
            used[index] = true;
          }
          break;
        }
        index += 1;
      }
    }
    ApplyRouteBindingOverrides(&binding, route);
    merged.push_back(binding);
  }
  if (public_bindings && public_bindings.IsSequence()) {
    std::size_t index = 0;
    for (const auto& candidate : public_bindings) {
      if (index < used.size() && !used[index]) {
        auto binding = YAML::Clone(candidate);
        ApplyRouteBindingOverrides(&binding, route);
        merged.push_back(binding);
      }
      index += 1;
    }
  }
  return merged;
}

inline YAML::Node MergePublicRoute(const YAML::Node& route, const YAML::Node& public_route) {
  YAML::Node merged = YAML::Clone(public_route);
  for (const auto& item : route) {
    const auto key = item.first.as<std::string>();
    if (key != "bindings" && key != "routes") {
      merged[key] = item.second;
    }
  }
  if (route["direction"]) {
    merged["role"] = route["direction"];
  }
  const auto raw_bindings = route["bindings"] ? route["bindings"] : route["routes"];
  if (raw_bindings) {
    merged["bindings"] = MergePublicBindings(raw_bindings, public_route["bindings"], route);
  } else if (public_route["bindings"]) {
    merged["bindings"] = MergePublicBindings(YAML::Node(), public_route["bindings"], route);
  }
  return merged;
}

inline YAML::Node MiddlewaresFromAddresses(const YAML::Node& addresses) {
  YAML::Node middlewares(YAML::NodeType::Sequence);
  if (!addresses || !addresses.IsMap()) {
    return middlewares;
  }
  std::vector<std::string> seen;
  for (const auto& item : addresses) {
    auto name = NormalizeToken(item.first.as<std::string>(""));
    if (name == "dds") {
      name = "cyclonedds";
    }
    if (!name.empty() && std::find(seen.begin(), seen.end(), name) == seen.end()) {
      seen.push_back(name);
      middlewares.push_back(name);
    }
  }
  return middlewares;
}

inline YAML::Node ProviderRouteFromPublic(const YAML::Node& route) {
  auto provider_route = YAML::Clone(route);
  if (!provider_route["bindings"] && !provider_route["routes"] &&
      !provider_route["middlewares"]) {
    const auto middlewares = MiddlewaresFromAddresses(provider_route["addresses"]);
    if (middlewares && middlewares.IsSequence() && middlewares.size() > 0) {
      provider_route["middlewares"] = middlewares;
    }
  }
  return provider_route;
}

inline void InjectPublicRoutesForService(
    YAML::Node* routes,
    const std::map<std::string, YAML::Node>& catalog,
    const std::string& service_name,
    const std::string& ref_key) {
  if (routes == nullptr || service_name.empty()) {
    return;
  }
  if (!*routes || !routes->IsMap()) {
    *routes = YAML::Node(YAML::NodeType::Map);
  }
  std::vector<std::string> seen;
  const auto prefix = service_name + ".";
  for (const auto& item : catalog) {
    const auto& route = item.second;
    const auto ref = Scalar(route, ref_key);
    if (ref.rfind(prefix, 0) != 0 ||
        std::find(seen.begin(), seen.end(), ref) != seen.end()) {
      continue;
    }
    seen.push_back(ref);
    const auto route_name = ref.substr(prefix.size());
    if (!route_name.empty() && !(*routes)[route_name]) {
      (*routes)[route_name] = ProviderRouteFromPublic(route);
    }
  }
}

inline void InjectOwnPublicInterfaceRoutes(
    YAML::Node* communication,
    const PublicInterfaceCatalog& catalog,
    const std::string& service_name) {
  if (communication == nullptr || !*communication || !communication->IsMap()) {
    return;
  }
  auto topics = (*communication)["topics"];
  InjectPublicRoutesForService(&topics, catalog.topics, service_name, "topic_ref");
  (*communication)["topics"] = topics;
  auto services = (*communication)["services"];
  InjectPublicRoutesForService(&services, catalog.services, service_name, "service_ref");
  (*communication)["services"] = services;
}

inline std::filesystem::path ResolveWorkspaceRoot(const std::string& config_path) {
  std::error_code error;
  auto current = std::filesystem::weakly_canonical(std::filesystem::path(config_path), error);
  if (error) {
    current = std::filesystem::absolute(std::filesystem::path(config_path), error);
  }
  current = current.parent_path();
  while (!current.empty() && current != current.parent_path()) {
    if (std::filesystem::is_directory(current / "pkg" / "idl", error)) {
      return current;
    }
    current = current.parent_path();
  }
  return {};
}

inline void AddPublicManifestEntries(
    const std::filesystem::path& idl_root,
    const std::filesystem::path& manifest_path,
    PublicInterfaceCatalog* catalog) {
  if (catalog == nullptr) {
    return;
  }
  YAML::Node root;
  try {
    root = YAML::LoadFile(manifest_path.string());
  } catch (...) {
    return;
  }
  if (!root || !root.IsMap()) {
    return;
  }
  const auto relative = std::filesystem::relative(manifest_path, idl_root);
  if (relative.empty()) {
    return;
  }
  const auto it = relative.begin();
  if (it == relative.end()) {
    return;
  }
  const auto idl_service = it->string();
  if (root["topics"] && root["topics"].IsMap()) {
    for (const auto& item : root["topics"]) {
      const auto name = item.first.as<std::string>();
      auto route = YAML::Clone(item.second);
      route["topic_ref"] = idl_service + "." + name;
      NormalizePublicTopicItem(&route);
      catalog->topics[idl_service + "." + name] = route;
      for (const auto& ref : PublicBindingRefs(route, false)) {
        AddPublicRouteAlias(&catalog->topics, ref, route);
      }
    }
  } else if (!root["services"]) {
    const auto name = root["name"] ? root["name"].as<std::string>() : manifest_path.stem().string();
    auto route = YAML::Clone(root);
    route["topic_ref"] = idl_service + "." + name;
    NormalizePublicTopicItem(&route);
    catalog->topics[idl_service + "." + name] = route;
    for (const auto& ref : PublicBindingRefs(route, false)) {
      AddPublicRouteAlias(&catalog->topics, ref, route);
    }
  }
  if (root["services"] && root["services"].IsMap()) {
    for (const auto& item : root["services"]) {
      const auto name = item.first.as<std::string>();
      auto route = YAML::Clone(item.second);
      route["service_ref"] = idl_service + "." + name;
      NormalizePublicServiceItem(&route);
      catalog->services[idl_service + "." + name] = route;
      for (const auto& ref : PublicBindingRefs(route, true)) {
        AddPublicRouteAlias(&catalog->services, ref, route);
      }
    }
  }
}

inline PublicInterfaceCatalog LoadPublicInterfaceCatalog(const std::string& config_path) {
  PublicInterfaceCatalog catalog;
  const auto workspace_root = ResolveWorkspaceRoot(config_path);
  if (workspace_root.empty()) {
    return catalog;
  }
  const auto idl_root = workspace_root / "pkg" / "idl";
  std::error_code error;
  if (!std::filesystem::is_directory(idl_root, error)) {
    return catalog;
  }
  for (const auto& entry : std::filesystem::recursive_directory_iterator(idl_root, error)) {
    if (error || !entry.is_regular_file()) {
      continue;
    }
    const auto path = entry.path();
    const auto parent = path.parent_path().filename().string();
    const auto extension = path.extension().string();
    if ((parent == "topics" || parent == "public") && (extension == ".yaml" || extension == ".yml")) {
      AddPublicManifestEntries(idl_root, path, &catalog);
    }
  }
  return catalog;
}

inline YAML::Node MergePublicInterfaceRefs(const YAML::Node& root, const std::string& config_path) {
  auto merged = YAML::Clone(root);
  auto communication = merged["communication"];
  if (!communication || !communication.IsMap()) {
    return merged;
  }
  const auto catalog = LoadPublicInterfaceCatalog(config_path);
  InjectOwnPublicInterfaceRoutes(
      &communication,
      catalog,
      FirstNonEmpty({Scalar(merged["service"], "name"), Scalar(merged["trace"], "service_name")}));
  if (communication["topics"] && communication["topics"].IsMap()) {
    for (const auto& item : communication["topics"]) {
      const auto name = item.first.as<std::string>();
      const auto route = item.second;
      const auto topic_ref = Scalar(route, "topic_ref");
      if (!topic_ref.empty() && catalog.topics.count(topic_ref) > 0) {
        communication["topics"][name] = MergePublicRoute(route, catalog.topics.at(topic_ref));
      }
    }
  }
  if (communication["services"] && communication["services"].IsMap()) {
    for (const auto& item : communication["services"]) {
      const auto name = item.first.as<std::string>();
      const auto route = item.second;
      const auto service_ref = Scalar(route, "service_ref");
      if (!service_ref.empty() && catalog.services.count(service_ref) > 0) {
        communication["services"][name] = MergePublicRoute(route, catalog.services.at(service_ref));
      }
    }
  }
  return merged;
}

inline void AddTopicRoute(
    ServiceCommunicationConfig* config,
    const std::string& service_name,
    const std::string& route_name,
    const YAML::Node& node,
    int index,
    bool expanded_binding) {
  const auto route_node = NormalizeTopicRouteNode(node);
  if (!Enabled(route_node)) {
    return;
  }
  const auto transport = RouteTransportFromString(Scalar(route_node, "transport"), "nats_topic");
  ValidateTopicCompatibility(route_name, route_node, transport);
  const auto address = ChannelAddress(route_node, transport, route_name, false);
  const auto binding = expanded_binding ? TopicBindingName(route_node, index) : "";
  auto metadata = Metadata(route_node, route_name, binding);
  const auto type = EndpointTypeFor(
      transport,
      metadata,
      {PayloadType(route_node), Scalar(route_node, "message_type"), Scalar(route_node, "msg_type")});
  const auto queue_size = route_node["queue_size"] ? route_node["queue_size"].as<int>() : 10;
  if (metadata.find("qos.depth") == metadata.end()) {
    metadata["qos.depth"] = std::to_string(queue_size);
  }
  Endpoint local{TransportKind::kInProcess, service_name, "", metadata};
  Endpoint channel = EndpointFromRoute(route_node, transport, address, type, metadata);
  const auto direction = Scalar(route_node, "direction");
  PubSubRoute route;
  route.name = expanded_binding ? route_name + "_" + RouteName(binding) : route_name;
  route.queue_size = queue_size;
  route.enabled = true;
  if (direction == "subscribe" || direction == "in") {
    route.publisher = local;
    route.subscriber = channel;
  } else {
    route.publisher = channel;
    route.subscriber = local;
  }
  config->pubsub_routes.push_back(route);
}

inline void AddServiceRoute(
    ServiceCommunicationConfig* config,
    const std::string& service_name,
    const std::string& route_name,
    const YAML::Node& node,
    int index,
    bool expanded_binding) {
  const auto route_node = NormalizeServiceRouteNode(node);
  if (!Enabled(route_node)) {
    return;
  }
  const auto transport = RouteTransportFromString(Scalar(route_node, "transport"), "nats_rpc");
  ValidateServiceCompatibility(route_name, route_node, transport);
  const auto address = ChannelAddress(route_node, transport, route_name, true);
  const auto binding = expanded_binding ? ServiceBindingName(route_node, index) : "";
  auto metadata = Metadata(route_node, route_name, binding);
  const auto type = EndpointTypeFor(
      transport,
      metadata,
      {ContractType(route_node), Scalar(route_node, "service_type"), Scalar(route_node, "message_type")});
  if (route_node["queue_group"]) {
    metadata["queue_group"] = route_node["queue_group"].as<std::string>();
  }
  if (route_node["direction"]) {
    metadata["direction"] = route_node["direction"].as<std::string>();
  }
  if (route_node["role"]) {
    metadata["role"] = route_node["role"].as<std::string>();
  }
  if ((transport == TransportKind::kCycloneDds || transport == TransportKind::kFastDds) &&
      IsNativeDdsRpcTransport(Scalar(route_node, "transport"))) {
    metadata["rpc.transport"] =
        transport == TransportKind::kFastDds ? "fastdds_rpc" : "cyclonedds_rpc";
    metadata["rpc.standard"] =
        transport == TransportKind::kFastDds ? "omg_dds_rpc" : DdsRpcStandard(Scalar(route_node, "standard"));
    const auto request = FirstNonEmpty({Scalar(route_node, "request"), Scalar(route_node, "request_channel")});
    const auto response = FirstNonEmpty({Scalar(route_node, "response"), Scalar(route_node, "response_channel")});
    if (!request.empty()) {
      metadata["rpc.request_channel"] = request;
    }
    if (!response.empty()) {
      metadata["rpc.response_channel"] = response;
    }
  }
  RpcRoute route;
  route.name = expanded_binding ? route_name + "_" + RouteName(binding) : route_name;
  route.client = Endpoint{transport, service_name, "", metadata};
  route.server = EndpointFromRoute(route_node, transport, address, type, metadata);
  route.timeout_ms = route_node["timeout_ms"] ? route_node["timeout_ms"].as<int>() : 2000;
  route.enabled = true;
  config->rpc_routes.push_back(route);
}

inline void ExpandRoutes(
    const YAML::Node& routes,
    const std::string& service_name,
    bool service_routes,
    ServiceCommunicationConfig* config) {
  if (!routes) {
    return;
  }
  for (const auto& item : routes) {
    const auto name = item.first.as<std::string>();
    const auto route = item.second;
    const auto middlewares = route["middlewares"];
    if (middlewares && middlewares.IsSequence()) {
      int index = 0;
      for (const auto& middleware : middlewares) {
        auto expanded = YAML::Clone(route);
        const auto middleware_name = middleware.as<std::string>();
        expanded["middleware"] = middleware_name;
        expanded.remove("middlewares");
        expanded.remove("bindings");
        expanded.remove("routes");
        const auto expanded_name = name + "_" + RouteName(middleware_name);
        if (service_routes) {
          AddServiceRoute(config, service_name, expanded_name, expanded, index++, false);
        } else {
          AddTopicRoute(config, service_name, expanded_name, expanded, index++, false);
        }
      }
      continue;
    }
    const auto bindings = route["bindings"] ? route["bindings"] : route["routes"];
    if (!bindings) {
      if (service_routes) {
        AddServiceRoute(config, service_name, name, route, 0, false);
      } else {
        AddTopicRoute(config, service_name, name, route, 0, false);
      }
      continue;
    }
    int index = 0;
    for (const auto& binding : bindings) {
      const auto merged = MergedNode(route, binding);
      if (service_routes) {
        AddServiceRoute(config, service_name, name, merged, index++, true);
      } else {
        AddTopicRoute(config, service_name, name, merged, index++, true);
      }
    }
  }
}

inline ServiceCommunicationConfig LoadServiceCommunicationConfig(
    const YAML::Node& root,
    const std::string& service_name) {
  ServiceCommunicationConfig config;
  config.trace_service_name = Scalar(root["trace"], "service_name");
  const auto communication = root["communication"];
  LoadSecurityProfiles(communication, &config);
  for (const auto& item : communication["middleware"]) {
    config.middleware[item.first.as<std::string>()] =
        MiddlewareFromNode(item.first.as<std::string>(), item.second);
  }
  AddReferencedDefaultMiddleware(communication["topics"], false, &config);
  AddReferencedDefaultMiddleware(communication["services"], true, &config);
  ExpandRoutes(communication["topics"], service_name, false, &config);
  ExpandRoutes(communication["services"], service_name, true, &config);
  return config;
}

}  // namespace pacific_rim::communication::core
