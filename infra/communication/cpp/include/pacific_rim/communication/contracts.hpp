#pragma once

#include <cstdint>
#include <map>
#include <string>

namespace pacific_rim::communication {

enum class TransportKind {
  kInProcess,
  kRos2,
  kNats,
  kCycloneDds,
  kFastDds,
  kZenoh,
  kGrpc,
  kMqtt,
};

enum class BridgeDirection {
  kSourceToTarget,
  kTargetToSource,
  kBidirectional,
};

struct Endpoint {
  TransportKind transport{TransportKind::kInProcess};
  std::string address;
  std::string message_type;
  std::map<std::string, std::string> metadata;
};

struct MiddlewareConfig {
  TransportKind transport{TransportKind::kInProcess};
  std::string name;
  std::map<std::string, std::string> options;
};

struct CommunicationMessage {
  std::string message_type;
  std::string payload_json;
  std::map<std::string, std::string> metadata;
};

struct MessageEnvelope {
  std::string source;
  CommunicationMessage message;
  std::string trace_id;
  std::string payload_sha256;
  std::int64_t published_at_unix_ms{0};
};

struct PubSubRoute {
  std::string name;
  Endpoint publisher;
  Endpoint subscriber;
  int queue_size{10};
  bool enabled{true};
};

struct RpcRoute {
  std::string name;
  Endpoint client;
  Endpoint server;
  int timeout_ms{2000};
  bool enabled{true};
};

struct BridgeRule {
  std::string name;
  Endpoint source;
  Endpoint target;
  BridgeDirection direction{BridgeDirection::kSourceToTarget};
  int queue_size{10};
  std::string queue_group;
  bool enabled{true};
};

}  // namespace pacific_rim::communication
