#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "pacific_rim/communication/contracts.hpp"

namespace pacific_rim::communication::core {

struct Channel {
  std::string name;
  std::string queue_group;
  std::string message_type;
  std::map<std::string, std::string> metadata;
};

struct Capabilities {
  bool publish_subscribe{true};
  bool request_reply{false};
};

using BusConfig = MiddlewareConfig;

using Bytes = std::vector<std::uint8_t>;
using BytesHandler = std::function<void(const Bytes&)>;
using RequestHandler = std::function<Bytes(const Bytes&)>;

class MessageBus {
 public:
  virtual ~MessageBus() = default;

  virtual TransportKind Kind() const = 0;
  virtual Capabilities GetCapabilities() const = 0;
  virtual bool Connect(const BusConfig& config) = 0;
  virtual void Close() = 0;
  virtual bool Publish(const Channel& channel, const Bytes& payload) = 0;
  virtual bool Subscribe(const Channel& channel, BytesHandler handler) = 0;
  virtual bool Request(
      const Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) = 0;
  virtual bool HandleRequest(const Channel& channel, RequestHandler handler) = 0;
};

using MessageBusFactory = std::function<std::unique_ptr<MessageBus>(const BusConfig&)>;

class MessageBusRegistry {
 public:
  static MessageBusRegistry& Instance() {
    static MessageBusRegistry registry;
    return registry;
  }

  void Register(TransportKind kind, MessageBusFactory factory) {
    factories_[kind] = std::move(factory);
  }

  std::unique_ptr<MessageBus> Create(const BusConfig& config) const {
    auto iter = factories_.find(config.transport);
    if (iter == factories_.end()) {
      return nullptr;
    }
    return iter->second(config);
  }

 private:
  std::map<TransportKind, MessageBusFactory> factories_;
};

inline Channel ChannelFromEndpoint(const Endpoint& endpoint) {
  Channel channel;
  channel.name = endpoint.address;
  channel.message_type = endpoint.message_type;
  channel.metadata = endpoint.metadata;
  const auto queue_group = endpoint.metadata.find("queue_group");
  if (queue_group != endpoint.metadata.end()) {
    channel.queue_group = queue_group->second;
  }
  return channel;
}

inline Channel RequestChannelFromRoute(const RpcRoute& route) {
  return ChannelFromEndpoint(route.server);
}

}  // namespace pacific_rim::communication::core
